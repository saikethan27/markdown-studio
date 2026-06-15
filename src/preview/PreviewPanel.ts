import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { renderMarkdown, type RendererSettings } from "../render/markdownRenderer";

const PANEL_VIEW_TYPE = "claudeMarkdownPreview.preview";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

interface RenderPayload {
  type: "render";
  html: string;
  theme: "light" | "dark";
  themeStyle: "claude" | "github";
  title: string;
  wordCount: number;
  readingTimeMin: number;
}

interface ReadyMessage {
  type: "ready";
}

interface OpenLinkMessage {
  type: "openLink";
  href: string;
  sourceDoc: string;
}

interface EditorRevealLineMessage {
  type: "editorRevealLine";
  line: number;
  focus?: boolean;
}

interface OpenEditorMessage {
  type: "openEditor";
}

type IncomingWebviewMessage =
  | ReadyMessage
  | OpenLinkMessage
  | EditorRevealLineMessage
  | OpenEditorMessage;

interface HrefParts {
  pathPart: string;
  query: string;
  fragment: string;
}

export class PreviewPanel {
  private static currentPanelInstance: PreviewPanel | undefined;

  public static get current(): PreviewPanel | undefined {
    return PreviewPanel.currentPanelInstance;
  }

  public static createOrShow(context: vscode.ExtensionContext, document: vscode.TextDocument): PreviewPanel {
    if (PreviewPanel.currentPanelInstance) {
      PreviewPanel.currentPanelInstance.panel.reveal(vscode.ViewColumn.Beside);
      PreviewPanel.currentPanelInstance.setDocument(document);
      return PreviewPanel.currentPanelInstance;
    }

    const workspaceResourceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri);
    const customCssDirUri = resolveCustomCssDirUri(context);
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      "markdown-studio",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
          context.extensionUri,
          ...workspaceResourceRoots,
          ...(customCssDirUri ? [customCssDirUri] : [])
        ]
      }
    );

    PreviewPanel.currentPanelInstance = new PreviewPanel(panel, context, document);
    return PreviewPanel.currentPanelInstance;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];

  private currentDocument: vscode.TextDocument;
  private renderTimer: NodeJS.Timeout | undefined;
  private isReady = false;
  private pendingRenderPayload: RenderPayload | undefined;

  // Feedback-loop guard: timestamp until which outgoing editor→preview sync is suppressed.
  private suppressSyncUntil = 0;

  /** Last rendered inner HTML — used by the copyHtml command. */
  public lastRenderedHtml = "";

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, document: vscode.TextDocument) {
    this.panel = panel;
    this.context = context;
    this.currentDocument = document;

    this.panel.webview.html = this.getWebviewHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    }, null, this.disposables);

    this.scheduleRender();
  }

  public handleTextDocumentChange(document: vscode.TextDocument): void {
    if (document.uri.toString() !== this.currentDocument.uri.toString()) {
      return;
    }

    this.scheduleRender();
  }

  public handleActiveEditorChange(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.document.languageId !== "markdown") {
      return;
    }

    this.setDocument(editor.document);
  }

  public handleThemeChange(): void {
    this.scheduleRender();
  }

  /** URI string of the document currently being previewed (used by extension.ts). */
  public get currentDocumentUri(): string {
    return this.currentDocument.uri.toString();
  }

  /** The document currently being rendered by this panel. */
  public get document(): vscode.TextDocument {
    return this.currentDocument;
  }

  /** Post a message to the webview panel. */
  public postMessage(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /**
   * Post a revealLine message to the webview so it scrolls to match the editor.
   * Respects the scrollSync config setting and the feedback-loop guard.
   */
  public syncPreviewToLine(line: number): void {
    if (!this.isScrollSyncEnabled()) {
      return;
    }

    // If we are still within the suppress window (triggered by a preview→editor sync), skip.
    if (Date.now() < this.suppressSyncUntil) {
      return;
    }

    void this.panel.webview.postMessage({ type: "revealLine", line });
  }

  public dispose(): void {
    PreviewPanel.currentPanelInstance = undefined;

    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }

    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private setDocument(document: vscode.TextDocument): void {
    this.currentDocument = document;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }

    const delay = Math.max(0, this.getRendererSettings().autoUpdateDebounceMs);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      void this.renderNow();
    }, delay);
  }

  private async renderNow(): Promise<void> {
    const settings = this.getRendererSettings();
    const title = path.basename(this.currentDocument.fileName);
    const theme = this.getThemeKind();
    const themeStyle = this.getThemeStyle();
    const docText = this.currentDocument.getText();
    const html = renderMarkdown({
      document: this.currentDocument,
      webview: this.panel.webview,
      workspaceFolder: vscode.workspace.getWorkspaceFolder(this.currentDocument.uri),
      settings
    });

    this.lastRenderedHtml = html;

    const wordCount = docText.trim().split(/\s+/u).filter((w) => w.length > 0).length;
    const readingTimeMin = Math.max(1, Math.round(wordCount / 200));

    const payload: RenderPayload = {
      type: "render",
      html,
      theme,
      themeStyle,
      title,
      wordCount,
      readingTimeMin
    };

    this.panel.title = `markdown-studio: ${title}`;
    this.postRenderPayload(payload);
  }

  private postRenderPayload(payload: RenderPayload): void {
    if (!this.isReady) {
      this.pendingRenderPayload = payload;
      return;
    }

    void this.panel.webview.postMessage(payload);
  }

  private getThemeKind(): "light" | "dark" {
    const themeKind = vscode.window.activeColorTheme.kind;
    const isDark =
      themeKind === vscode.ColorThemeKind.Dark || themeKind === vscode.ColorThemeKind.HighContrast;
    return isDark ? "dark" : "light";
  }

  private getThemeStyle(): "claude" | "github" {
    const val = vscode.workspace.getConfiguration("claudeMarkdownPreview").get<string>("theme", "claude");
    return val === "github" ? "github" : "claude";
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isIncomingMessage(message)) {
      return;
    }

    if (message.type === "ready") {
      this.isReady = true;

      if (this.pendingRenderPayload) {
        const pendingPayload = this.pendingRenderPayload;
        this.pendingRenderPayload = undefined;
        void this.panel.webview.postMessage(pendingPayload);
      }

      return;
    }

    if (message.type === "openLink") {
      await this.handleOpenLink(message.href, message.sourceDoc);
      return;
    }

    if (message.type === "editorRevealLine") {
      this.handleEditorRevealLine(message.line, message.focus === true);
      return;
    }

    if (message.type === "openEditor") {
      await vscode.window.showTextDocument(this.currentDocument, {
        viewColumn: vscode.ViewColumn.One,
        preview: false
      });
    }
  }

  private handleEditorRevealLine(line: number, focus: boolean): void {
    if (!this.isScrollSyncEnabled() && !focus) {
      return;
    }

    // Set the suppress window so the subsequent visibleRanges event is ignored.
    this.suppressSyncUntil = Date.now() + 250;

    const targetEditor = vscode.window.visibleTextEditors.find(
      (ed) => ed.document.uri.toString() === this.currentDocument.uri.toString()
    );

    if (!targetEditor) {
      return;
    }

    const position = new vscode.Position(line, 0);
    const range = new vscode.Range(position, position);
    targetEditor.revealRange(range, vscode.TextEditorRevealType.AtTop);

    if (focus) {
      targetEditor.selection = new vscode.Selection(position, position);
      void vscode.window.showTextDocument(targetEditor.document, {
        viewColumn: targetEditor.viewColumn,
        preserveFocus: false,
        preview: false
      });
    }
  }

  private isScrollSyncEnabled(): boolean {
    return vscode.workspace.getConfiguration("claudeMarkdownPreview").get<boolean>("scrollSync", true);
  }

  private async handleOpenLink(rawHref: string, sourceDoc: string): Promise<void> {
    if (!rawHref || rawHref.startsWith("#")) {
      return;
    }

    if (isExternalHref(rawHref)) {
      const externalUri = vscode.Uri.parse(rawHref);
      await vscode.env.openExternal(externalUri);
      return;
    }

    const sourceDocumentUri = parseSourceDocumentUri(sourceDoc) ?? this.currentDocument.uri;
    const targetUri = resolveLocalUri(rawHref, sourceDocumentUri);

    if (!targetUri) {
      return;
    }

    const extension = path.extname(targetUri.fsPath).toLowerCase();

    try {
      if (MARKDOWN_EXTENSIONS.has(extension)) {
        const markdownDocument = await vscode.workspace.openTextDocument(targetUri.with({ fragment: "" }));
        await vscode.window.showTextDocument(markdownDocument, {
          preview: false,
          viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One
        });
        this.setDocument(markdownDocument);
        return;
      }

      await vscode.commands.executeCommand("vscode.open", targetUri);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      void vscode.window.showWarningMessage(`markdown-studio: unable to open link (${message}).`);
    }
  }

  private getRendererSettings(): RendererSettings {
    const config = vscode.workspace.getConfiguration("claudeMarkdownPreview");

    return {
      autoUpdateDebounceMs: config.get<number>("autoUpdateDebounceMs", 150),
      enableMermaid: config.get<boolean>("enableMermaid", true),
      enableMath: config.get<boolean>("enableMath", true),
      enableTaskLists: config.get<boolean>("enableTaskLists", true),
      enableFootnotes: config.get<boolean>("enableFootnotes", true),
      showLineNumbers: config.get<boolean>("showLineNumbers", false),
      enableFrontmatter: config.get<boolean>("enableFrontmatter", true),
      enableEmoji: config.get<boolean>("enableEmoji", true),
      enablePlantuml: config.get<boolean>("enablePlantuml", false),
      plantumlServerUrl: config.get<string>("plantumlServerUrl", "https://www.plantuml.com/plantuml")
    };
  }

  private getWebviewHtml(): string {
    const webview = this.panel.webview;
    const nonce = createNonce();
    const initialTheme = this.getThemeKind();
    const initialThemeStyle = this.getThemeStyle();

    const themeCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme.css"));
    const baseCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "claude-base.css"));
    const markdownCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "claude-markdown.css")
    );
    const previewScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "preview.js"));

    const katexCssFsPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "node_modules",
      "katex",
      "dist",
      "katex.min.css"
    ).fsPath;

    const mermaidScriptFsPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "node_modules",
      "mermaid",
      "dist",
      "mermaid.min.js"
    ).fsPath;

    const katexCssLink = fs.existsSync(katexCssFsPath)
      ? `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.file(katexCssFsPath))}">`
      : "";

    const mermaidScriptTag = fs.existsSync(mermaidScriptFsPath)
      ? `<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.file(mermaidScriptFsPath))}"></script>`
      : "";

    // Custom CSS override
    const customCssLink = resolveCustomCssLink(webview, this.context);

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    const initialBodyClass = [
      initialTheme === "dark" ? "theme-dark" : "theme-light",
      initialThemeStyle === "github" ? "theme-style-github" : "theme-style-claude"
    ].join(" ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>markdown-studio</title>
  <link rel="stylesheet" href="${themeCssUri}">
  <link rel="stylesheet" href="${baseCssUri}">
  <link rel="stylesheet" href="${markdownCssUri}">
  ${katexCssLink}
  ${customCssLink}
</head>
<body class="${initialBodyClass}">
  <div class="claude-shell">
    <header class="preview-header">
      <button class="toc-toggle" id="tocToggle" type="button" aria-label="Toggle outline" aria-expanded="true">&#9776;</button>
      <div class="preview-title" id="docTitle">markdown-studio</div>
      <span class="doc-meta" id="docMeta"></span>
      <div class="header-controls" aria-label="Appearance controls">
        <button class="ctrl-btn" id="themeStyleBtn" type="button"
          title="Theme style (change in settings)" aria-label="Theme style">${initialThemeStyle === "github" ? "GH" : "CL"}</button>
        <div class="ctrl-separator" role="separator"></div>
        <button class="ctrl-btn" id="zoomOut" type="button" title="Zoom out (Ctrl+-)" aria-label="Zoom out">A&#8209;</button>
        <button class="ctrl-btn" id="zoomReset" type="button" title="Reset zoom (Ctrl+0)" aria-label="Reset zoom">16px</button>
        <button class="ctrl-btn" id="zoomIn" type="button" title="Zoom in (Ctrl+=)" aria-label="Zoom in">A+</button>
        <div class="ctrl-separator" role="separator"></div>
        <button class="ctrl-btn" id="widthCycle" type="button" title="Cycle content width" aria-label="Content width">Normal</button>
        <div class="ctrl-separator" role="separator"></div>
        <button class="ctrl-btn" id="collapseAllBtn" type="button" title="Collapse all sections" aria-label="Collapse all sections">&#8597; Collapse</button>
        <button class="ctrl-btn" id="editBtn" type="button" title="Edit source" aria-label="Edit source">&#9998; Edit</button>
      </div>
    </header>
    <div class="claude-body">
      <nav class="toc-sidebar" id="tocSidebar" aria-label="Table of contents"><ol class="toc-list" id="tocList"></ol></nav>
      <main class="preview-main">
        <article class="preview-content claude-styled" id="content"></article>
      </main>
    </div>
  </div>
  ${mermaidScriptTag}
  <script nonce="${nonce}" src="${previewScriptUri}"></script>
</body>
</html>`;
  }
}

function isIncomingMessage(value: unknown): value is IncomingWebviewMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { type?: unknown };
  return (
    candidate.type === "ready" ||
    candidate.type === "openLink" ||
    candidate.type === "editorRevealLine" ||
    candidate.type === "openEditor"
  );
}

function parseSourceDocumentUri(value: string): vscode.Uri | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return vscode.Uri.parse(value);
  } catch {
    return undefined;
  }
}

function resolveLocalUri(rawHref: string, sourceDocumentUri: vscode.Uri): vscode.Uri | undefined {
  const parts = splitHref(rawHref);
  const pathPart = parts.pathPart;

  if (!pathPart) {
    return undefined;
  }

  if (path.isAbsolute(pathPart)) {
    return vscode.Uri.file(pathPart).with({ query: parts.query, fragment: parts.fragment });
  }

  if (hasUriScheme(pathPart)) {
    const parsedUri = vscode.Uri.parse(rawHref);
    if (parsedUri.scheme === "file") {
      return parsedUri;
    }

    return undefined;
  }

  const resolvedPath = pathPart.startsWith("/") || pathPart.startsWith("\\")
    ? resolveFromWorkspaceRoot(pathPart, sourceDocumentUri)
    : path.resolve(path.dirname(sourceDocumentUri.fsPath), pathPart);

  if (!resolvedPath) {
    return undefined;
  }

  return vscode.Uri.file(resolvedPath).with({ query: parts.query, fragment: parts.fragment });
}

function resolveFromWorkspaceRoot(pathFromRoot: string, sourceDocumentUri: vscode.Uri): string | undefined {
  const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(sourceDocumentUri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }

  const normalizedPath = pathFromRoot.replace(/^[/\\]+/u, "");
  return path.join(workspaceFolder.uri.fsPath, normalizedPath);
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

function isExternalHref(href: string): boolean {
  if (isLikelyWindowsAbsolutePath(href)) {
    return false;
  }

  if (!hasUriScheme(href)) {
    return false;
  }

  try {
    const parsedUri = vscode.Uri.parse(href);
    return parsedUri.scheme === "http" || parsedUri.scheme === "https" || parsedUri.scheme === "mailto";
  } catch {
    return false;
  }
}

function hasUriScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function isLikelyWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[/\\]/iu.test(value);
}

/**
 * Resolve the configured customCssPath to an absolute fs path, or return undefined.
 * Relative paths are resolved against the first workspace folder root.
 */
function resolveCustomCssFsPath(context: vscode.ExtensionContext): string | undefined {
  const raw = vscode.workspace.getConfiguration("claudeMarkdownPreview").get<string>("customCssPath", "").trim();
  if (!raw) {
    return undefined;
  }

  const resolved = path.isAbsolute(raw)
    ? raw
    : (() => {
        const workspaceFolder =
          vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          return undefined;
        }
        return path.join(workspaceFolder.uri.fsPath, raw);
      })();

  if (!resolved || !fs.existsSync(resolved)) {
    return undefined;
  }

  return resolved;
}

/** Return the directory Uri of the custom CSS file (for localResourceRoots), or undefined. */
function resolveCustomCssDirUri(context: vscode.ExtensionContext): vscode.Uri | undefined {
  const fsPath = resolveCustomCssFsPath(context);
  if (!fsPath) {
    return undefined;
  }

  return vscode.Uri.file(path.dirname(fsPath));
}

/** Return a <link> tag for the custom CSS file, or empty string if not configured / not found. */
function resolveCustomCssLink(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const fsPath = resolveCustomCssFsPath(context);
  if (!fsPath) {
    return "";
  }

  return `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.file(fsPath))}">`;
}

function createNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

