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

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "render") {
      return;
    }

    titleElement.textContent = message.title || "markdown-studio";
    applyTheme(message.theme);
    contentElement.innerHTML = message.html || "";

    void renderMermaid();
  });

  vscode.postMessage({ type: "ready" });
})();
