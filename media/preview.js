(function () {
  const vscode = acquireVsCodeApi();
  const contentElement = document.getElementById("content");
  const titleElement = document.getElementById("docTitle");
  const body = document.body;

  if (!contentElement || !titleElement) {
    return;
  }

  function applyTheme(theme) {
    body.classList.remove("theme-light", "theme-dark");
    body.classList.add(theme === "dark" ? "theme-dark" : "theme-light");
  }

  async function renderMermaid(theme) {
    if (typeof window.mermaid === "undefined") {
      return;
    }

    const nodes = contentElement.querySelectorAll(".mermaid");
    if (!nodes.length) {
      return;
    }

    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "dark" ? "dark" : "neutral"
      });

      await window.mermaid.run({ nodes });
    } catch (error) {
      console.error("[markdown-studio] Mermaid rendering failed:", error);
    }
  }

  // Global drag state shared across all mermaid viewports
  let activeDrag = null;

  document.addEventListener("mousemove", (e) => {
    if (!activeDrag) return;
    activeDrag.state.tx = activeDrag.startTx + (e.clientX - activeDrag.startX);
    activeDrag.state.ty = activeDrag.startTy + (e.clientY - activeDrag.startY);
    activeDrag.apply();
  });

  document.addEventListener("mouseup", () => {
    if (!activeDrag) return;
    activeDrag.viewport.style.cursor = "grab";
    activeDrag = null;
  });

  function setupMermaidPanZoom() {
    contentElement.querySelectorAll(".mermaid").forEach((canvas) => {
      if (canvas.parentElement && canvas.parentElement.classList.contains("mermaid-viewport")) {
        return;
      }

      const viewport = document.createElement("div");
      viewport.className = "mermaid-viewport";
      canvas.parentNode.insertBefore(viewport, canvas);
      viewport.appendChild(canvas);

      canvas.style.transformOrigin = "0 0";
      canvas.style.display = "inline-block";
      canvas.style.userSelect = "none";

      const state = { scale: 1, tx: 0, ty: 0 };

      function applyTransform() {
        canvas.style.transform = "translate(" + state.tx + "px, " + state.ty + "px) scale(" + state.scale + ")";
      }

      viewport.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const newScale = Math.max(0.1, Math.min(20, state.scale * factor));
        state.tx = mx - (mx - state.tx) * (newScale / state.scale);
        state.ty = my - (my - state.ty) * (newScale / state.scale);
        state.scale = newScale;
        applyTransform();
      }, { passive: false });

      viewport.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(".mermaid-controls")) return;
        e.preventDefault();
        viewport.style.cursor = "grabbing";
        activeDrag = {
          viewport,
          state,
          startX: e.clientX,
          startY: e.clientY,
          startTx: state.tx,
          startTy: state.ty,
          apply: applyTransform
        };
      });

      const controls = document.createElement("div");
      controls.className = "mermaid-controls";
      controls.innerHTML =
        "<button class=\"mermaid-ctrl-btn\" data-action=\"zoom-in\" title=\"Zoom In\">+</button>" +
        "<button class=\"mermaid-ctrl-btn\" data-action=\"zoom-out\" title=\"Zoom Out\">\u2212</button>" +
        "<button class=\"mermaid-ctrl-btn\" data-action=\"reset\" title=\"Reset View\">\u21BA Reset</button>";
      viewport.appendChild(controls);

      controls.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const cx = viewport.clientWidth / 2;
        const cy = viewport.clientHeight / 2;

        if (action === "zoom-in") {
          const newScale = Math.min(20, state.scale * 1.3);
          state.tx = cx - (cx - state.tx) * (newScale / state.scale);
          state.ty = cy - (cy - state.ty) * (newScale / state.scale);
          state.scale = newScale;
        } else if (action === "zoom-out") {
          const newScale = Math.max(0.1, state.scale / 1.3);
          state.tx = cx - (cx - state.tx) * (newScale / state.scale);
          state.ty = cy - (cy - state.ty) * (newScale / state.scale);
          state.scale = newScale;
        } else if (action === "reset") {
          state.scale = 1;
          state.tx = 0;
          state.ty = 0;
        }

        applyTransform();
      });
    });
  }

  const collapseAllBtn = document.getElementById("collapseAllBtn");
  const editBtn = document.getElementById("editBtn");

  if (collapseAllBtn) {
    collapseAllBtn.addEventListener("click", () => {
      const sections = contentElement.querySelectorAll(".collapsible-section");
      const toggles = contentElement.querySelectorAll(".collapse-toggle");
      if (sections.length === 0) return;

      const anyExpanded = Array.from(sections).some((s) => s.style.display !== "none");

      sections.forEach((section) => {
        section.style.display = anyExpanded ? "none" : "";
      });
      toggles.forEach((toggle) => {
        toggle.setAttribute("aria-expanded", String(!anyExpanded));
        toggle.textContent = anyExpanded ? "\u25B6" : "\u25BC";
      });

      collapseAllBtn.textContent = anyExpanded ? "\u2195 Expand All" : "\u2195 Collapse All";
      collapseAllBtn.title = anyExpanded ? "Expand All Sections" : "Collapse All Sections";
    });
  }

  if (editBtn) {
    editBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "openEditor" });
    });
  }

  contentElement.addEventListener("click", (event) => {
    const rawTarget = event.target;
    if (!(rawTarget instanceof Element)) {
      return;
    }

    const link = rawTarget.closest("a[href]");
    if (!link) {
      return;
    }

    const href = link.getAttribute("href") || "";
    if (!href) {
      return;
    }
    if (href.startsWith("#")) {
      if (href.length > 1) {
        event.preventDefault();
        const targetId = href.slice(1);
        const targetElement = document.getElementById(targetId);
        if (targetElement) {
          targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
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
      heading.after(sectionDiv);
      sectionChildren.forEach((child) => sectionDiv.appendChild(child));

      const toggle = document.createElement("span");
      toggle.className = "collapse-toggle";
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("role", "button");
      toggle.setAttribute("tabindex", "0");
      toggle.textContent = "\u25BC";
      heading.prepend(toggle);

      const onToggle = (e) => {
        e.stopPropagation();
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!expanded));
        toggle.textContent = expanded ? "\u25B6" : "\u25BC";
        sectionDiv.style.display = expanded ? "none" : "";
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
      collapseAllBtn.textContent = "\u2195 Collapse All";
      collapseAllBtn.title = "Collapse All Sections";
    }
  }

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (!message || message.type !== "render") {
      return;
    }

    activeDrag = null;
    titleElement.textContent = message.title || "markdown-studio";
    applyTheme(message.theme);
    contentElement.innerHTML = message.html || "";

    setupCollapsibleHeadings();
    await renderMermaid(message.theme);
    setupMermaidPanZoom();
  });

  vscode.postMessage({ type: "ready" });
})();
