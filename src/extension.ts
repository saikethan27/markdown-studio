import * as vscode from "vscode";
import { PreviewPanel } from "./preview/PreviewPanel";

function isMarkdownDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
  return document?.languageId === "markdown";
}

export function activate(context: vscode.ExtensionContext): void {
  const openPreviewCommand = vscode.commands.registerCommand("claudeMarkdownPreview.openPreview", () => {
    const activeEditor = vscode.window.activeTextEditor;

    if (!isMarkdownDocument(activeEditor?.document)) {
      void vscode.window.showInformationMessage("Claude Markdown Preview: open a Markdown file first.");
      return;
    }

    PreviewPanel.createOrShow(context, activeEditor.document);
  });

  const textDocumentChangeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
    PreviewPanel.current?.handleTextDocumentChange(event.document);
  });

  const activeEditorChangeSubscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
    PreviewPanel.current?.handleActiveEditorChange(editor);
  });

  const themeChangeSubscription = vscode.window.onDidChangeActiveColorTheme(() => {
    PreviewPanel.current?.handleThemeChange();
  });

  context.subscriptions.push(
    openPreviewCommand,
    textDocumentChangeSubscription,
    activeEditorChangeSubscription,
    themeChangeSubscription
  );
}

export function deactivate(): void {
  // Intentionally empty. VS Code disposes subscriptions automatically.
}
