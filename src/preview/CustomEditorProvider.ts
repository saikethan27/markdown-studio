import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RendererSettings } from "../render/markdownRenderer";
import { renderMarkdown } from "../render/lazyRenderer";
import { addComment, deleteComment, listComments, updateComment, updateCommentConfig } from "./comments";
import { isDefaultMarkdownEditor, setDefaultMarkdownEditor } from "./defaultEditor";
import { SETTINGS_PANEL_HTML, THEME_MODAL_HTML } from "./settingsPanel";
import { katexCssPath, mermaidScriptPath } from "./vendorAssets";
import {
  getActiveCustomThemeCss,
  getActiveThemeStyle,
  getActivePalette,
  getPaletteOptions,
  setActivePalette,
  type ThemeStyle,
  getThemeOptions,
  getActiveThemeId,
  saveCustomTheme,
  setActiveTheme
} from "./themes";

/** Short badge shown in the preview header for each built-in theme style. */
const THEME_BADGES: Record<ThemeStyle, string> = {
  claude: "CL",
  github: "GH",
  ergoread: "ER",
  executive: "EX"
};

const CUSTOM_EDITOR_VIEW_TYPE = "claudeMarkdownPreview.customEditor";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

interface RenderPayload {
  type: "render";
  html: string;
  theme: "light" | "dark";
  themeStyle: ThemeStyle;
  palette: string;
  customThemeCss: string;
  title: string;
  wordCount: number;
  readingTimeMin: number;
  commentCount: number;
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

interface RequestSettingsMessage {
  type: "requestSettings";
}

interface SetDefaultEditorMessage {
  type: "setDefaultEditor";
  enabled: boolean;
}

interface SetThemeMessage {
  type: "setTheme";
  themeId: string;
}

interface SetPaletteMessage {
  type: "setPalette";
  paletteId: string;
}

interface SaveThemeMessage {
  type: "saveTheme";
  name: string;
  css: string;
}

interface AddCommentMessage {
  type: "addComment";
  line: number;
  text: string;
}

interface UpdateCommentMessage {
  type: "updateComment";
  id: string;
  text: string;
}

interface DeleteCommentMessage {
  type: "deleteComment";
  id: string;
}

interface RevealCommentMessage {
  type: "revealComment";
  id: string;
}

interface SetCommentConfigMessage {
  type: "setCommentConfig";
  key: "showComments" | "includeCommentsInExport" | "commentAuthor";
  value: boolean | string;
}

type IncomingWebviewMessage =
  | ReadyMessage
  | OpenLinkMessage
  | EditorRevealLineMessage
  | OpenEditorMessage
  | RequestSettingsMessage
  | SetDefaultEditorMessage
  | SetThemeMessage
  | SetPaletteMessage
  | SaveThemeMessage
  | AddCommentMessage
  | UpdateCommentMessage
  | DeleteCommentMessage
  | RevealCommentMessage
  | SetCommentConfigMessage;

interface HrefParts {
  pathPart: string;
  query: string;
  fragment: string;
}

export class CustomEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = CUSTOM_EDITOR_VIEW_TYPE;

  /** The most-recently-focused custom editor session. Updated by view-state events. */
  public static activeSession: CustomEditorSession | undefined;

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CustomEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(CustomEditorProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      },
      supportsMultipleEditorsPerDocument: true
    });
  }

  private readonly context: vscode.ExtensionContext;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    new CustomEditorSession(this.context, document, webviewPanel);
  }
}

export class CustomEditorSession {
  private readonly context: vscode.ExtensionContext;
  private readonly webviewPanel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private currentDocument: vscode.TextDocument;
  private renderTimer: NodeJS.Timeout | undefined;
  private isReady = false;
  private pendingRenderPayload: RenderPayload | undefined;

  /** Last rendered inner HTML — used by the copyHtml command. */
  public lastRenderedHtml = "";

  /** The document currently being rendered by this session. */
  public get document(): vscode.TextDocument {
    return this.currentDocument;
  }

  /** Post a message to the webview panel owned by this session. */
  public postMessage(message: unknown): void {
    void this.webviewPanel.webview.postMessage(message);
  }

  public constructor(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ) {
    this.context = context;
    this.currentDocument = document;
    this.webviewPanel = webviewPanel;

    const workspaceResourceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri);
    const customCssDirUri = resolveCustomCssDirUri(this.context);

    this.webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        this.context.extensionUri,
        ...workspaceResourceRoots,
        ...(customCssDirUri ? [customCssDirUri] : [])
      ]
    };

    this.webviewPanel.webview.html = this.getWebviewHtml();

    this.webviewPanel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.webviewPanel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    }, null, this.disposables);

    // Track focus so commands can resolve the active custom session.
    this.webviewPanel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        CustomEditorProvider.activeSession = this;
      } else if (CustomEditorProvider.activeSession === this) {
        CustomEditorProvider.activeSession = undefined;
      }
    }, null, this.disposables);

    // Mark as active immediately when first created (it will be focused).
    CustomEditorProvider.activeSession = this;

    vscode.workspace.onDidChangeTextDocument((event) => {
      this.handleTextDocumentChange(event.document);
    }, null, this.disposables);

    vscode.window.onDidChangeActiveColorTheme(() => {
      this.scheduleRender();
    }, null, this.disposables);

    // Keep the settings panel in sync if the relevant settings are changed
    // elsewhere (another markdown-studio view, or VS Code's own UI).
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("workbench.editorAssociations")) {
        this.postSettingsState();
      }
      if (
        event.affectsConfiguration("claudeMarkdownPreview.theme") ||
        event.affectsConfiguration("claudeMarkdownPreview.customThemes")
      ) {
        this.postSettingsState();
        this.scheduleRender();
      }
      if (
        event.affectsConfiguration("claudeMarkdownPreview.showComments") ||
        event.affectsConfiguration("claudeMarkdownPreview.includeCommentsInExport") ||
        event.affectsConfiguration("claudeMarkdownPreview.commentAuthor")
      ) {
        this.postSettingsState();
        this.scheduleRender();
      }
      // The mermaid <script> is baked into the webview HTML, so toggling the
      // setting has to rebuild the document rather than just re-render.
      if (event.affectsConfiguration("claudeMarkdownPreview.enableMermaid")) {
        this.reloadWebview();
      }
    }, null, this.disposables);

    this.scheduleRender();
  }

  /** Rebuild the webview document and re-render into it once it reports ready. */
  private reloadWebview(): void {
    this.isReady = false;
    this.webviewPanel.webview.html = this.getWebviewHtml();
    this.scheduleRender();
  }

  /** Post the current settings state (toggle + theme list) to the webview. */
  private postSettingsState(): void {
    const config = vscode.workspace.getConfiguration("claudeMarkdownPreview");
    void this.webviewPanel.webview.postMessage({
      type: "settingsState",
      isDefaultEditor: isDefaultMarkdownEditor(),
      themes: getThemeOptions(),
      activeTheme: getActiveThemeId(),
      palettes: getPaletteOptions(),
      activePalette: getActivePalette(),
      showComments: config.get<boolean>("showComments", true),
      includeCommentsInExport: config.get<boolean>("includeCommentsInExport", false),
      commentAuthor: config.get<string>("commentAuthor", "")
    });
  }

  private handleTextDocumentChange(document: vscode.TextDocument): void {
    if (document.uri.toString() !== this.currentDocument.uri.toString()) {
      return;
    }

    this.scheduleRender();
  }

  private dispose(): void {
    if (CustomEditorProvider.activeSession === this) {
      CustomEditorProvider.activeSession = undefined;
    }

    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }

    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
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
    const palette = getActivePalette(themeStyle);
    const docText = this.currentDocument.getText();
    const html = renderMarkdown({
      document: this.currentDocument,
      webview: this.webviewPanel.webview,
      workspaceFolder: vscode.workspace.getWorkspaceFolder(this.currentDocument.uri),
      settings
    });

    this.lastRenderedHtml = html;

    const wordCount = docText.trim().split(/\s+/u).filter((w) => w.length > 0).length;
    const readingTimeMin = Math.max(1, Math.round(wordCount / 200));
    const commentCount = listComments(this.currentDocument).length;

    const payload: RenderPayload = {
      type: "render",
      html,
      theme,
      themeStyle,
      palette,
      customThemeCss: getActiveCustomThemeCss(),
      title,
      wordCount,
      readingTimeMin,
      commentCount
    };

    this.webviewPanel.title = title;
    this.postRenderPayload(payload);
  }

  private postRenderPayload(payload: RenderPayload): void {
    if (!this.isReady) {
      this.pendingRenderPayload = payload;
      return;
    }

    void this.webviewPanel.webview.postMessage(payload);
  }

  private getThemeKind(): "light" | "dark" {
    const themeKind = vscode.window.activeColorTheme.kind;
    const isDark =
      themeKind === vscode.ColorThemeKind.Dark || themeKind === vscode.ColorThemeKind.HighContrast;
    return isDark ? "dark" : "light";
  }

  private getThemeStyle(): ThemeStyle {
    return getActiveThemeStyle();
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
        void this.webviewPanel.webview.postMessage(pendingPayload);
      }

      this.postSettingsState();
      return;
    }

    if (message.type === "requestSettings") {
      this.postSettingsState();
      return;
    }

    if (message.type === "setDefaultEditor") {
      await setDefaultMarkdownEditor(message.enabled);
      this.postSettingsState();
      void vscode.window.showInformationMessage(
        message.enabled
          ? "markdown-studio is now the default editor for Markdown files."
          : "markdown-studio is no longer the default editor for Markdown files."
      );
      return;
    }

    if (message.type === "setTheme") {
      await setActiveTheme(message.themeId);
      this.scheduleRender();
      this.postSettingsState();
      return;
    }

    if (message.type === "setPalette") {
      await setActivePalette(message.paletteId);
      this.scheduleRender();
      this.postSettingsState();
      return;
    }

    if (message.type === "saveTheme") {
      await saveCustomTheme(message.name, message.css);
      this.scheduleRender();
      this.postSettingsState();
      void vscode.window.showInformationMessage(`markdown-studio: saved theme "${message.name.trim()}".`);
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
      await vscode.commands.executeCommand(
        "vscode.openWith",
        this.currentDocument.uri,
        "default",
        vscode.ViewColumn.Beside
      );
      return;
    }

    if (message.type === "addComment") {
      if (await addComment(this.currentDocument, message.line, message.text)) {
        await this.currentDocument.save();
      }
      return;
    }

    if (message.type === "updateComment") {
      if (await updateComment(this.currentDocument, message.id, message.text)) {
        await this.currentDocument.save();
      }
      return;
    }

    if (message.type === "deleteComment") {
      if (await deleteComment(this.currentDocument, message.id)) {
        await this.currentDocument.save();
      }
      return;
    }

    if (message.type === "revealComment") {
      const comment = listComments(this.currentDocument).find((c) => c.id === message.id);
      if (comment) {
        this.handleEditorRevealLine(comment.line, true);
      }
      return;
    }

    if (message.type === "setCommentConfig") {
      await updateCommentConfig(message.key, message.value);
    }
  }

  /**
   * Best-effort: if a text editor with this document is visible (e.g., user opened
   * it as text alongside the custom editor), reveal + optionally focus. Otherwise no-op.
   */
  private handleEditorRevealLine(line: number, focus: boolean): void {
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
        await vscode.commands.executeCommand(
          "vscode.openWith",
          targetUri.with({ fragment: "" }),
          CustomEditorProvider.viewType,
          this.webviewPanel.viewColumn
        );
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
      plantumlServerUrl: config.get<string>("plantumlServerUrl", "https://www.plantuml.com/plantuml"),
      showComments: config.get<boolean>("showComments", true),
      includeCommentsInExport: config.get<boolean>("includeCommentsInExport", false)
    };
  }

  private getWebviewHtml(): string {
    const webview = this.webviewPanel.webview;
    const nonce = createNonce();
    const initialTheme = this.getThemeKind();
    const initialThemeStyle = this.getThemeStyle();
    const initialPalette = getActivePalette(initialThemeStyle);

    const themeCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme.css"));
    const baseCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "claude-base.css"));
    const markdownCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "claude-markdown.css")
    );
    const previewScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "preview.js"));

    const katexCssFsPath = katexCssPath(this.context.extensionUri);
    const katexCssLink = katexCssFsPath
      ? `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.file(katexCssFsPath))}">`
      : "";

    // mermaid.min.js is ~3.5MB. Only ship it to the webview when the feature is
    // actually on — otherwise every preview pays to download and parse it.
    const mermaidScriptFsPath = this.getRendererSettings().enableMermaid
      ? mermaidScriptPath(this.context.extensionUri)
      : undefined;
    const mermaidScriptTag = mermaidScriptFsPath
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
      `theme-style-${initialThemeStyle}`,
      initialPalette ? `theme-palette-${initialPalette}` : ""
    ].filter(Boolean).join(" ");

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
          title="Theme style (change in settings)" aria-label="Theme style">${THEME_BADGES[initialThemeStyle]}</button>
        <div class="ctrl-separator" role="separator"></div>
        <button class="ctrl-btn" id="zoomOut" type="button" title="Zoom out (Ctrl+-)" aria-label="Zoom out">A&#8209;</button>
        <button class="ctrl-btn" id="zoomReset" type="button" title="Reset zoom (Ctrl+0)" aria-label="Reset zoom">16px</button>
        <button class="ctrl-btn" id="zoomIn" type="button" title="Zoom in (Ctrl+=)" aria-label="Zoom in">A+</button>
        <div class="ctrl-separator" role="separator"></div>
        <button class="ctrl-btn" id="widthCycle" type="button" title="Cycle content width" aria-label="Content width">Normal</button>
        <div class="ctrl-separator" role="separator"></div>
        <button class="ctrl-btn" id="collapseAllBtn" type="button" title="Collapse all sections" aria-label="Collapse all sections">&#8597; Collapse</button>
        <button class="ctrl-btn" id="editBtn" type="button" title="Edit source" aria-label="Edit source">&#9998; Edit</button>
        <div class="ctrl-separator" role="separator"></div>
        <button class="ctrl-btn" id="settingsBtn" type="button" title="Settings" aria-label="Settings" aria-expanded="false">&#9881;</button>
      </div>
    </header>
    <div class="claude-body">
      <nav class="toc-sidebar" id="tocSidebar" aria-label="Table of contents"><ol class="toc-list" id="tocList"></ol></nav>
      <main class="preview-main">
        <article class="preview-content claude-styled" id="content"></article>
      </main>
      ${SETTINGS_PANEL_HTML}
    </div>
  </div>
  ${THEME_MODAL_HTML}
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
    candidate.type === "openEditor" ||
    candidate.type === "requestSettings" ||
    candidate.type === "setDefaultEditor" ||
    candidate.type === "setTheme" ||
    candidate.type === "setPalette" ||
    candidate.type === "saveTheme" ||
    candidate.type === "addComment" ||
    candidate.type === "updateComment" ||
    candidate.type === "deleteComment" ||
    candidate.type === "revealComment" ||
    candidate.type === "setCommentConfig"
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
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
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

