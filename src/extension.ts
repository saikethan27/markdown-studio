import * as vscode from "vscode";
import { CustomEditorProvider } from "./preview/CustomEditorProvider";
import { PreviewPanel } from "./preview/PreviewPanel";

function isMarkdownDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
  return document?.languageId === "markdown";
}

export function activate(context: vscode.ExtensionContext): void {
  const customEditorProvider = CustomEditorProvider.register(context);

  const openPreviewCommand = vscode.commands.registerCommand("claudeMarkdownPreview.openPreview", () => {
    const activeEditor = vscode.window.activeTextEditor;

    if (!isMarkdownDocument(activeEditor?.document)) {
      void vscode.window.showInformationMessage("markdown-studio: open a Markdown file first.");
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
    customEditorProvider,
    openPreviewCommand,
    textDocumentChangeSubscription,
    activeEditorChangeSubscription,
    themeChangeSubscription
  );
}

export function deactivate(): void {
  // Intentionally empty. VS Code disposes subscriptions automatically.
}
