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

  // ── Motion preference ───────────────────────────────────────────────────────
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function smoothBehavior() {
    return prefersReducedMotion() ? "auto" : "smooth";
  }

  // ── Render / Mermaid caches (survive re-renders) ────────────────────────────
  // Skip the whole rebuild when the rendered HTML is byte-identical.
  let lastRenderedHtml = null;
  // diagram cache-key → rendered <svg> innerHTML, so unchanged diagrams are not
  // re-run by Mermaid (eliminates flicker + cost while typing).
  const mermaidCache = new Map();
  // diagram cache-key → { scale, tx, ty } so pan/zoom survives a re-render.
  const mermaidViewState = new Map();
  let lastMermaidTheme = null;

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
        heading.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
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
  // Render only diagrams whose source (+theme) isn't already cached. Cached
  // diagrams get their previously-rendered SVG injected directly — no re-run,
  // no flicker. Each node is tagged with data-cache-key for pan/zoom restore.
  async function renderMermaid(theme) {
    if (typeof window.mermaid === "undefined") {
      return;
    }

    const nodes = Array.from(contentElement.querySelectorAll(".mermaid"));
    if (!nodes.length) {
      return;
    }

    const themeKey = theme === "dark" ? "dark" : "neutral";
    const toRender = [];
    const liveKeys = new Set();

    for (const node of nodes) {
      const src = node.getAttribute("data-mermaid-src") || node.textContent || "";
      const cacheKey = themeKey + " " + src;
      node.setAttribute("data-mermaid-src", src);
      node.setAttribute("data-cache-key", cacheKey);
      liveKeys.add(cacheKey);

      const cached = mermaidCache.get(cacheKey);
      if (cached) {
        node.innerHTML = cached;
        node.setAttribute("data-processed", "true");
      } else {
        toRender.push(node);
      }
    }

    // Prune caches down to diagrams present in the current document. Without
    // this, editing a diagram (a new source per keystroke) would grow the
    // caches without bound.
    for (const key of Array.from(mermaidCache.keys())) {
      if (!liveKeys.has(key)) {
        mermaidCache.delete(key);
      }
    }
    for (const key of Array.from(mermaidViewState.keys())) {
      if (!liveKeys.has(key)) {
        mermaidViewState.delete(key);
      }
    }

    if (!toRender.length) {
      return;
    }

    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: themeKey
      });

      await window.mermaid.run({ nodes: toRender });

      for (const node of toRender) {
        const key = node.getAttribute("data-cache-key");
        if (key) {
          mermaidCache.set(key, node.innerHTML);
        }
      }
    } catch (error) {
      console.error("[markdown-studio] Mermaid rendering failed:", error);
    }
  }

  // ── Inline Mermaid pan/zoom ─────────────────────────────────────────────────
  // Pointer Events unify mouse, trackpad, pen and touch; two pointers = pinch.
  function setupMermaidPanZoom() {
    contentElement.querySelectorAll(".mermaid").forEach((canvas) => {
      if (canvas.parentElement && canvas.parentElement.classList.contains("mermaid-viewport")) {
        return;
      }

      const viewport = document.createElement("div");
      viewport.className = "mermaid-viewport";
      viewport.title = "Ctrl/⌘ + scroll to zoom · drag to pan";
      canvas.parentNode.insertBefore(viewport, canvas);
      viewport.appendChild(canvas);

      canvas.style.transformOrigin = "0 0";
      canvas.style.display = "inline-block";
      canvas.style.userSelect = "none";

      const cacheKey = canvas.getAttribute("data-cache-key") || "";
      const saved = mermaidViewState.get(cacheKey);
      const state = saved
        ? { scale: saved.scale, tx: saved.tx, ty: saved.ty }
        : { scale: 1, tx: 0, ty: 0 };

      function applyTransform() {
        canvas.style.transform =
          "translate(" + state.tx + "px, " + state.ty + "px) scale(" + state.scale + ")";
        if (cacheKey) {
          mermaidViewState.set(cacheKey, { scale: state.scale, tx: state.tx, ty: state.ty });
        }
      }

      function zoomAround(px, py, factor) {
        const newScale = Math.max(0.1, Math.min(20, state.scale * factor));
        state.tx = px - (px - state.tx) * (newScale / state.scale);
        state.ty = py - (py - state.ty) * (newScale / state.scale);
        state.scale = newScale;
        applyTransform();
      }

      // Fit the diagram to the viewport width and center it (premium first view).
      function fitAndCenter() {
        state.scale = 1;
        state.tx = 0;
        state.ty = 0;
        applyTransform();
        requestAnimationFrame(() => {
          const svg = canvas.querySelector("svg");
          const target = svg || canvas;
          const cw = target.getBoundingClientRect().width;
          const ch = target.getBoundingClientRect().height;
          const vw = viewport.clientWidth;
          const vh = viewport.clientHeight;
          const pad = 16;
          let scale = 1;
          if (cw > vw - pad * 2) {
            scale = Math.max(0.1, (vw - pad * 2) / cw);
          }
          state.scale = scale;
          state.tx = Math.max(pad, (vw - cw * scale) / 2);
          state.ty = Math.max(pad, (vh - ch * scale) / 2);
          applyTransform();
        });
      }

      // Wheel: only zoom with a modifier so a plain wheel scrolls the page.
      viewport.addEventListener("wheel", (e) => {
        if (!(e.ctrlKey || e.metaKey)) {
          return;
        }
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        zoomAround(e.clientX - rect.left, e.clientY - rect.top, factor);
      }, { passive: false });

      // Pointer-based pan + pinch.
      const pointers = new Map();
      let panStart = null;
      let pinchStartDist = 0;
      let pinchStartScale = 1;
      let pinchCenter = null;

      viewport.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".mermaid-controls")) {
          return;
        }
        e.preventDefault();
        viewport.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 1) {
          panStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
          viewport.style.cursor = "grabbing";
        } else if (pointers.size === 2) {
          const pts = Array.from(pointers.values());
          const rect = viewport.getBoundingClientRect();
          pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
          pinchStartScale = state.scale;
          pinchCenter = {
            x: (pts[0].x + pts[1].x) / 2 - rect.left,
            y: (pts[0].y + pts[1].y) / 2 - rect.top,
            tx: state.tx,
            ty: state.ty
          };
          panStart = null;
        }
      });

      viewport.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) {
          return;
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 1 && panStart) {
          state.tx = panStart.tx + (e.clientX - panStart.x);
          state.ty = panStart.ty + (e.clientY - panStart.y);
          applyTransform();
        } else if (pointers.size === 2 && pinchCenter) {
          const pts = Array.from(pointers.values());
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          const newScale = Math.max(0.1, Math.min(20, pinchStartScale * (dist / pinchStartDist)));
          state.tx = pinchCenter.x - (pinchCenter.x - pinchCenter.tx) * (newScale / pinchStartScale);
          state.ty = pinchCenter.y - (pinchCenter.y - pinchCenter.ty) * (newScale / pinchStartScale);
          state.scale = newScale;
          applyTransform();
        }
      });

      function endPointer(e) {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) {
          pinchCenter = null;
        }
        if (pointers.size === 1) {
          const p = Array.from(pointers.values())[0];
          panStart = { x: p.x, y: p.y, tx: state.tx, ty: state.ty };
        } else if (pointers.size === 0) {
          panStart = null;
          viewport.style.cursor = "grab";
        }
      }

      viewport.addEventListener("pointerup", endPointer);
      viewport.addEventListener("pointercancel", endPointer);

      const controls = document.createElement("div");
      controls.className = "mermaid-controls";
      controls.innerHTML =
        "<button class=\"mermaid-ctrl-btn\" data-action=\"zoom-in\" title=\"Zoom in\" aria-label=\"Zoom in\">+</button>" +
        "<button class=\"mermaid-ctrl-btn\" data-action=\"zoom-out\" title=\"Zoom out\" aria-label=\"Zoom out\">−</button>" +
        "<button class=\"mermaid-ctrl-btn\" data-action=\"reset\" title=\"Fit to view\" aria-label=\"Fit to view\">↺ Fit</button>";
      viewport.appendChild(controls);

      controls.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const cx = viewport.clientWidth / 2;
        const cy = viewport.clientHeight / 2;

        if (action === "zoom-in") {
          zoomAround(cx, cy, 1.3);
        } else if (action === "zoom-out") {
          zoomAround(cx, cy, 1 / 1.3);
        } else if (action === "reset") {
          fitAndCenter();
        }
      });

      // Initial view: restore saved pan/zoom, else fit-to-view once rendered.
      if (saved) {
        applyTransform();
      } else {
        fitAndCenter();
      }
    });
  }

  // ── Collapsible headings + toolbar buttons ──────────────────────────────────
  const collapseAllBtn = document.getElementById("collapseAllBtn");
  const editBtn = document.getElementById("editBtn");

  if (collapseAllBtn) {
    collapseAllBtn.addEventListener("click", () => {
      const sections = contentElement.querySelectorAll(".collapsible-section");
      const toggles = contentElement.querySelectorAll(".collapse-toggle");
      if (sections.length === 0) return;

      const anyExpanded = Array.from(sections).some(
        (s) => !s.classList.contains("collapsible-section--collapsed")
      );

      sections.forEach((section) => {
        section.classList.toggle("collapsible-section--collapsed", anyExpanded);
      });
      toggles.forEach((toggle) => {
        toggle.setAttribute("aria-expanded", String(!anyExpanded));
        toggle.classList.toggle("collapse-toggle--collapsed", anyExpanded);
      });

      collapseAllBtn.textContent = anyExpanded ? "↕ Expand" : "↕ Collapse";
      collapseAllBtn.title = anyExpanded ? "Expand all sections" : "Collapse all sections";
    });
  }

  if (editBtn) {
    editBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "openEditor" });
    });
  }

  // ── Settings panel (right sidebar) ──────────────────────────────────────────
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsSidebar = document.getElementById("settingsSidebar");
  const settingsClose = document.getElementById("settingsClose");
  const defaultEditorToggle = document.getElementById("defaultEditorToggle");

  function isSettingsOpen() {
    return !!settingsSidebar && settingsSidebar.getAttribute("aria-hidden") === "false";
  }

  function openSettings() {
    if (!settingsSidebar) {
      return;
    }
    settingsSidebar.setAttribute("aria-hidden", "false");
    if (settingsBtn) {
      settingsBtn.setAttribute("aria-expanded", "true");
      settingsBtn.classList.add("ctrl-btn--active");
    }
    // Re-sync the toggle with the current VS Code setting each time it opens.
    vscode.postMessage({ type: "requestSettings" });
  }

  function closeSettings() {
    if (!settingsSidebar) {
      return;
    }
    settingsSidebar.setAttribute("aria-hidden", "true");
    if (settingsBtn) {
      settingsBtn.setAttribute("aria-expanded", "false");
      settingsBtn.classList.remove("ctrl-btn--active");
    }
  }

  function toggleSettings() {
    if (isSettingsOpen()) {
      closeSettings();
    } else {
      openSettings();
    }
  }

  // Reflect the default-editor state (driven by the extension's settingsState message).
  function applyDefaultEditorState(isDefault) {
    if (!defaultEditorToggle) {
      return;
    }
    defaultEditorToggle.setAttribute("aria-checked", isDefault ? "true" : "false");
    defaultEditorToggle.classList.toggle("setting-switch--on", !!isDefault);
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", toggleSettings);
  }
  if (settingsClose) {
    settingsClose.addEventListener("click", closeSettings);
  }
  if (defaultEditorToggle) {
    defaultEditorToggle.addEventListener("click", () => {
      const currentlyOn = defaultEditorToggle.getAttribute("aria-checked") === "true";
      // Ask the extension to flip the setting; it confirms back via settingsState.
      vscode.postMessage({ type: "setDefaultEditor", enabled: !currentlyOn });
    });
  }

  // ── Theme selection + custom themes ─────────────────────────────────────────
  const ADD_THEME_VALUE = "__add_new_theme__";
  const themeSelect = document.getElementById("themeSelect");
  const themeModalOverlay = document.getElementById("themeModalOverlay");
  const themeModalClose = document.getElementById("themeModalClose");
  const themeNameInput = document.getElementById("themeNameInput");
  const themeCssInput = document.getElementById("themeCssInput");
  const themeSaveBtn = document.getElementById("themeSaveBtn");
  const themeCancelBtn = document.getElementById("themeCancelBtn");

  // Last theme the user actually had selected; used to restore the <select> after
  // the transient "+ Add new theme…" action item is chosen.
  let lastActiveTheme = "claude";

  // Single injected <style> element holding the active custom theme's CSS.
  let customThemeStyleEl = null;

  function applyCustomThemeCss(css) {
    if (!customThemeStyleEl) {
      customThemeStyleEl = document.createElement("style");
      customThemeStyleEl.id = "customThemeStyle";
      // Appended after the linked stylesheets so equal-specificity token
      // overrides win on source order.
      document.head.appendChild(customThemeStyleEl);
    }
    customThemeStyleEl.textContent = css || "";
  }

  // ── "Add new theme" modal ─────────────────────────────────────────────────
  function isThemeModalOpen() {
    return !!themeModalOverlay && themeModalOverlay.getAttribute("aria-hidden") === "false";
  }

  function openThemeModal() {
    if (!themeModalOverlay) {
      return;
    }
    if (themeNameInput) {
      themeNameInput.value = "";
    }
    if (themeCssInput) {
      themeCssInput.value = "";
    }
    themeModalOverlay.setAttribute("aria-hidden", "false");
    if (themeNameInput) {
      themeNameInput.focus();
    }
  }

  function closeThemeModal() {
    if (!themeModalOverlay) {
      return;
    }
    themeModalOverlay.setAttribute("aria-hidden", "true");
  }

  function populateThemes(themes, activeTheme) {
    if (!themeSelect) {
      return;
    }
    lastActiveTheme = activeTheme || "claude";
    themeSelect.innerHTML = "";

    (themes || []).forEach((theme) => {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.builtin ? theme.label + " (built-in)" : theme.label;
      themeSelect.appendChild(option);
    });

    const addOption = document.createElement("option");
    addOption.value = ADD_THEME_VALUE;
    addOption.textContent = "+ Add new theme…";
    themeSelect.appendChild(addOption);

    themeSelect.value = lastActiveTheme;
  }

  if (themeSelect) {
    themeSelect.addEventListener("change", () => {
      const value = themeSelect.value;
      if (value === ADD_THEME_VALUE) {
        // Keep the dropdown on the real active theme; open the pop-up instead.
        themeSelect.value = lastActiveTheme;
        openThemeModal();
        return;
      }
      vscode.postMessage({ type: "setTheme", themeId: value });
    });
  }

  if (themeSaveBtn) {
    themeSaveBtn.addEventListener("click", () => {
      const name = (themeNameInput && themeNameInput.value ? themeNameInput.value : "").trim();
      const css = themeCssInput && themeCssInput.value ? themeCssInput.value : "";
      if (!name) {
        if (themeNameInput) {
          themeNameInput.focus();
        }
        return;
      }
      vscode.postMessage({ type: "saveTheme", name, css });
      closeThemeModal();
    });
  }

  if (themeCancelBtn) {
    themeCancelBtn.addEventListener("click", closeThemeModal);
  }
  if (themeModalClose) {
    themeModalClose.addEventListener("click", closeThemeModal);
  }
  if (themeModalOverlay) {
    // Click on the backdrop (outside the dialog) closes the modal.
    themeModalOverlay.addEventListener("click", (event) => {
      if (event.target === themeModalOverlay) {
        closeThemeModal();
      }
    });
  }

  function setupCollapsibleHeadings() {
    const headings = Array.from(contentElement.querySelectorAll("h1, h2, h3, h4, h5, h6"));

    headings.forEach((heading) => {
      const level = parseInt(heading.tagName.charAt(1), 10);
      const sectionChildren = [];
      let sibling = heading.nextElementSibling;

      while (sibling) {
        const siblingTag = sibling.tagName;
        if (/^H[1-6]$/i.test(siblingTag)) {
          const siblingLevel = parseInt(siblingTag.charAt(1), 10);
          if (siblingLevel <= level) {
            break;
          }
        }
        sectionChildren.push(sibling);
        sibling = sibling.nextElementSibling;
      }

      if (sectionChildren.length === 0) {
        return;
      }

      const sectionDiv = document.createElement("div");
      sectionDiv.className = "collapsible-section";
      // Inner wrapper carries overflow:hidden so the grid-rows 1fr→0fr
      // transition can smoothly clip the content while collapsing.
      const inner = document.createElement("div");
      inner.className = "collapsible-section__inner";
      sectionChildren.forEach((child) => inner.appendChild(child));
      sectionDiv.appendChild(inner);
      heading.after(sectionDiv);

      const toggle = document.createElement("span");
      toggle.className = "collapse-toggle";
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("role", "button");
      toggle.setAttribute("tabindex", "0");
      toggle.textContent = "▼";
      heading.prepend(toggle);

      const onToggle = (e) => {
        e.stopPropagation();
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!expanded));
        toggle.classList.toggle("collapse-toggle--collapsed", expanded);
        sectionDiv.classList.toggle("collapsible-section--collapsed", expanded);
      };

      toggle.addEventListener("click", onToggle);
      toggle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(e);
        }
      });
    });

    if (collapseAllBtn) {
      collapseAllBtn.textContent = "↕ Collapse";
      collapseAllBtn.title = "Collapse all sections";
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
        copyBtn.textContent = "✓ Copied";
        copyBtn.classList.add("code-copy-btn--copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("code-copy-btn--copied");
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
    if (!href) {
      return;
    }
    if (href.startsWith("#")) {
      // In-page anchor (e.g. heading anchor links): smooth-scroll to the target.
      if (href.length > 1) {
        event.preventDefault();
        const targetEl = document.getElementById(href.slice(1));
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
        }
      }
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
    target.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
  }

  // ── Scroll-position preservation across re-render ──────────────────────────
  // Capture the topmost visible source block + its on-screen offset, so after a
  // full innerHTML rebuild we can keep the user anchored instead of jumping up.
  function captureScrollAnchor() {
    const elements = contentElement.querySelectorAll("[data-line]");
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 0) {
        return { line: el.getAttribute("data-line"), offset: rect.top };
      }
    }
    return null;
  }

  function restoreScrollAnchor(anchor) {
    if (!anchor || anchor.line == null) {
      return;
    }
    let el = null;
    try {
      el = contentElement.querySelector('[data-line="' + CSS.escape(anchor.line) + '"]');
    } catch (_) {
      el = null;
    }
    if (!el) {
      return;
    }
    const delta = el.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 1) {
      // Don't echo this programmatic scroll back to the editor.
      suppressScrollUntil = Date.now() + 250;
      window.scrollBy(0, delta);
    }
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
      activeEl.scrollIntoView({ behavior: smoothBehavior(), block: "nearest" });
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

    // Esc closes the "Add new theme" pop-up first (it sits above everything else).
    if (event.key === "Escape" && isThemeModalOpen()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeThemeModal();
      return;
    }

    // Esc closes the settings panel when it's open and the find bar isn't.
    if (event.key === "Escape" && isSettingsOpen() && !findBar.classList.contains("find-bar--visible")) {
      event.preventDefault();
      closeSettings();
      return;
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
  window.addEventListener("message", async (event) => {
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

    if (message.type === "settingsState") {
      applyDefaultEditorState(message.isDefaultEditor === true);
      populateThemes(message.themes, message.activeTheme);
      return;
    }

    if (message.type !== "render") {
      return;
    }

    // Chrome that can change independently of content (title, meta, theme,
    // zoom, width) is always applied.
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
    applyCustomThemeCss(message.customThemeCss);
    // Re-apply zoom and width after each render (body class changes don't affect
    // inline custom properties we set on :root, but call to keep display in sync).
    applyZoom();
    applyWidth();

    const htmlChanged = (message.html || "") !== lastRenderedHtml;
    const themeChanged = message.theme !== lastMermaidTheme;

    if (!htmlChanged) {
      // Content is byte-identical — skip the expensive DOM rebuild entirely.
      // Only re-render diagrams if the theme changed (Mermaid colours depend on it).
      if (themeChanged) {
        await renderMermaid(message.theme);
        setupMermaidPanZoom();
        lastMermaidTheme = message.theme;
      }
      return;
    }

    // CRITICAL: clear find highlights BEFORE replacing innerHTML to avoid
    // corrupted DOM state (unwrap cannot find orphaned marks after innerHTML replacement).
    clearFindHighlights();

    // Remember where the user was looking so we can restore it after the rebuild.
    const anchor = captureScrollAnchor();

    contentElement.innerHTML = message.html || "";
    lastRenderedHtml = message.html || "";

    // Build TOC BEFORE collapsible headings so TOC labels are not polluted by
    // the prepended collapse toggle glyph.
    buildToc();
    setupCollapsibleHeadings();
    await renderMermaid(message.theme);
    lastMermaidTheme = message.theme;
    setupMermaidPanZoom();

    // Keep the previously-visible block anchored instead of jumping to the top.
    restoreScrollAnchor(anchor);

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
  // We drive pan + pinch via Pointer Events, so suppress native touch gestures.
  lightboxOverlay.style.touchAction = "none";
  document.body.appendChild(lightboxOverlay);

  // Lightbox state
  let lbScale = 1;
  let lbTranslateX = 0;
  let lbTranslateY = 0;
  // Pointer-based pan + pinch state (mouse, pen, touch).
  const lbPointers = new Map();
  let lbPanStart = null;
  let lbPinchStartDist = 0;
  let lbPinchStartScale = 1;
  let lbPinchPivot = null;

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
    lbPointers.clear();
    lbPanStart = null;
    lbPinchPivot = null;
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

  // Pan (1 pointer) + pinch-zoom (2 pointers), unified across mouse/pen/touch.
  lightboxOverlay.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".lightbox-controls")) {
      return;
    }
    event.preventDefault();
    lightboxOverlay.setPointerCapture(event.pointerId);
    lbPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (lbPointers.size === 1) {
      lbPanStart = { x: event.clientX, y: event.clientY, tx: lbTranslateX, ty: lbTranslateY };
      lightboxOverlay.style.cursor = "grabbing";
    } else if (lbPointers.size === 2) {
      const pts = Array.from(lbPointers.values());
      lbPinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      lbPinchStartScale = lbScale;
      lbPinchPivot = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
        tx: lbTranslateX,
        ty: lbTranslateY
      };
      lbPanStart = null;
    }
  });

  lightboxOverlay.addEventListener("pointermove", (event) => {
    if (!lbPointers.has(event.pointerId)) {
      return;
    }
    lbPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (lbPointers.size === 1 && lbPanStart) {
      lbTranslateX = lbPanStart.tx + (event.clientX - lbPanStart.x);
      lbTranslateY = lbPanStart.ty + (event.clientY - lbPanStart.y);
      lbApplyTransform();
    } else if (lbPointers.size === 2 && lbPinchPivot) {
      const pts = Array.from(lbPointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const newScale = Math.min(20, Math.max(0.1, lbPinchStartScale * (dist / lbPinchStartDist)));
      lbTranslateX = lbPinchPivot.x - (lbPinchPivot.x - lbPinchPivot.tx) * (newScale / lbPinchStartScale);
      lbTranslateY = lbPinchPivot.y - (lbPinchPivot.y - lbPinchPivot.ty) * (newScale / lbPinchStartScale);
      lbScale = newScale;
      lbApplyTransform();
    }
  });

  function lbEndPointer(event) {
    lbPointers.delete(event.pointerId);
    if (lbPointers.size < 2) {
      lbPinchPivot = null;
    }
    if (lbPointers.size === 1) {
      const p = Array.from(lbPointers.values())[0];
      lbPanStart = { x: p.x, y: p.y, tx: lbTranslateX, ty: lbTranslateY };
    } else if (lbPointers.size === 0) {
      lbPanStart = null;
      lightboxOverlay.style.cursor = "";
    }
  }

  lightboxOverlay.addEventListener("pointerup", lbEndPointer);
  lightboxOverlay.addEventListener("pointercancel", lbEndPointer);

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

    // Case 2: clicking a PlantUML <img class="plantuml-diagram">.
    // (Mermaid diagrams use the inline pan/zoom viewport, not the lightbox.)
    const plantumlImg = rawTarget.closest("img.plantuml-diagram");
    if (plantumlImg && !plantumlImg.closest("a[href]")) {
      event.preventDefault();
      event.stopPropagation();
      lbOpen(plantumlImg);
      return;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
