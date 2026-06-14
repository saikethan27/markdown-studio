import * as path from "node:path";
import * as zlib from "node:zlib";
import * as vscode from "vscode";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import markdownItFootnote from "markdown-it-footnote";
import markdownItKatex from "markdown-it-katex";
import markdownItTaskLists from "markdown-it-task-lists";
import { full as markdownItEmoji } from "markdown-it-emoji";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

// Alert types for GFM-style admonitions
const ALERT_TYPES = new Set(["note", "tip", "important", "warning", "caution"]);

export interface RendererSettings {
  autoUpdateDebounceMs: number;
  enableMermaid: boolean;
  enableMath: boolean;
  enableTaskLists: boolean;
  enableFootnotes: boolean;
  showLineNumbers: boolean;
  enableFrontmatter: boolean;
  enableEmoji: boolean;
  enablePlantuml: boolean;
  plantumlServerUrl: string;
}

export interface RenderContext {
  document: vscode.TextDocument;
  webview: vscode.Webview;
  workspaceFolder?: vscode.WorkspaceFolder;
  settings: RendererSettings;
  exportMode?: boolean;
}

export interface ExportRenderContext {
  document: vscode.TextDocument;
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

interface FrontmatterResult {
  strippedSource: string;
  tableHtml: string;
  frontmatterLineOffset: number;
}

export function renderMarkdown(context: RenderContext): string {
  const rawText = context.document.getText();

  // Feature 3: strip and render front matter before passing to markdown-it
  let source = rawText;
  let frontmatterHtml = "";
  let frontmatterLineOffset = 0;
  if (context.settings.enableFrontmatter) {
    const fm = extractFrontmatter(source);
    source = fm.strippedSource;
    frontmatterHtml = fm.tableHtml;
    frontmatterLineOffset = fm.frontmatterLineOffset;
  }

  const markdown = createMarkdownRenderer(context, frontmatterLineOffset);
  const bodyHtml = markdown.render(source);
  return frontmatterHtml + bodyHtml;
}

/**
 * Render markdown for standalone HTML export.
 * Does not require a webview; local images and asset links resolve to file:// URIs.
 */
export function renderMarkdownForExport(ctx: ExportRenderContext): string {
  // Provide a stub webview — it is never called in exportMode because
  // rewriteImageSource / rewriteLinkHref return file:// URIs directly.
  const stubWebview = {
    asWebviewUri: (uri: vscode.Uri) => uri
  } as unknown as vscode.Webview;

  return renderMarkdown({
    document: ctx.document,
    webview: stubWebview,
    workspaceFolder: ctx.workspaceFolder,
    settings: ctx.settings,
    exportMode: true
  });
}

// ── Feature 3: Front matter extraction ────────────────────────────────────────

function extractFrontmatter(source: string): FrontmatterResult {
  // Must start with --- (optionally leading blank lines are NOT allowed per spec)
  const lines = source.split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    return { strippedSource: source, tableHtml: "", frontmatterLineOffset: 0 };
  }

  // Find closing ---
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === "---") {
      closeIndex = i;
      break;
    }
  }

  if (closeIndex === -1) {
    return { strippedSource: source, tableHtml: "", frontmatterLineOffset: 0 };
  }

  // The body begins on the line after the closing ---
  // closeIndex is 0-based line index of closing ---; body starts at closeIndex + 1
  const frontmatterLineOffset = closeIndex + 1;

  const fmLines = lines.slice(1, closeIndex);
  const remainder = lines.slice(closeIndex + 1).join("\n");

  // Parse simple key: value pairs
  const pairs: Array<{ key: string; value: string }> = [];
  for (const line of fmLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 1) {
      continue; // skip lines without a colon or starting with colon
    }
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    const value = rawValue.replace(/^["']|["']$/gu, "");
    if (key) {
      pairs.push({ key, value });
    }
  }

  if (pairs.length === 0) {
    return { strippedSource: remainder, tableHtml: "", frontmatterLineOffset };
  }

  const rows = pairs
    .map((p) => `<tr><th>${escapeHtml(p.key)}</th><td>${escapeHtml(p.value)}</td></tr>`)
    .join("");
  const tableHtml = `<table class="frontmatter"><tbody>${rows}</tbody></table>`;

  return { strippedSource: remainder, tableHtml, frontmatterLineOffset };
}

// ── Feature 2: Heading slug utilities ─────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/gu, "")  // strip non-word chars (keep hyphens, spaces, word chars)
    .replace(/\s+/gu, "-")       // spaces → hyphens
    .replace(/-+/gu, "-")        // collapse multiple hyphens
    .replace(/^-|-$/gu, "");     // trim leading/trailing hyphens
}

function createMarkdownRenderer(context: RenderContext, frontmatterLineOffset = 0): any {
  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    highlight: (code: string, language: string) =>
      renderCodeBlock(code, language, context.settings.showLineNumbers)
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

  // Feature 4: Emoji shortcodes
  if (context.settings.enableEmoji) {
    markdown.use(markdownItEmoji as any);
  }

  // Core ruler: stamp data-line on every block token that has source map info.
  // Add frontmatterLineOffset so line numbers reflect the original document (not the stripped body).
  markdown.core.ruler.push("source_line", (state: any) => {
    for (const token of state.tokens) {
      if (token.map && token.map[0] != null) {
        token.attrSet("data-line", String(token.map[0] + frontmatterLineOffset));
      }
    }
  });

  // Feature 1: GFM alerts — core ruler runs after source_line
  markdown.core.ruler.push("gfm_alerts", (state: any) => {
    const tokens = state.tokens;
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token.type !== "blockquote_open") {
        i++;
        continue;
      }

      // Look for the first inline token inside this blockquote
      // Structure: blockquote_open, bullet_list_open? ... paragraph_open, inline, paragraph_close, ...
      // We scan forward to find the first inline token inside this blockquote
      let alertType: string | null = null;
      let inlineTokenIdx = -1;

      // Find matching blockquote_close to know our range
      let depth = 0;
      let closeIdx = -1;
      for (let j = i; j < tokens.length; j++) {
        if (tokens[j].type === "blockquote_open") {
          depth++;
        } else if (tokens[j].type === "blockquote_close") {
          depth--;
          if (depth === 0) {
            closeIdx = j;
            break;
          }
        }
      }

      // Scan inside the blockquote for the first inline token
      for (let j = i + 1; j < closeIdx; j++) {
        if (tokens[j].type === "inline") {
          inlineTokenIdx = j;
          break;
        }
      }

      if (inlineTokenIdx !== -1) {
        const inlineToken = tokens[inlineTokenIdx];
        const children = inlineToken.children ?? [];
        // Check if first child text matches [!TYPE]
        if (children.length > 0 && children[0].type === "text") {
          const firstText: string = children[0].content;
          const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/iu.exec(firstText);
          if (match) {
            alertType = match[1].toLowerCase();
          }
        }
      }

      if (alertType !== null && ALERT_TYPES.has(alertType)) {
        // Add classes to the blockquote_open token
        const existingClass = token.attrGet("class") ?? "";
        token.attrSet(
          "class",
          [existingClass, "markdown-alert", `markdown-alert-${alertType}`]
            .filter(Boolean)
            .join(" ")
        );

        // Remove the [!TYPE] marker from the first inline's children
        const inlineToken = tokens[inlineTokenIdx];
        const children = inlineToken.children ?? [];
        const firstChild = children[0];
        // Strip the marker text and any following whitespace/newline
        const remainder = firstChild.content
          .slice(firstChild.content.indexOf("]") + 1)
          .replace(/^\s*/u, "");
        if (remainder) {
          firstChild.content = remainder;
        } else {
          // Remove the first text child entirely (empty after stripping)
          children.splice(0, 1);
          // Also remove a leading softbreak if present
          if (children.length > 0 && children[0].type === "softbreak") {
            children.splice(0, 1);
          }
        }
        inlineToken.children = children;

        // Inject an alert title token before the blockquote's first paragraph_open
        // Find the paragraph_open after blockquote_open
        let paragraphOpenIdx = -1;
        for (let j = i + 1; j < closeIdx; j++) {
          if (tokens[j].type === "paragraph_open") {
            paragraphOpenIdx = j;
            break;
          }
        }

        if (paragraphOpenIdx !== -1) {
          const label = alertType.charAt(0).toUpperCase() + alertType.slice(1);
          const titleHtml = `<p class="markdown-alert-title"><span class="markdown-alert-icon" aria-hidden="true"></span>${escapeHtml(label)}</p>`;

          // Insert an html_block token before paragraph_open
          const titleToken = new state.Token("html_block", "", 0);
          titleToken.content = titleHtml;
          tokens.splice(paragraphOpenIdx, 0, titleToken);
        }
      }

      i++;
    }
  });

  // Feature 2: Heading anchors — core ruler after source_line to add ids + anchor tokens
  const headingSlugMap = new Map<string, number>();
  markdown.core.ruler.push("heading_anchors", (state: any) => {
    // Reset slug map per render
    headingSlugMap.clear();
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "heading_open") {
        continue;
      }

      const headingOpen = tokens[i];
      const inlineToken = tokens[i + 1]; // heading_open is always followed by inline

      if (!inlineToken || inlineToken.type !== "inline") {
        continue;
      }

      // Derive text from inline children
      const rawText = (inlineToken.children ?? [])
        .filter((c: any) => c.type === "text" || c.type === "code_inline")
        .map((c: any) => c.content)
        .join("");

      let slug = slugify(rawText) || "heading";

      // De-duplicate
      if (headingSlugMap.has(slug)) {
        const count = (headingSlugMap.get(slug) ?? 0) + 1;
        headingSlugMap.set(slug, count);
        slug = `${slug}-${count}`;
      } else {
        headingSlugMap.set(slug, 0);
      }

      headingOpen.attrSet("id", slug);

      // Append anchor token to the inline children
      const anchorToken = new state.Token("html_inline", "", 0);
      anchorToken.content = `<a class="heading-anchor" href="#${escapeHtml(slug)}" aria-label="Link to this section">#</a>`;
      if (!inlineToken.children) {
        inlineToken.children = [];
      }
      inlineToken.children.push(anchorToken);
    }
  });

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
    const lineNum = token.map != null ? token.map[0] + frontmatterLineOffset : null;
    const lineAttr = lineNum != null ? ` data-line="${lineNum}"` : "";

    if (context.settings.enableMermaid && language === "mermaid") {
      return `<div class="mermaid"${lineAttr}>${escapeHtml(token.content)}</div>`;
    }

    if (context.settings.enablePlantuml && (language === "plantuml" || language === "puml")) {
      const serverUrl = (context.settings.plantumlServerUrl || "https://www.plantuml.com/plantuml").replace(/\/+$/u, "");
      const encoded = encodePlantuml(token.content);
      return `<img class="plantuml-diagram" loading="lazy"${lineAttr} src="${escapeHtml(serverUrl)}/svg/${encoded}" alt="PlantUML diagram">`;
    }

    if (defaultFenceRule) {
      const rendered = defaultFenceRule(tokens, index, options, env, self);
      // The highlight callback returns a <pre class="code-block">…</pre> string which
      // markdown-it passes through as-is (starts with "<pre"). We inject data-line
      // directly into that outer tag since attrSet on the fence token has no effect here.
      if (lineNum != null) {
        return rendered.replace(/^(<pre\b)/, `$1 data-line="${lineNum}"`);
      }
      return rendered;
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

  if (context.exportMode) {
    // In export mode, return a file:// URI (absolute) so standalone HTML can load local images.
    return resolvedUri.toString();
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

  if (context.exportMode) {
    // In export mode, return a file:// URI so standalone HTML links resolve correctly.
    return { href: resolvedUri.toString(), kind: "asset" };
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

function renderCodeBlock(code: string, language: string, showLineNumbers = false): string {
  const normalizedLanguage = language.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const langDisplay = normalizedLanguage;

  const toolbar = [
    `<div class="code-block-toolbar">`,
    langDisplay
      ? `<span class="code-block-lang">${escapeHtml(langDisplay)}</span>`
      : `<span class="code-block-lang code-block-lang--unknown">text</span>`,
    `<button class="code-copy-btn" type="button" aria-label="Copy code">Copy</button>`,
    `</div>`
  ].join("");

  if (normalizedLanguage && hljs.getLanguage(normalizedLanguage)) {
    const highlighted = hljs.highlight(code, {
      language: normalizedLanguage,
      ignoreIllegals: true
    }).value;

    const codeEl = `<code class="hljs language-${normalizedLanguage}">${highlighted}</code>`;

    if (showLineNumbers) {
      const trimmedCode = code.endsWith("\n") ? code.slice(0, -1) : code;
      const lineCount = trimmedCode.split("\n").length;
      const gutterLines = Array.from({ length: lineCount }, (_, i) =>
        `<span class="ln">${i + 1}</span>`
      ).join("");
      const gutter = `<div class="code-gutter" aria-hidden="true">${gutterLines}</div>`;
      return [
        `<pre class="code-block code-block--ln">`,
        toolbar,
        `<div class="code-block-body">`,
        gutter,
        codeEl,
        `</div>`,
        `</pre>`
      ].join("");
    }

    return [`<pre class="code-block">`, toolbar, codeEl, `</pre>`].join("");
  }

  const codeEl = `<code class="hljs">${escapeHtml(code)}</code>`;

  if (showLineNumbers) {
    const trimmedCode = code.endsWith("\n") ? code.slice(0, -1) : code;
    const lineCount = trimmedCode.split("\n").length;
    const gutterLines = Array.from({ length: lineCount }, (_, i) =>
      `<span class="ln">${i + 1}</span>`
    ).join("");
    const gutter = `<div class="code-gutter" aria-hidden="true">${gutterLines}</div>`;
    return [
      `<pre class="code-block code-block--ln">`,
      toolbar,
      `<div class="code-block-body">`,
      gutter,
      codeEl,
      `</div>`,
      `</pre>`
    ].join("");
  }

  return [`<pre class="code-block">`, toolbar, codeEl, `</pre>`].join("");
}

// ── PlantUML encoder ──────────────────────────────────────────────────────────

/**
 * Encode diagram text using the canonical PlantUML text-encoding format:
 * 1. UTF-8 encode the text.
 * 2. Deflate (raw, level 9) — no zlib/gzip header.
 * 3. Encode the resulting bytes with PlantUML's base64 variant.
 *
 * PlantUML base64 alphabet (6-bit value v):
 *   0–9  → '0'..'9'
 *  10–35 → 'A'..'Z'
 *  36–61 → 'a'..'z'
 *    62  → '-'
 *    63  → '_'
 *
 * Groups of 3 bytes produce 4 characters. If the final group has fewer than 3 bytes,
 * the missing bytes are treated as 0 and the corresponding trailing character(s) are
 * still emitted (no padding '=' characters — PlantUML does not use them).
 */
function encodePlantuml(diagramText: string): string {
  const input = Buffer.from(diagramText, "utf8");
  const deflated = zlib.deflateRawSync(input, { level: 9 });
  return plantumlBase64(deflated);
}

function plantumlBase64(bytes: Buffer): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
  let result = "";
  const len = bytes.length;

  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;

    result += alphabet[(b0 >> 2) & 0x3f];
    result += alphabet[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0f)];
    result += alphabet[((b1 & 0x0f) << 2) | ((b2 >> 6) & 0x03)];
    result += alphabet[b2 & 0x3f];
  }

  // If the last group was partial, we have emitted one or two extra characters.
  // PlantUML does not use '=' padding — the extra characters are 0-bits but are kept.
  // Nothing to trim: they carry valid (if zero) bits and are expected by the server.
  return result;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
