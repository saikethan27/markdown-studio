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

  assert.match(html, /<div class="mermaid">/u);
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
  assert.match(html, /<pre class="code-block">/u);
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
