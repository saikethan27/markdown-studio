import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { CustomEditorProvider } from "./preview/CustomEditorProvider";
import { PreviewPanel } from "./preview/PreviewPanel";
import { buildChatDigest } from "./preview/comments";
import {
  SNAPSHOT_SCHEME,
  hasSnapshot,
  snapshotContentProvider,
  snapshotUriFor,
  takeSnapshot
} from "./preview/commentReview";
import { renderMarkdownForExport } from "./render/markdownRenderer";

function isMarkdownDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
  return document?.languageId === "markdown";
}

/**
 * Resolve the active preview target.
 * If a custom editor session is focused, use it; otherwise fall back to the
 * side-by-side PreviewPanel singleton. Returns undefined if no preview is open.
 */
function resolveActiveTarget(): { document: vscode.TextDocument; lastRenderedHtml: string; postMessage: (msg: unknown) => void } | undefined {
  const session = CustomEditorProvider.activeSession;
  if (session) {
    return session;
  }

  const panel = PreviewPanel.current;
  if (panel) {
    return panel;
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const customEditorProvider = CustomEditorProvider.register(context);

  // Reopen the active Markdown file with the markdown-studio custom editor in the
  // SAME editor column (replaces the text editor in place — no split).
  const openInStudioCommand = vscode.commands.registerCommand("claudeMarkdownPreview.openInStudio", async () => {
    const activeEditor = vscode.window.activeTextEditor;

    if (!isMarkdownDocument(activeEditor?.document)) {
      void vscode.window.showInformationMessage("markdown-studio: open a Markdown file first.");
      return;
    }

    await vscode.commands.executeCommand(
      "vscode.openWith",
      activeEditor.document.uri,
      CustomEditorProvider.viewType,
      activeEditor.viewColumn
    );
  });

  const openPreviewCommand = vscode.commands.registerCommand("claudeMarkdownPreview.openPreview", () => {
    const activeEditor = vscode.window.activeTextEditor;

    if (!isMarkdownDocument(activeEditor?.document)) {
      void vscode.window.showInformationMessage("markdown-studio: open a Markdown file first.");
      return;
    }

    PreviewPanel.createOrShow(context, activeEditor.document);
  });

  // ── Export to HTML ──────────────────────────────────────────────────────────
  const exportHtmlCommand = vscode.commands.registerCommand("claudeMarkdownPreview.exportHtml", async () => {
    const target = resolveActiveTarget();
    if (!target) {
      void vscode.window.showInformationMessage("markdown-studio: open a markdown-studio preview first.");
      return;
    }

    const doc = target.document;
    const docBaseName = path.basename(doc.fileName, path.extname(doc.fileName));
    const defaultUri = vscode.Uri.file(
      path.join(path.dirname(doc.fileName), `${docBaseName}.html`)
    );

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { HTML: ["html"] },
      title: "Export to HTML"
    });

    if (!saveUri) {
      return;
    }

    // Read CSS files from disk for inline embedding.
    const mediaDir = vscode.Uri.joinPath(context.extensionUri, "media").fsPath;
    const readCss = (name: string): string => {
      const fsPath = path.join(mediaDir, name);
      return fs.existsSync(fsPath) ? fs.readFileSync(fsPath, "utf8") : "";
    };

    const themeCss = readCss("theme.css");
    const baseCss = readCss("claude-base.css");
    const markdownCss = readCss("claude-markdown.css");

    const katexCssFsPath = vscode.Uri.joinPath(
      context.extensionUri, "node_modules", "katex", "dist", "katex.min.css"
    ).fsPath;
    const katexCss = fs.existsSync(katexCssFsPath) ? fs.readFileSync(katexCssFsPath, "utf8") : "";

    // Render with export mode so images/assets use file:// URIs.
    const config = vscode.workspace.getConfiguration("claudeMarkdownPreview");
    const settings = {
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

    const contentHtml = renderMarkdownForExport({
      document: doc,
      workspaceFolder: vscode.workspace.getWorkspaceFolder(doc.uri),
      settings
    });

    const title = path.basename(doc.fileName);

    const htmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
/* theme.css */
${themeCss}
  </style>
  <style>
/* claude-base.css */
${baseCss}
  </style>
  <style>
/* claude-markdown.css */
${markdownCss}
  </style>
${katexCss ? `  <style>\n/* katex */\n${katexCss}\n  </style>` : ""}
  <style>
/* Export overrides: hide interactive UI, remove webview-specific chrome */
.preview-header, .toc-sidebar, .header-controls, .find-bar,
.code-copy-btn, .heading-anchor, .toc-toggle { display: none !important; }
.preview-main { max-width: none !important; margin: 0 !important; padding: 2rem !important; }
.preview-content { border: none !important; border-radius: 0 !important; box-shadow: none !important; }
body { --content-max-width: none; }
  </style>
</head>
<body class="theme-light theme-style-claude">
  <div class="claude-shell">
    <div class="claude-body">
      <main class="preview-main">
        <article class="preview-content claude-styled">
${contentHtml}
        </article>
      </main>
    </div>
  </div>
  <!-- Note: Mermaid diagrams are rendered as source <div class="mermaid"> blocks.
       They require the Mermaid library to render; not included for offline/standalone export. -->
</body>
</html>`;

    fs.writeFileSync(saveUri.fsPath, htmlDoc, "utf8");

    const openAction = "Open";
    const choice = await vscode.window.showInformationMessage(
      `markdown-studio: exported to ${saveUri.fsPath}`,
      openAction
    );

    if (choice === openAction) {
      await vscode.commands.executeCommand("vscode.open", saveUri);
    }
  });

  // ── Print / Export to PDF ───────────────────────────────────────────────────
  const exportPdfCommand = vscode.commands.registerCommand("claudeMarkdownPreview.exportPdf", () => {
    const target = resolveActiveTarget();
    if (!target) {
      void vscode.window.showInformationMessage("markdown-studio: open a markdown-studio preview first.");
      return;
    }

    target.postMessage({ type: "print" });
  });

  // ── Copy Rendered HTML ──────────────────────────────────────────────────────
  const copyHtmlCommand = vscode.commands.registerCommand("claudeMarkdownPreview.copyHtml", async () => {
    const target = resolveActiveTarget();
    if (!target) {
      void vscode.window.showInformationMessage("markdown-studio: open a markdown-studio preview first.");
      return;
    }

    const html = target.lastRenderedHtml;
    if (!html) {
      void vscode.window.showInformationMessage("markdown-studio: no rendered content yet — wait for the preview to load.");
      return;
    }

    await vscode.env.clipboard.writeText(html);
    void vscode.window.showInformationMessage("markdown-studio: rendered HTML copied to clipboard.");
  });

  // ── Inline comments: agent handoff & review loop (features/comments.md C5) ────

  const snapshotProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(
    SNAPSHOT_SCHEME,
    snapshotContentProvider
  );

  const REVIEW_ACTION = "Review changes";

  // Freeze the current text as the "before" anchor for a later diff review.
  const sendToAgentCommand = vscode.commands.registerCommand("claudeMarkdownPreview.sendToAgent", async () => {
    const target = resolveActiveTarget();
    if (!target) {
      void vscode.window.showInformationMessage("markdown-studio: open a markdown-studio preview first.");
      return;
    }

    takeSnapshot(target.document);
    const choice = await vscode.window.showInformationMessage(
      "markdown-studio: snapshot saved. Comments travel in the file — run your agent, then Review changes.",
      REVIEW_ACTION
    );
    if (choice === REVIEW_ACTION) {
      await vscode.commands.executeCommand("claudeMarkdownPreview.reviewChanges");
    }
  });

  // Build a paste-ready prompt for chat-only tools and copy it to the clipboard.
  const copyForChatCommand = vscode.commands.registerCommand(
    "claudeMarkdownPreview.copyCommentsForChat",
    async () => {
      const target = resolveActiveTarget();
      if (!target) {
        void vscode.window.showInformationMessage("markdown-studio: open a markdown-studio preview first.");
        return;
      }

      const digest = buildChatDigest(target.document);
      if (!digest) {
        void vscode.window.showInformationMessage("markdown-studio: no comments to copy — add a comment first.");
        return;
      }

      // Copying for chat is also a "send" — freeze the before-state for review.
      takeSnapshot(target.document);
      await vscode.env.clipboard.writeText(digest);
      const choice = await vscode.window.showInformationMessage(
        "markdown-studio: comment prompt copied. Paste it into your chat tool, then Review changes.",
        REVIEW_ACTION
      );
      if (choice === REVIEW_ACTION) {
        await vscode.commands.executeCommand("claudeMarkdownPreview.reviewChanges");
      }
    }
  );

  // Open VS Code's native diff: frozen snapshot (before) vs. the live file (after).
  const reviewChangesCommand = vscode.commands.registerCommand(
    "claudeMarkdownPreview.reviewChanges",
    async () => {
      const target = resolveActiveTarget();
      if (!target) {
        void vscode.window.showInformationMessage("markdown-studio: open a markdown-studio preview first.");
        return;
      }

      const fileUri = target.document.uri;
      if (!hasSnapshot(fileUri)) {
        void vscode.window.showInformationMessage(
          "markdown-studio: no snapshot yet — use \"Send to agent\" or \"Copy for chat\" first to set the before-state."
        );
        return;
      }

      const title = `Agent changes: ${path.basename(target.document.fileName)}`;
      await vscode.commands.executeCommand("vscode.diff", snapshotUriFor(fileUri), fileUri, title);
    }
  );

  const textDocumentChangeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
    PreviewPanel.current?.handleTextDocumentChange(event.document);
  });

  const activeEditorChangeSubscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
    PreviewPanel.current?.handleActiveEditorChange(editor);
  });

  const themeChangeSubscription = vscode.window.onDidChangeActiveColorTheme(() => {
    PreviewPanel.current?.handleThemeChange();
  });

  // ── Editor → Preview scroll sync ─────────────────────────────────────────
  let visibleRangesTimer: NodeJS.Timeout | undefined;

  const visibleRangesSubscription = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
    const panel = PreviewPanel.current;
    if (!panel) {
      return;
    }

    // Only act when the event concerns the document currently tracked by the panel.
    if (event.textEditor.document.uri.toString() !== panel.currentDocumentUri) {
      return;
    }

    if (visibleRangesTimer) {
      clearTimeout(visibleRangesTimer);
    }

    visibleRangesTimer = setTimeout(() => {
      visibleRangesTimer = undefined;
      const ranges = event.textEditor.visibleRanges;
      if (ranges.length > 0) {
        panel.syncPreviewToLine(ranges[0].start.line);
      }
    }, 50);
  });

  context.subscriptions.push(
    customEditorProvider,
    openInStudioCommand,
    openPreviewCommand,
    exportHtmlCommand,
    exportPdfCommand,
    copyHtmlCommand,
    sendToAgentCommand,
    copyForChatCommand,
    reviewChangesCommand,
    snapshotProviderRegistration,
    textDocumentChangeSubscription,
    activeEditorChangeSubscription,
    themeChangeSubscription,
    visibleRangesSubscription
  );
}

export function deactivate(): void {
  // Intentionally empty. VS Code disposes subscriptions automatically.
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
