(function () {
  const vscode = acquireVsCodeApi();
  const contentElement = document.getElementById("content");
  const titleElement = document.getElementById("docTitle");
  const metaElement = document.getElementById("docMeta");
  const tocList = document.getElementById("tocList");
  const tocSidebar = document.getElementById("tocSidebar");
  const tocToggle = document.getElementById("tocToggle");
  const shell = document.querySelector(".claude-shell");
  const body = document.body;

  if (!contentElement || !titleElement) {
    return;
  }

  // ── Persisted state ───────────────────────────────────────────────────────
  // Single source for all persisted UI state; we merge into it on each change.
  const state = vscode.getState() || {};
  let tocCollapsed = state.tocCollapsed === true;

  // Zoom: font-size-base in px, clamped 10–28, default 16.
  const ZOOM_MIN = 10;
  const ZOOM_MAX = 28;
  const ZOOM_DEFAULT = 16;
  const ZOOM_STEP = 1;
  let zoomPx = typeof state.zoomPx === "number" ? state.zoomPx : ZOOM_DEFAULT;

  // Width presets: label, css value
  const WIDTH_PRESETS = [
    { label: "Narrow", value: "680px" },
    { label: "Normal", value: "980px" },
    { label: "Wide", value: "1200px" },
    { label: "Full", value: "100%" }
  ];
  let widthIdx = typeof state.widthIdx === "number" ? state.widthIdx : 1; // default Normal

  function saveState(patch) {
    const next = Object.assign({}, vscode.getState() || {}, patch);
    vscode.setState(next);
  }

  // ── Apply zoom ────────────────────────────────────────────────────────────
  function applyZoom() {
    document.documentElement.style.setProperty("--font-size-base", zoomPx + "px");
    const zoomResetBtn = document.getElementById("zoomReset");
    const zoomInBtn = document.getElementById("zoomIn");
    const zoomOutBtn = document.getElementById("zoomOut");
    if (zoomResetBtn) {
      zoomResetBtn.textContent = zoomPx + "px";
      zoomResetBtn.classList.toggle("ctrl-btn--active", zoomPx !== ZOOM_DEFAULT);
    }
    if (zoomInBtn) {
      zoomInBtn.disabled = zoomPx >= ZOOM_MAX;
    }
    if (zoomOutBtn) {
      zoomOutBtn.disabled = zoomPx <= ZOOM_MIN;
    }
  }

  function zoomIn() {
    zoomPx = Math.min(ZOOM_MAX, zoomPx + ZOOM_STEP);
    saveState({ zoomPx });
    applyZoom();
  }

  function zoomOut() {
    zoomPx = Math.max(ZOOM_MIN, zoomPx - ZOOM_STEP);
    saveState({ zoomPx });
    applyZoom();
  }

  function zoomReset() {
    zoomPx = ZOOM_DEFAULT;
    saveState({ zoomPx });
    applyZoom();
  }

  // ── Apply width ───────────────────────────────────────────────────────────
  function applyWidth() {
    const preset = WIDTH_PRESETS[widthIdx] || WIDTH_PRESETS[1];
    document.documentElement.style.setProperty("--content-max-width", preset.value);
    const widthBtn = document.getElementById("widthCycle");
    if (widthBtn) {
      widthBtn.textContent = preset.label;
      widthBtn.classList.toggle("ctrl-btn--active", widthIdx !== 1);
    }
  }

  function cycleWidth() {
    widthIdx = (widthIdx + 1) % WIDTH_PRESETS.length;
    saveState({ widthIdx });
    applyWidth();
  }

  // ── TOC state persisted via vscode state ──────────────────────────────────

  function applyCollapsedState() {
    if (!shell || !tocToggle) {
      return;
    }
    if (tocCollapsed) {
      shell.classList.add("claude-shell--toc-collapsed");
      shell.classList.remove("claude-shell--toc-open");
      tocToggle.setAttribute("aria-expanded", "false");
    } else {
      shell.classList.remove("claude-shell--toc-collapsed");
      shell.classList.add("claude-shell--toc-open");
      tocToggle.setAttribute("aria-expanded", "true");
    }
  }

  // Apply persisted state immediately (before first render)
  applyCollapsedState();

  if (tocToggle) {
    tocToggle.addEventListener("click", () => {
      tocCollapsed = !tocCollapsed;
      saveState({ tocCollapsed });
      applyCollapsedState();
    });
  }

  // ── Scrollspy ─────────────────────────────────────────────────────────────
  /** @type {IntersectionObserver|null} */
  let headingObserver = null;

  /** @type {Map<Element, Element>} heading element → TOC anchor element */
  let headingToTocEntry = new Map();

  /** @type {Element|null} */
  let activeEntry = null;

  function setActiveEntry(tocEntry) {
    if (activeEntry === tocEntry) {
      return;
    }
    if (activeEntry) {
      activeEntry.classList.remove("toc-active");
    }
    activeEntry = tocEntry;
    if (activeEntry) {
      activeEntry.classList.add("toc-active");
    }
  }

  function buildScrollspy(headings) {
    if (headingObserver) {
      headingObserver.disconnect();
      headingObserver = null;
    }
    headingToTocEntry = new Map();
    activeEntry = null;

    if (!headings.length) {
      return;
    }

    // Track which headings are currently intersecting, pick the topmost one.
    const intersecting = new Set();

    headingObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            intersecting.add(entry.target);
          } else {
            intersecting.delete(entry.target);
          }
        }

        // Find the topmost intersecting heading (earliest in DOM order).
        let topmost = null;
        let topmostTop = Infinity;
        for (const heading of intersecting) {
          const rect = heading.getBoundingClientRect();
          if (rect.top < topmostTop) {
            topmostTop = rect.top;
            topmost = heading;
          }
        }

        if (topmost) {
          const tocEntry = headingToTocEntry.get(topmost);
          if (tocEntry) {
            setActiveEntry(tocEntry);
          }
        }
      },
      { rootMargin: "0px 0px -60% 0px", threshold: 0 }
    );

    for (const heading of headings) {
      headingObserver.observe(heading);
    }
  }

  // ── TOC builder ───────────────────────────────────────────────────────────
  function buildToc() {
    if (!tocList || !tocSidebar) {
      return;
    }

    // Reset
    tocList.innerHTML = "";
    headingToTocEntry = new Map();
    activeEntry = null;

    const headings = Array.from(contentElement.querySelectorAll("h1,h2,h3,h4,h5,h6"));

    if (!headings.length) {
      tocSidebar.style.display = "none";
      return;
    }

    // Restore sidebar visibility (CSS class controls it, not inline style).
    tocSidebar.style.display = "";

    headings.forEach((heading, index) => {
      // Use the heading's existing id (set by the renderer's heading_anchors rule)
      // and only fall back to md-h-<index> when none is present.
      const headingId = heading.id || `md-h-${index}`;
      if (!heading.id) {
        heading.id = headingId;
      }

      const tagName = heading.tagName.toLowerCase(); // h1..h6
      const level = parseInt(tagName.slice(1), 10); // 1..6
      // Use textContent but strip the anchor "#" character injected by heading-anchor
      const text = (heading.textContent || "").replace(/#\s*$/, "").trim();

      const li = document.createElement("li");
      const a = document.createElement("a");

      a.href = `#${headingId}`;
      a.textContent = text;
      a.setAttribute("data-level", String(level));

      a.addEventListener("click", (event) => {
        event.preventDefault();
        heading.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveEntry(a);
      });

      headingToTocEntry.set(heading, a);

      li.appendChild(a);
      tocList.appendChild(li);
    });

    buildScrollspy(headings);
  }

  // ── Theme ─────────────────────────────────────────────────────────────────
  function applyTheme(theme, themeStyle) {
    body.classList.remove("theme-light", "theme-dark");
    body.classList.add(theme === "dark" ? "theme-dark" : "theme-light");

    body.classList.remove("theme-style-claude", "theme-style-github");
    body.classList.add(themeStyle === "github" ? "theme-style-github" : "theme-style-claude");

    // Reflect current style on the theme toggle button if present.
    const themeBtn = document.getElementById("themeStyleBtn");
    if (themeBtn) {
      themeBtn.textContent = themeStyle === "github" ? "GH" : "CL";
      themeBtn.title = themeStyle === "github" ? "Theme: GitHub (click to switch)" : "Theme: Claude (click to switch)";
      themeBtn.classList.toggle("ctrl-btn--active", themeStyle === "github");
    }
  }

  // ── Mermaid ───────────────────────────────────────────────────────────────
  async function renderMermaid() {
    if (typeof window.mermaid === "undefined") {
      return;
    }

    const nodes = contentElement.querySelectorAll(".mermaid");
    if (!nodes.length) {
      return;
    }

    try {
      if (!window.__claudePreviewMermaidInit) {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral"
        });
        window.__claudePreviewMermaidInit = true;
      }

      await window.mermaid.run({ nodes });
    } catch (error) {
      console.error("[markdown-studio] Mermaid rendering failed:", error);
    }
  }

  // ── Content click handler (copy + links) ─────────────────────────────────
  contentElement.addEventListener("click", (event) => {
    const rawTarget = event.target;
    if (!(rawTarget instanceof Element)) {
      return;
    }

    // --- Copy button handler ---
    const copyBtn = rawTarget.closest(".code-copy-btn");
    if (copyBtn) {
      event.preventDefault();
      event.stopPropagation();

      // Navigate up: .code-copy-btn is inside .code-block-toolbar, sibling to <code>
      // Structure: <pre.code-block> > .code-block-toolbar + <code> (or > .code-block-body > <code>)
      const pre = copyBtn.closest("pre.code-block");
      if (!pre) {
        return;
      }

      const codeEl = pre.querySelector("code");
      if (!codeEl) {
        return;
      }

      const text = codeEl.textContent || "";

      function showCopied() {
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 1500);
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showCopied).catch(() => {
          fallbackCopy(text);
          showCopied();
        });
      } else {
        fallbackCopy(text);
        showCopied();
      }

      return;
    }

    // --- Link handler ---
    const link = rawTarget.closest("a[href]");
    if (!link) {
      return;
    }

    const href = link.getAttribute("href") || "";
    if (!href || href.startsWith("#")) {
      return;
    }

    event.preventDefault();

    const sourceDoc = link.getAttribute("data-source-doc") || "";
    const originalHref = link.getAttribute("data-original-href") || href;
    vscode.postMessage({
      type: "openLink",
      href: originalHref,
      sourceDoc
    });
  });

  // ── Double-click on data-line element → jump to source ───────────────────
  contentElement.addEventListener("dblclick", (event) => {
    const rawTarget = event.target;
    if (!(rawTarget instanceof Element)) {
      return;
    }

    // Walk up to find the nearest ancestor (or self) that has data-line.
    const lineEl = rawTarget.closest("[data-line]");
    if (!lineEl) {
      return;
    }

    const lineAttr = lineEl.getAttribute("data-line");
    if (lineAttr === null) {
      return;
    }

    const line = parseInt(lineAttr, 10);
    if (isNaN(line)) {
      return;
    }

    vscode.postMessage({ type: "editorRevealLine", line, focus: true });
  });

  function fallbackCopy(text) {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.top = "0";
      textarea.style.left = "0";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    } catch (_) {
      // Clipboard unavailable — silently ignore.
    }
  }

  // ── revealLine helper ─────────────────────────────────────────────────────
  // Timestamp until which outgoing scroll events are suppressed (feedback-loop guard).
  let suppressScrollUntil = 0;

  function revealLine(line) {
    // Suppress outgoing scroll for 250ms so we don't echo back to the editor.
    suppressScrollUntil = Date.now() + 250;

    const elements = Array.from(contentElement.querySelectorAll("[data-line]"));
    if (!elements.length) {
      return;
    }

    // Find the element whose data-line is the greatest value <= line.
    let best = null;
    let bestLine = -1;
    for (const el of elements) {
      const elLine = parseInt(el.getAttribute("data-line"), 10);
      if (isNaN(elLine)) {
        continue;
      }
      if (elLine <= line && elLine > bestLine) {
        bestLine = elLine;
        best = el;
      }
    }

    // Fall back to the first element if none matched.
    const target = best || elements[0];
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── Preview → editor scroll sync ─────────────────────────────────────────
  let scrollSyncTimer = null;

  window.addEventListener("scroll", () => {
    if (Date.now() < suppressScrollUntil) {
      return;
    }

    if (scrollSyncTimer !== null) {
      clearTimeout(scrollSyncTimer);
    }

    scrollSyncTimer = setTimeout(() => {
      scrollSyncTimer = null;

      // Find the topmost [data-line] element at or above the viewport top.
      const elements = Array.from(contentElement.querySelectorAll("[data-line]"));
      if (!elements.length) {
        return;
      }

      const viewportTop = window.scrollY;
      let best = null;
      let bestLine = -1;

      for (const el of elements) {
        const elTop = el.getBoundingClientRect().top + window.scrollY;
        if (elTop <= viewportTop + 4) {
          const elLine = parseInt(el.getAttribute("data-line"), 10);
          if (!isNaN(elLine) && elLine > bestLine) {
            bestLine = elLine;
            best = el;
          }
        }
      }

      if (best !== null) {
        vscode.postMessage({ type: "editorRevealLine", line: bestLine });
      }
    }, 80);
  }, { passive: true });

  // ── Find-in-preview ───────────────────────────────────────────────────────

  // Build the find bar DOM once.
  const findBar = document.createElement("div");
  findBar.className = "find-bar";
  findBar.setAttribute("aria-label", "Find in preview");
  findBar.setAttribute("role", "search");
  findBar.innerHTML = [
    '<input class="find-bar__input" type="text" placeholder="Find…" aria-label="Search text">',
    '<span class="find-bar__count" aria-live="polite"></span>',
    '<button class="find-bar__btn" id="findPrev" title="Previous match (Shift+Enter)" aria-label="Previous match">&#8593;</button>',
    '<button class="find-bar__btn" id="findNext" title="Next match (Enter)" aria-label="Next match">&#8595;</button>',
    '<button class="find-bar__btn find-bar__close" id="findClose" title="Close (Esc)" aria-label="Close find bar">&times;</button>'
  ].join("");
  document.body.appendChild(findBar);

  const findInput = findBar.querySelector(".find-bar__input");
  const findCount = findBar.querySelector(".find-bar__count");
  const findPrevBtn = findBar.querySelector("#findPrev");
  const findNextBtn = findBar.querySelector("#findNext");
  const findCloseBtn = findBar.querySelector("#findClose");

  let findHits = [];      // Array of <mark> elements in DOM order
  let findActiveIdx = -1; // Index into findHits of the currently highlighted hit

  /** Remove all injected <mark class="find-hit"> elements from the DOM. */
  function clearFindHighlights() {
    // Use querySelectorAll so we catch any that remain after a render.
    const marks = Array.from(document.querySelectorAll("mark.find-hit"));
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) {
        continue;
      }
      // Replace the mark with its text content.
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      parent.normalize();
    }
    findHits = [];
    findActiveIdx = -1;
    findCount.textContent = "";
  }

  /** Walk text nodes under root and wrap matches with <mark class="find-hit">. */
  function applyFindHighlights(query) {
    if (!query) {
      return;
    }

    const lowerQuery = query.toLowerCase();

    // Collect all text nodes inside #content (skip script/style).
    const walker = document.createTreeWalker(
      contentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentNode;
          if (!parent) {
            return NodeFilter.FILTER_REJECT;
          }
          const tag = parent.nodeName.toLowerCase();
          if (tag === "script" || tag === "style") {
            return NodeFilter.FILTER_REJECT;
          }
          // Don't inject into the find bar itself (it's outside #content, but belt+suspenders).
          if (parent.closest && parent.closest(".find-bar")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    // Collect nodes first (can't modify DOM while walking).
    const textNodes = [];
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node);
      node = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const text = textNode.nodeValue || "";
      const lowerText = text.toLowerCase();
      let searchFrom = 0;
      const fragments = [];
      let didMatch = false;

      while (true) {
        const idx = lowerText.indexOf(lowerQuery, searchFrom);
        if (idx === -1) {
          break;
        }
        didMatch = true;
        if (idx > searchFrom) {
          fragments.push(document.createTextNode(text.slice(searchFrom, idx)));
        }
        const mark = document.createElement("mark");
        mark.className = "find-hit";
        mark.textContent = text.slice(idx, idx + query.length);
        fragments.push(mark);
        findHits.push(mark);
        searchFrom = idx + query.length;
      }

      if (!didMatch) {
        continue;
      }

      // Append any trailing text.
      if (searchFrom < text.length) {
        fragments.push(document.createTextNode(text.slice(searchFrom)));
      }

      // Replace the text node with the fragments.
      const parent = textNode.parentNode;
      if (!parent) {
        continue;
      }
      for (const frag of fragments) {
        parent.insertBefore(frag, textNode);
      }
      parent.removeChild(textNode);
    }
  }

  function setFindActive(idx) {
    if (findActiveIdx >= 0 && findActiveIdx < findHits.length) {
      findHits[findActiveIdx].classList.remove("find-hit--active");
    }
    findActiveIdx = idx;
    if (findActiveIdx >= 0 && findActiveIdx < findHits.length) {
      const activeEl = findHits[findActiveIdx];
      activeEl.classList.add("find-hit--active");
      activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    updateFindCount();
  }

  function updateFindCount() {
    if (!findHits.length) {
      findCount.textContent = findInput.value ? "No results" : "";
    } else {
      findCount.textContent = `${findActiveIdx + 1} / ${findHits.length}`;
    }
  }

  function runFind() {
    clearFindHighlights();
    const query = (findInput.value || "").trim();
    if (!query) {
      return;
    }
    applyFindHighlights(query);
    if (findHits.length > 0) {
      setFindActive(0);
    } else {
      updateFindCount();
    }
  }

  function findNext() {
    if (!findHits.length) {
      return;
    }
    setFindActive((findActiveIdx + 1) % findHits.length);
  }

  function findPrev() {
    if (!findHits.length) {
      return;
    }
    setFindActive((findActiveIdx - 1 + findHits.length) % findHits.length);
  }

  function openFindBar() {
    findBar.classList.add("find-bar--visible");
    findInput.focus();
    findInput.select();
  }

  function closeFindBar() {
    findBar.classList.remove("find-bar--visible");
    clearFindHighlights();
    findInput.value = "";
  }

  // Keyboard: Ctrl+F opens the find bar; Ctrl+=/+/-/0 zoom.
  window.addEventListener("keydown", (event) => {
    if (event.key === "f" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      openFindBar();
      return;
    }

    // Zoom shortcuts (work regardless of find bar state)
    if (event.ctrlKey || event.metaKey) {
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        zoomIn();
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        zoomOut();
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        zoomReset();
        return;
      }
    }

    // Only handle the following keys when the find bar is open.
    if (!findBar.classList.contains("find-bar--visible")) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeFindBar();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        findPrev();
      } else {
        findNext();
      }
    }
  });

  findInput.addEventListener("input", () => {
    runFind();
  });

  findNextBtn.addEventListener("click", findNext);
  findPrevBtn.addEventListener("click", findPrev);
  findCloseBtn.addEventListener("click", closeFindBar);

  // ── Wire up header control buttons ───────────────────────────────────────
  // Buttons are rendered in the HTML shell; we bind events here after DOM ready.
  (function wireHeaderButtons() {
    const zoomOutBtn = document.getElementById("zoomOut");
    const zoomResetBtn = document.getElementById("zoomReset");
    const zoomInBtn = document.getElementById("zoomIn");
    const widthBtn = document.getElementById("widthCycle");
    // themeStyleBtn is read-only display; theme change requires config change via VS Code.
    // We deliberately don't toggle it from JS since the source of truth is VS Code settings.

    if (zoomOutBtn) { zoomOutBtn.addEventListener("click", zoomOut); }
    if (zoomResetBtn) { zoomResetBtn.addEventListener("click", zoomReset); }
    if (zoomInBtn) { zoomInBtn.addEventListener("click", zoomIn); }
    if (widthBtn) { widthBtn.addEventListener("click", cycleWidth); }
  })();

  // Apply persisted zoom and width on load (before first render).
  applyZoom();
  applyWidth();

  // ── Message handler ───────────────────────────────────────────────────────
  window.addEventListener("message", (event) => {
    const message = event.data;

    if (!message) {
      return;
    }

    if (message.type === "revealLine") {
      revealLine(message.line);
      return;
    }

    if (message.type === "print") {
      window.print();
      return;
    }

    if (message.type !== "render") {
      return;
    }

    // CRITICAL: clear find highlights BEFORE replacing innerHTML to avoid
    // corrupted DOM state (unwrap cannot find orphaned marks after innerHTML replacement).
    clearFindHighlights();

    titleElement.textContent = message.title || "markdown-studio";

    if (metaElement) {
      if (message.wordCount != null && message.readingTimeMin != null) {
        const wordStr = message.wordCount.toLocaleString();
        metaElement.textContent = `${wordStr} words · ${message.readingTimeMin} min read`;
      } else {
        metaElement.textContent = "";
      }
    }

    applyTheme(message.theme, message.themeStyle);
    // Re-apply zoom and width after each render (body class changes don't affect
    // inline custom properties we set on :root, but call to keep display in sync).
    applyZoom();
    applyWidth();

    contentElement.innerHTML = message.html || "";

    buildToc();
    void renderMermaid();

    // Re-run find if the bar is open.
    if (findBar.classList.contains("find-bar--visible") && findInput.value.trim()) {
      runFind();
    }
  });

  // ── Lightbox ──────────────────────────────────────────────────────────────
  // Build the lightbox DOM once; reuse it for every image/SVG opened.

  const lightboxOverlay = document.createElement("div");
  lightboxOverlay.className = "lightbox-overlay";
  lightboxOverlay.setAttribute("role", "dialog");
  lightboxOverlay.setAttribute("aria-modal", "true");
  lightboxOverlay.setAttribute("aria-label", "Image lightbox");

  // Stage: holds the cloned image/SVG; pan+zoom applied here as a CSS transform.
  const lightboxStage = document.createElement("div");
  lightboxStage.className = "lightbox-stage";

  // Controls bar (close, zoom-out, reset, zoom-in)
  const lightboxControls = document.createElement("div");
  lightboxControls.className = "lightbox-controls";
  lightboxControls.innerHTML = [
    '<button class="lightbox-btn" id="lbZoomOut" title="Zoom out" aria-label="Zoom out">&#8722;</button>',
    '<button class="lightbox-btn" id="lbZoomReset" title="Reset zoom" aria-label="Reset zoom">1:1</button>',
    '<button class="lightbox-btn" id="lbZoomIn" title="Zoom in" aria-label="Zoom in">&#43;</button>',
    '<button class="lightbox-btn" id="lbClose" title="Close (Esc)" aria-label="Close lightbox">&times;</button>'
  ].join("");

  lightboxOverlay.appendChild(lightboxStage);
  lightboxOverlay.appendChild(lightboxControls);
  document.body.appendChild(lightboxOverlay);

  // Lightbox state
  let lbScale = 1;
  let lbTranslateX = 0;
  let lbTranslateY = 0;
  let lbIsDragging = false;
  let lbDragStartX = 0;
  let lbDragStartY = 0;
  let lbDragOriginX = 0;
  let lbDragOriginY = 0;

  function lbApplyTransform() {
    // Apply transform to the stage's single child (the cloned img/svg).
    const child = lightboxStage.firstElementChild;
    if (child) {
      child.style.transform = `translate(${lbTranslateX}px, ${lbTranslateY}px) scale(${lbScale})`;
      child.style.transformOrigin = "0 0";
    }
  }

  function lbOpen(sourceEl) {
    // Reset state
    lbScale = 1;
    lbTranslateX = 0;
    lbTranslateY = 0;
    lbIsDragging = false;

    // Clear previous content
    lightboxStage.innerHTML = "";

    // Clone the element into the stage
    let clone;
    if (sourceEl.tagName && sourceEl.tagName.toLowerCase() === "img") {
      clone = document.createElement("img");
      clone.src = sourceEl.src;
      clone.alt = sourceEl.alt || "";
    } else {
      // SVG or mermaid container — clone its outerHTML as SVG
      const svg = sourceEl.tagName && sourceEl.tagName.toLowerCase() === "svg"
        ? sourceEl
        : sourceEl.querySelector("svg");
      if (svg) {
        clone = svg.cloneNode(true);
        // Remove fixed width/height so it renders at natural/viewport size
        clone.removeAttribute("width");
        clone.removeAttribute("height");
        clone.style.width = "";
        clone.style.height = "";
        clone.style.maxWidth = "90vw";
        clone.style.maxHeight = "90vh";
      } else {
        return; // nothing useful to show
      }
    }

    // Center the clone by centering in viewport (flex center on stage, then translate starts at 0)
    clone.style.transform = "translate(0,0) scale(1)";
    clone.style.transformOrigin = "0 0";
    // After appending, compute natural size and offset to center it
    lightboxStage.appendChild(clone);
    lightboxOverlay.classList.add("lightbox-overlay--open");

    // Center: after first paint, offset the clone so it starts centered.
    requestAnimationFrame(() => {
      const rect = clone.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      lbTranslateX = (vw - rect.width) / 2 - rect.left + lbTranslateX;
      lbTranslateY = (vh - rect.height) / 2 - rect.top + lbTranslateY;
      lbApplyTransform();
    });
  }

  function lbClose() {
    lightboxOverlay.classList.remove("lightbox-overlay--open");
    lightboxStage.innerHTML = "";
    lbIsDragging = false;
  }

  function lbZoomBy(factor, pivotX, pivotY) {
    // Clamp scale between 0.1 and 20
    const newScale = Math.min(20, Math.max(0.1, lbScale * factor));
    const effectiveFactor = newScale / lbScale;

    // Adjust translation so the point under the cursor stays fixed
    lbTranslateX = pivotX - effectiveFactor * (pivotX - lbTranslateX);
    lbTranslateY = pivotY - effectiveFactor * (pivotY - lbTranslateY);
    lbScale = newScale;
    lbApplyTransform();
  }

  function lbZoomReset() {
    lbScale = 1;
    lbTranslateX = 0;
    lbTranslateY = 0;
    // Re-center
    const child = lightboxStage.firstElementChild;
    if (child) {
      child.style.transform = "translate(0,0) scale(1)";
      requestAnimationFrame(() => {
        const rect = child.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        lbTranslateX = (vw - rect.width) / 2 - rect.left;
        lbTranslateY = (vh - rect.height) / 2 - rect.top;
        lbApplyTransform();
      });
    }
  }

  // Lightbox control button events
  document.getElementById("lbClose").addEventListener("click", lbClose);
  document.getElementById("lbZoomIn").addEventListener("click", () => {
    lbZoomBy(1.25, window.innerWidth / 2, window.innerHeight / 2);
  });
  document.getElementById("lbZoomOut").addEventListener("click", () => {
    lbZoomBy(1 / 1.25, window.innerWidth / 2, window.innerHeight / 2);
  });
  document.getElementById("lbZoomReset").addEventListener("click", lbZoomReset);

  // Click on backdrop (not on controls or stage content) closes the lightbox
  lightboxOverlay.addEventListener("click", (event) => {
    if (event.target === lightboxOverlay || event.target === lightboxStage) {
      lbClose();
    }
  });

  // Mouse-wheel zoom (toward cursor position)
  lightboxOverlay.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    lbZoomBy(factor, event.clientX, event.clientY);
  }, { passive: false });

  // Drag to pan
  lightboxOverlay.addEventListener("mousedown", (event) => {
    // Only drag on the stage/content, not on control buttons
    if (event.target.closest(".lightbox-controls")) {
      return;
    }
    event.preventDefault();
    lbIsDragging = true;
    lbDragStartX = event.clientX;
    lbDragStartY = event.clientY;
    lbDragOriginX = lbTranslateX;
    lbDragOriginY = lbTranslateY;
    lightboxOverlay.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (event) => {
    if (!lbIsDragging) {
      return;
    }
    lbTranslateX = lbDragOriginX + (event.clientX - lbDragStartX);
    lbTranslateY = lbDragOriginY + (event.clientY - lbDragStartY);
    lbApplyTransform();
  });

  window.addEventListener("mouseup", () => {
    if (lbIsDragging) {
      lbIsDragging = false;
      lightboxOverlay.style.cursor = "";
    }
  });

  // Esc key closes the lightbox (added to the existing keydown listener via a separate handler)
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && lightboxOverlay.classList.contains("lightbox-overlay--open")) {
      event.preventDefault();
      lbClose();
    }
  });

  // Click delegation on #content to open the lightbox.
  // Uses a capture-phase listener so we can intercept before the bubble-phase link handler,
  // and guard carefully to avoid clashing with existing click handling.
  contentElement.addEventListener("click", (event) => {
    const rawTarget = event.target;
    if (!(rawTarget instanceof Element)) {
      return;
    }

    // Never trigger lightbox when clicking a copy button or inside a link.
    if (rawTarget.closest(".code-copy-btn") || rawTarget.closest("a[href]")) {
      return;
    }

    // Case 1: clicking an <img> that is NOT wrapped in an <a>
    const img = rawTarget.closest("img");
    if (img && !img.closest("a[href]")) {
      event.preventDefault();
      event.stopPropagation();
      lbOpen(img);
      return;
    }

    // Case 2: clicking a Mermaid diagram container or its SVG child,
    //         or a PlantUML <img class="plantuml-diagram">
    const plantumlImg = rawTarget.closest("img.plantuml-diagram");
    if (plantumlImg && !plantumlImg.closest("a[href]")) {
      event.preventDefault();
      event.stopPropagation();
      lbOpen(plantumlImg);
      return;
    }

    const mermaidContainer = rawTarget.closest(".mermaid");
    if (mermaidContainer) {
      event.preventDefault();
      event.stopPropagation();
      lbOpen(mermaidContainer);
      return;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
