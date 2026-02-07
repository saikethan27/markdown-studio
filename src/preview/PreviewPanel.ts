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
  title: string;
}

interface ReadyMessage {
  type: "ready";
}

interface OpenLinkMessage {
  type: "openLink";
  href: string;
  sourceDoc: string;
}

type IncomingWebviewMessage = ReadyMessage | OpenLinkMessage;

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
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      "Claude Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
          context.extensionUri,
          ...workspaceResourceRoots
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
    const html = renderMarkdown({
      document: this.currentDocument,
      webview: this.panel.webview,
      workspaceFolder: vscode.workspace.getWorkspaceFolder(this.currentDocument.uri),
      settings
    });

    const payload: RenderPayload = {
      type: "render",
      html,
      theme,
      title
    };

    this.panel.title = `Claude Preview: ${title}`;
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
      void vscode.window.showWarningMessage(`Claude Markdown Preview: unable to open link (${message}).`);
    }
  }

  private getRendererSettings(): RendererSettings {
    const config = vscode.workspace.getConfiguration("claudeMarkdownPreview");

    return {
      autoUpdateDebounceMs: config.get<number>("autoUpdateDebounceMs", 150),
      enableMermaid: config.get<boolean>("enableMermaid", true),
      enableMath: config.get<boolean>("enableMath", true),
      enableTaskLists: config.get<boolean>("enableTaskLists", true),
      enableFootnotes: config.get<boolean>("enableFootnotes", true)
    };
  }

  private getWebviewHtml(): string {
    const webview = this.panel.webview;
    const nonce = createNonce();
    const initialTheme = this.getThemeKind();

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

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Claude Preview</title>
  <link rel="stylesheet" href="${baseCssUri}">
  <link rel="stylesheet" href="${markdownCssUri}">
  ${katexCssLink}
</head>
<body class="${initialTheme === "dark" ? "theme-dark" : "theme-light"}">
  <div class="claude-shell">
    <header class="preview-header">
      <div class="preview-title" id="docTitle">Claude Markdown Preview</div>
    </header>
    <main class="preview-main">
      <article class="preview-content claude-styled" id="content"></article>
    </main>
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

  const candidate = value as Partial<IncomingWebviewMessage>;
  return candidate.type === "ready" || candidate.type === "openLink";
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

function createNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
