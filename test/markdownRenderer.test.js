const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

class MockUri {
  constructor(options) {
    this.scheme = options.scheme;
    this.fsPath = options.fsPath;
    this.base = options.base;
    this.query = options.query;
    this.fragment = options.fragment;
  }

  static file(filePath) {
    return new MockUri({
      scheme: "file",
      fsPath: path.resolve(filePath),
      base: "",
      query: "",
      fragment: ""
    });
  }

  static parse(value) {
    const { pathPart, query, fragment } = splitHref(value);
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/iu.exec(pathPart);

    if (!schemeMatch) {
      throw new Error(`Invalid URI: ${value}`);
    }

    const scheme = schemeMatch[1].toLowerCase();

    if (scheme === "file") {
      const withoutScheme = pathPart.replace(/^file:(\/\/)?/iu, "");
      const normalized = decodeURIComponent(withoutScheme).replace(/^\/([a-z]:)/iu, "$1");
      const fsPath = normalized.replace(/\//gu, path.sep);

      return new MockUri({
        scheme,
        fsPath,
        base: "",
        query,
        fragment
      });
    }

    return new MockUri({
      scheme,
      fsPath: "",
      base: pathPart,
      query,
      fragment
    });
  }

  with(change) {
    return new MockUri({
      scheme: this.scheme,
      fsPath: this.fsPath,
      base: this.base,
      query: change.query ?? this.query,
      fragment: change.fragment ?? this.fragment
    });
  }

  toString() {
    let value = this.scheme === "file" ? toFileUriString(this.fsPath) : this.base;

    if (this.query) {
      value += `?${this.query}`;
    }

    if (this.fragment) {
      value += `#${this.fragment}`;
    }

    return value;
  }
}

const workspaceRoot = process.platform === "win32" ? "C:\\workspace" : "/workspace";
const sourceDocumentPath = path.join(workspaceRoot, "docs", "note.md");
const mockWorkspaceFolder = {
  uri: MockUri.file(workspaceRoot)
};

const mockVscode = {
  Uri: MockUri,
  workspace: {
    workspaceFolders: [mockWorkspaceFolder]
  }
};

let vscodeMockInstalled = false;

function installVscodeMock() {
  if (vscodeMockInstalled) {
    return;
  }

  const originalLoad = Module._load;
  Module._load = (request, parent, isMain) => {
    if (request === "vscode") {
      return mockVscode;
    }

    return originalLoad(request, parent, isMain);
  };

  vscodeMockInstalled = true;
}

function loadRendererModule() {
  installVscodeMock();
  const rendererPath = require.resolve("../out/render/markdownRenderer");
  delete require.cache[rendererPath];
  return require(rendererPath);
}

function createContext(markdown, settings = {}) {
  const document = {
    uri: MockUri.file(sourceDocumentPath),
    fileName: sourceDocumentPath,
    getText: () => markdown
  };

  const webview = {
    asWebviewUri: (uri) => MockUri.parse(`vscode-webview:${uri.toString()}`)
  };

  return {
    document,
    webview,
    workspaceFolder: mockWorkspaceFolder,
    settings: {
      autoUpdateDebounceMs: 0,
      enableMermaid: true,
      enableMath: true,
      enableTaskLists: true,
      enableFootnotes: true,
      showLineNumbers: false,
      enableFrontmatter: true,
      enableEmoji: true,
      enablePlantuml: false,
      plantumlServerUrl: "https://www.plantuml.com/plantuml",
      ...settings
    }
  };
}

function splitHref(href) {
  const hashIndex = href.indexOf("#");
  const fragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";
  const withoutFragment = hashIndex >= 0 ? href.slice(0, hashIndex) : href;

  const queryIndex = withoutFragment.indexOf("?");
  const query = queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : "";
  const pathPart = queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;

  return { pathPart, query, fragment };
}

function toFileUriString(filePath) {
  const normalized = filePath.replace(/\\/gu, "/");
  const prefix = normalized.startsWith("/") ? "" : "/";
  return `file://${prefix}${normalized}`;
}

test("renders mermaid fenced block as a mermaid container when enabled", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(
    createContext("```mermaid\ngraph TD;\nA-->B;\n```", {
      enableMermaid: true
    })
  );

  assert.match(html, /<div class="mermaid"[^>]*>/u);
  assert.match(html, /graph TD;/u);
});

test("falls back to code block rendering for mermaid fences when disabled", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(
    createContext("```mermaid\ngraph TD;\nA-->B;\n```", {
      enableMermaid: false
    })
  );

  assert.doesNotMatch(html, /<div class="mermaid">/u);
  assert.match(html, /<pre[^>]*class="code-block"[^>]*>/u);
});

test("rewrites external links with external metadata and target blank", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("[link](https://example.com/docs?q=1#section)"));

  assert.match(html, /data-link-kind="external"/u);
  assert.match(html, /target="_blank"/u);
  assert.match(html, /href="https:\/\/example\.com\/docs\?q=1#section"/u);
});

test("keeps markdown links local and marks them as markdown links", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("[guide](./guide.md#intro)"));

  assert.match(html, /data-link-kind="markdown"/u);
  assert.match(html, /target="_self"/u);
  assert.match(html, /href="\.\/guide\.md#intro"/u);
});

test("rewrites local assets and images to webview URIs", () => {
  const { renderMarkdown } = loadRendererModule();
  const markdown = "[spec](./assets/spec.pdf?download=1#top)\n\n![image](./assets/diagram.png?size=2#frag)";
  const html = renderMarkdown(createContext(markdown));

  assert.match(html, /data-link-kind="asset"/u);
  assert.match(html, /href="vscode-webview:file:\/\/\/.*assets\/spec\.pdf\?download=1#top"/u);
  assert.match(html, /src="vscode-webview:file:\/\/\/.*assets\/diagram\.png\?size=2#frag"/u);
});

test("preserves hash links and marks them as hash links", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("[jump](#section-1)"));

  assert.match(html, /data-link-kind="hash"/u);
  assert.match(html, /href="#section-1"/u);
});

test("escapes unknown code block content to avoid raw HTML output", () => {
  const { renderMarkdown } = loadRendererModule();
  const markdown = "```unknown\n<script>alert('xss')</script>\n```";
  const html = renderMarkdown(createContext(markdown));

  assert.match(html, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/u);
});

test("stamps data-line attributes on block-level elements from source map", () => {
  const { renderMarkdown } = loadRendererModule();
  // Line 0: heading, Line 2: paragraph (blank line separates them)
  const html = renderMarkdown(createContext("# Hello World\n\nThis is a paragraph."));

  // Heading opens at line 0
  assert.match(html, /data-line="0"/u);
  // Paragraph opens at line 2
  assert.match(html, /data-line="2"/u);
});

test("stamps data-line on fenced code blocks", () => {
  const { renderMarkdown } = loadRendererModule();
  // Line 0: fence open, Line 2: paragraph after blank line
  const html = renderMarkdown(createContext("```js\nconsole.log(1);\n```\n\nText"));

  // The outer <pre class="code-block"> should carry data-line="0"
  assert.match(html, /<pre[^>]*data-line="0"[^>]*>/u);
});

test("stamps data-line on mermaid fenced blocks", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(
    createContext("```mermaid\ngraph TD;\nA-->B;\n```", { enableMermaid: true })
  );

  assert.match(html, /<div class="mermaid" data-line="0">/u);
});

test("respects task list, math, and footnote feature toggles", () => {
  const { renderMarkdown } = loadRendererModule();
  const markdown = "- [x] done\n\nInline math $a+b$\n\nRef[^1]\n\n[^1]: Note";

  const enabledHtml = renderMarkdown(createContext(markdown));
  assert.match(enabledHtml, /task-list-item-checkbox/u);
  assert.match(enabledHtml, /class="katex"/u);
  assert.match(enabledHtml, /footnote-ref/u);

  const disabledHtml = renderMarkdown(
    createContext(markdown, {
      enableTaskLists: false,
      enableMath: false,
      enableFootnotes: false
    })
  );

  assert.doesNotMatch(disabledHtml, /task-list-item-checkbox/u);
  assert.doesNotMatch(disabledHtml, /class="katex"/u);
  assert.doesNotMatch(disabledHtml, /footnote-ref/u);
  assert.doesNotMatch(disabledHtml, /<section class="footnotes">/u);
});

test("code fence renders language badge and copy button", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("```javascript\nconsole.log(1);\n```"));

  // Language label badge should show the fence language
  assert.match(html, /class="code-block-lang"/u);
  assert.match(html, /javascript/u);

  // Copy button must be present inside the code block toolbar
  assert.match(html, /class="code-copy-btn"/u);
  assert.match(html, /aria-label="Copy code"/u);

  // The outer <pre class="code-block"> must still carry data-line (Phase 1 invariant)
  assert.match(html, /<pre[^>]*data-line="0"[^>]*>/u);
});

test("code fence with no language shows text badge and copy button", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("```\nhello world\n```"));

  assert.match(html, /code-block-lang/u);
  assert.match(html, /code-copy-btn/u);
});

// ── Phase 5 tests ─────────────────────────────────────────────────────────────

test("GFM alert blockquote produces markdown-alert-note class", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(
    createContext("> [!NOTE]\n> This is a note.")
  );

  assert.match(html, /markdown-alert-note/u);
  assert.match(html, /markdown-alert-title/u);
  // Title text should be "Note"
  assert.match(html, /Note/u);
  // The [!NOTE] marker itself should not appear in the output
  assert.doesNotMatch(html, /\[!NOTE\]/u);
});

test("heading gets a slug id and a heading-anchor link", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("## Hello World"));

  // Heading should have id="hello-world"
  assert.match(html, /id="hello-world"/u);
  // Anchor link pointing to the same slug
  assert.match(html, /class="heading-anchor"/u);
  assert.match(html, /href="#hello-world"/u);
});

test("handles duplicate headings with unique suffixed ids", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("## Foo\n\n## Foo\n\n## Foo"));

  assert.match(html, /id="foo"/u);
  assert.match(html, /id="foo-1"/u);
  assert.match(html, /id="foo-2"/u);
});

test("strips inline formatting from heading slugs", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("## **Bold** text"));

  assert.match(html, /id="bold-text"/u);
});

test("headings include data-heading-level attribute", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("### My Section"));

  assert.match(html, /data-heading-level="3"/u);
});

test("front matter renders a .frontmatter table and is not shown raw", () => {
  const { renderMarkdown } = loadRendererModule();
  const markdown = "---\ntitle: My Doc\nauthor: Alice\n---\n\n# Content";
  const html = renderMarkdown(createContext(markdown));

  // Front matter table should be present
  assert.match(html, /class="frontmatter"/u);
  assert.match(html, /My Doc/u);
  assert.match(html, /Alice/u);
  // The raw --- delimiter should not appear as an <hr>
  assert.doesNotMatch(html, /<hr/u);
});

test("front matter is suppressed when enableFrontmatter is false", () => {
  const { renderMarkdown } = loadRendererModule();
  const markdown = "---\ntitle: My Doc\n---\n\n# Content";
  const html = renderMarkdown(createContext(markdown, { enableFrontmatter: false }));

  assert.doesNotMatch(html, /class="frontmatter"/u);
});

test("front matter offsets data-line so heading reflects its original document line", () => {
  const { renderMarkdown } = loadRendererModule();
  // Original document (0-indexed lines):
  //   0: ---
  //   1: title: X
  //   2: ---          ← closeIndex = 2, frontmatterLineOffset = 3
  //   3: (blank)
  //   4: # Heading    ← stripped body line 1; 1 + 3 = 4
  //   5: (blank)
  //   6: Body
  const markdown = "---\ntitle: X\n---\n\n# Heading\n\nBody";
  const html = renderMarkdown(createContext(markdown, { enableFrontmatter: true }));

  // The heading must carry the original document line number (4), not its stripped-body line (1).
  assert.match(html, /data-line="4"/u);
  // Ensure line 1 (stripped offset) is NOT used for the heading element
  assert.doesNotMatch(html, /<h[1-6][^>]*data-line="1"[^>]*>/u);
});

test("emoji shortcodes render to emoji characters", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("Launch :rocket: now!"));

  // :rocket: should become the rocket emoji 🚀
  assert.match(html, /🚀/u); // 🚀 as surrogate pair
  assert.doesNotMatch(html, /:rocket:/u);
});

// ── Phase 7 tests: export mode ─────────────────────────────────────────────────

test("renderMarkdown with exportMode:true resolves local image src to file:// URI (not vscode-webview:)", () => {
  const { renderMarkdown } = loadRendererModule();
  const md = "![diagram](./assets/diagram.png)";
  // In webview mode (default), asWebviewUri produces vscode-webview: URIs.
  const webviewHtml = renderMarkdown(createContext(md));
  assert.match(webviewHtml, /vscode-webview:/u);

  // In export mode, the src must be an absolute file:// URI.
  const exportHtml = renderMarkdown({
    ...createContext(md),
    exportMode: true
  });
  assert.doesNotMatch(exportHtml, /vscode-webview:/u);
  assert.match(exportHtml, /src="file:\/\//u);
});

test("renderMarkdownForExport resolves local image src to file:// URI without a webview object", () => {
  const { renderMarkdownForExport } = loadRendererModule();
  const md = "![diagram](./assets/diagram.png)";
  const { document, workspaceFolder, settings } = createContext(md);
  const html = renderMarkdownForExport({ document, workspaceFolder, settings });

  assert.doesNotMatch(html, /vscode-webview:/u);
  assert.match(html, /src="file:\/\//u);
});

test("renderMarkdownForExport leaves external image src unchanged", () => {
  const { renderMarkdownForExport } = loadRendererModule();
  const md = "![remote](https://example.com/image.png)";
  const { document, workspaceFolder, settings } = createContext(md);
  const html = renderMarkdownForExport({ document, workspaceFolder, settings });

  assert.match(html, /src="https:\/\/example\.com\/image\.png"/u);
});

test("renderMarkdownForExport resolves local asset links to file:// URIs", () => {
  const { renderMarkdownForExport } = loadRendererModule();
  const md = "[spec](./assets/spec.pdf)";
  const { document, workspaceFolder, settings } = createContext(md);
  const html = renderMarkdownForExport({ document, workspaceFolder, settings });

  assert.doesNotMatch(html, /vscode-webview:/u);
  assert.match(html, /href="file:\/\//u);
});

// ── Phase 8 tests: PlantUML ────────────────────────────────────────────────────

test("plantuml fence renders <img class='plantuml-diagram'> with server URL and encoded src when enabled", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(
    createContext("```plantuml\n@startuml\nA -> B : hello\n@enduml\n```", {
      enablePlantuml: true,
      plantumlServerUrl: "https://www.plantuml.com/plantuml"
    })
  );

  // Must render as an <img> with the plantuml-diagram class
  assert.match(html, /class="plantuml-diagram"/u);
  // src must start with the configured server URL + /svg/
  assert.match(html, /src="https:\/\/www\.plantuml\.com\/plantuml\/svg\//u);
  // Encoded string after /svg/ must be non-empty
  assert.match(html, /\/svg\/[A-Za-z0-9_\-]+"/u);
  // data-line attribute must be present
  assert.match(html, /data-line="0"/u);
  // Must NOT render a code-block fallback
  assert.doesNotMatch(html, /<pre[^>]*class="code-block"[^>]*>/u);
});

// ── Table wrapper ──────────────────────────────────────────────────────────────

test("wraps tables in a scrollable .table-wrap container", () => {
  const { renderMarkdown } = loadRendererModule();
  const markdown = "| A | B |\n| - | - |\n| 1 | 2 |";
  const html = renderMarkdown(createContext(markdown));

  // The table must be wrapped so wide tables scroll instead of clipping.
  assert.match(html, /<div class="table-wrap"><table/u);
  assert.match(html, /<\/table>\s*<\/div>/u);
});

test("table retains data-line for scroll sync", () => {
  const { renderMarkdown } = loadRendererModule();
  // Line 0: table header row.
  const markdown = "| A | B |\n| - | - |\n| 1 | 2 |";
  const html = renderMarkdown(createContext(markdown));

  assert.match(html, /<table[^>]*data-line="0"[^>]*>/u);
});

test("plantuml fence falls back to code-block when enablePlantuml is false", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(
    createContext("```plantuml\n@startuml\nA -> B : hello\n@enduml\n```", {
      enablePlantuml: false
    })
  );

  // Must NOT render as a plantuml-diagram img
  assert.doesNotMatch(html, /class="plantuml-diagram"/u);
  // Must render as a normal code block
  assert.match(html, /<pre[^>]*class="code-block"[^>]*>/u);
});

// ── Inline comments (features/comments.md, Phase C0) ────────────────────────────

test("@ms-comment marker renders an aside bubble with escaped text and data-line", () => {
  const { renderMarkdown } = loadRendererModule();
  // Line 0: paragraph, Line 1: marker glued directly after it.
  const html = renderMarkdown(createContext("Para text.\n<!-- @ms-comment:c1 Fix this -->\n"));

  assert.match(html, /<aside class="md-comment" data-comment-id="c1"[^>]*data-line="1"/u);
  assert.match(html, /<div class="md-comment__body">Fix this<\/div>/u);
  // The preceding paragraph survives on its own line.
  assert.match(html, /<p data-line="0">Para text\.<\/p>/u);
  // The marker must NOT leak as raw escaped text (html:false consume requirement).
  assert.doesNotMatch(html, /&lt;!-- @ms-comment/u);
});

test("comment text containing --> and quotes round-trips into the bubble", () => {
  const { renderMarkdown } = loadRendererModule();
  // The stored marker escapes --> as --&gt;; the renderer unescapes then HTML-escapes.
  const html = renderMarkdown(createContext('Para.\n<!-- @ms-comment:c2 use --&gt; and "q" -->\n'));

  assert.match(html, /class="md-comment"/u);
  assert.match(html, /<div class="md-comment__body">use --&gt; and &quot;q&quot;<\/div>/u);
});

test("ordinary HTML comment without the prefix is left untouched", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(createContext("Text.\n\n<!-- just a normal comment -->\n\nMore.\n"));

  assert.doesNotMatch(html, /md-comment/u);
  // Under html:false it stays as (escaped) text, not a bubble.
  assert.match(html, /&lt;!-- just a normal comment --&gt;/u);
});

test("@ms-comment-instructions block is consumed and never rendered", () => {
  const { renderMarkdown } = loadRendererModule();
  const md = "Body para.\n\n<!-- @ms-comment-instructions\nApply the change.\nThen delete.\n-->\n";
  const html = renderMarkdown(createContext(md));

  assert.doesNotMatch(html, /ms-comment-instructions/u);
  assert.doesNotMatch(html, /Apply the change\./u);
  assert.doesNotMatch(html, /md-comment/u);
  // The real body still renders.
  assert.match(html, /Body para\./u);
});

test("showComments=false and export mode suppress the comment bubble", () => {
  const { renderMarkdown } = loadRendererModule();
  const md = "Para.\n<!-- @ms-comment:c5 secret note -->\n";

  assert.match(renderMarkdown(createContext(md)), /md-comment/u);
  assert.doesNotMatch(renderMarkdown(createContext(md, { showComments: false })), /md-comment/u);
  assert.doesNotMatch(renderMarkdown({ ...createContext(md), exportMode: true }), /md-comment/u);
  assert.match(
    renderMarkdown({ ...createContext(md, { includeCommentsInExport: true }), exportMode: true }),
    /md-comment/u
  );
});

test("an agent's [skipped: reason] trail is highlighted in the bubble", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(
    createContext("Para.\n<!-- @ms-comment:c9 do the thing  [skipped: unclear] -->\n")
  );

  assert.match(html, /<span class="md-comment-skipped">\[skipped: unclear\]<\/span>/u);
});

test("stacked consecutive markers render as separate bubbles", () => {
  const { renderMarkdown } = loadRendererModule();
  const html = renderMarkdown(
    createContext("The block.\n<!-- @ms-comment:c1 first -->\n<!-- @ms-comment:c2 second -->\n")
  );

  assert.match(html, /data-comment-id="c1"[^>]*data-line="1"/u);
  assert.match(html, /data-comment-id="c2"[^>]*data-line="2"/u);
  assert.match(html, /<p data-line="0">The block\.<\/p>/u);
});
