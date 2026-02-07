import * as path from "node:path";
import * as vscode from "vscode";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import markdownItFootnote from "markdown-it-footnote";
import markdownItKatex from "markdown-it-katex";
import markdownItTaskLists from "markdown-it-task-lists";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

export interface RendererSettings {
  autoUpdateDebounceMs: number;
  enableMermaid: boolean;
  enableMath: boolean;
  enableTaskLists: boolean;
  enableFootnotes: boolean;
}

export interface RenderContext {
  document: vscode.TextDocument;
  webview: vscode.Webview;
  workspaceFolder?: vscode.WorkspaceFolder;
  settings: RendererSettings;
}

type LinkKind = "hash" | "external" | "markdown" | "asset";

interface LinkRewriteResult {
  href: string;
  kind: LinkKind;
}

interface HrefParts {
  pathPart: string;
  query: string;
  fragment: string;
}

export function renderMarkdown(context: RenderContext): string {
  const markdown = createMarkdownRenderer(context);
  return markdown.render(context.document.getText());
}

function createMarkdownRenderer(context: RenderContext): any {
  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    highlight: (code: string, language: string) => renderCodeBlock(code, language)
  });

  if (context.settings.enableTaskLists) {
    markdown.use(markdownItTaskLists as any, {
      enabled: true,
      label: true,
      labelAfter: true
    });
  }

  if (context.settings.enableFootnotes) {
    markdown.use(markdownItFootnote as any);
  }

  if (context.settings.enableMath) {
    markdown.use(markdownItKatex as any);
  }

  const defaultFenceRule = markdown.renderer.rules.fence;
  markdown.renderer.rules.fence = (
    tokens: any[],
    index: number,
    options: any,
    env: any,
    self: any
  ) => {
    const token = tokens[index];
    const language = getFenceLanguage(token.info);

    if (context.settings.enableMermaid && language === "mermaid") {
      return `<div class="mermaid">${escapeHtml(token.content)}</div>`;
    }

    if (defaultFenceRule) {
      return defaultFenceRule(tokens, index, options, env, self);
    }

    return self.renderToken(tokens, index, options);
  };

  const defaultImageRule = markdown.renderer.rules.image;
  markdown.renderer.rules.image = (
    tokens: any[],
    index: number,
    options: any,
    env: any,
    self: any
  ) => {
    const token = tokens[index];
    const originalSource = token.attrGet("src") ?? "";
    const rewrittenSource = rewriteImageSource(originalSource, context);

    token.attrSet("src", rewrittenSource);
    token.attrSet("loading", "lazy");

    if (defaultImageRule) {
      return defaultImageRule(tokens, index, options, env, self);
    }

    return self.renderToken(tokens, index, options);
  };

  const defaultLinkOpenRule = markdown.renderer.rules.link_open;
  markdown.renderer.rules.link_open = (
    tokens: any[],
    index: number,
    options: any,
    env: any,
    self: any
  ) => {
    const token = tokens[index];
    const originalHref = token.attrGet("href") ?? "";
    const rewrittenLink = rewriteLinkHref(originalHref, context);

    token.attrSet("href", rewrittenLink.href);
    token.attrSet("data-original-href", originalHref);
    token.attrSet("data-source-doc", context.document.uri.toString());
    token.attrSet("data-link-kind", rewrittenLink.kind);

    if (rewrittenLink.kind === "external") {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    } else {
      token.attrSet("target", "_self");
      token.attrSet("rel", "noopener noreferrer");
    }

    if (defaultLinkOpenRule) {
      return defaultLinkOpenRule(tokens, index, options, env, self);
    }

    return self.renderToken(tokens, index, options);
  };

  return markdown;
}

function rewriteImageSource(source: string, context: RenderContext): string {
  if (!source) {
    return source;
  }

  const parts = splitHref(source);
  if (!parts.pathPart || isDataUri(parts.pathPart) || isExternalHref(parts.pathPart)) {
    return source;
  }

  const resolvedUri = resolveLocalFileUri(source, context.document.uri, context.workspaceFolder);
  if (!resolvedUri) {
    return source;
  }

  return context.webview.asWebviewUri(resolvedUri).toString();
}

function rewriteLinkHref(href: string, context: RenderContext): LinkRewriteResult {
  if (!href) {
    return { href, kind: "asset" };
  }

  if (href.startsWith("#")) {
    return { href, kind: "hash" };
  }

  const parts = splitHref(href);
  if (!parts.pathPart) {
    return { href, kind: "asset" };
  }

  if (isExternalHref(parts.pathPart)) {
    return { href, kind: "external" };
  }

  if (isMarkdownPath(parts.pathPart)) {
    return { href, kind: "markdown" };
  }

  const resolvedUri = resolveLocalFileUri(href, context.document.uri, context.workspaceFolder);
  if (!resolvedUri) {
    return { href, kind: "asset" };
  }

  return {
    href: context.webview.asWebviewUri(resolvedUri).toString(),
    kind: "asset"
  };
}

function resolveLocalFileUri(
  href: string,
  sourceDocumentUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
): vscode.Uri | undefined {
  const parts = splitHref(href);
  const pathPart = parts.pathPart;

  if (!pathPart) {
    return undefined;
  }

  if (path.isAbsolute(pathPart)) {
    return vscode.Uri.file(pathPart).with({ query: parts.query, fragment: parts.fragment });
  }

  if (isExternalHref(pathPart)) {
    const parsedUri = vscode.Uri.parse(href);
    if (parsedUri.scheme === "file") {
      return parsedUri;
    }
    return undefined;
  }

  let resolvedPath: string | undefined;

  if (pathPart.startsWith("/") || pathPart.startsWith("\\")) {
    const workspaceRoot =
      workspaceFolder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!workspaceRoot) {
      return undefined;
    }

    const trimmedPath = pathPart.replace(/^[/\\]+/u, "");
    resolvedPath = path.join(workspaceRoot, trimmedPath);
  } else {
    resolvedPath = path.resolve(path.dirname(sourceDocumentUri.fsPath), pathPart);
  }

  return vscode.Uri.file(resolvedPath).with({ query: parts.query, fragment: parts.fragment });
}

function splitHref(href: string): HrefParts {
  const hashIndex = href.indexOf("#");
  const fragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";
  const withoutFragment = hashIndex >= 0 ? href.slice(0, hashIndex) : href;

  const queryIndex = withoutFragment.indexOf("?");
  const query = queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : "";
  const pathPart = queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;

  return { pathPart, query, fragment };
}

function isMarkdownPath(targetPath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(targetPath).toLowerCase());
}

function isDataUri(value: string): boolean {
  return /^data:/iu.test(value);
}

function isExternalHref(value: string): boolean {
  if (isLikelyWindowsAbsolutePath(value)) {
    return false;
  }

  return /^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function isLikelyWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[/\\]/iu.test(value);
}

function getFenceLanguage(info: string): string {
  return info.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
}

function renderCodeBlock(code: string, language: string): string {
  const normalizedLanguage = language.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";

  if (normalizedLanguage && hljs.getLanguage(normalizedLanguage)) {
    const highlighted = hljs.highlight(code, {
      language: normalizedLanguage,
      ignoreIllegals: true
    }).value;

    return [
      `<pre class="code-block">`,
      `<code class="hljs language-${normalizedLanguage}">${highlighted}</code>`,
      `</pre>`
    ].join("");
  }

  return [`<pre class="code-block">`, `<code class="hljs">${escapeHtml(code)}</code>`, `</pre>`].join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
