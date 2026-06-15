import * as vscode from "vscode";

/**
 * Helpers for registering markdown-studio as the default editor for Markdown
 * files. VS Code resolves the editor for a file via `workbench.editorAssociations`
 * (a map of glob pattern → editor view type). Pointing the markdown globs at our
 * custom editor makes it open automatically when a Markdown file is opened.
 */

const CUSTOM_EDITOR_VIEW_TYPE = "claudeMarkdownPreview.customEditor";
const MARKDOWN_GLOB_PATTERNS = ["*.md", "*.markdown"] as const;

type EditorAssociations = Record<string, string>;

function readAssociations(): EditorAssociations {
  return (
    vscode.workspace
      .getConfiguration("workbench")
      .get<EditorAssociations>("editorAssociations") ?? {}
  );
}

/** True when markdown-studio is the default editor for every Markdown glob. */
export function isDefaultMarkdownEditor(): boolean {
  const associations = readAssociations();
  return MARKDOWN_GLOB_PATTERNS.every(
    (pattern) => associations[pattern] === CUSTOM_EDITOR_VIEW_TYPE
  );
}

/**
 * Enable or disable markdown-studio as the default editor for *.md / *.markdown
 * by writing `workbench.editorAssociations` to the user (global) settings.
 *
 * Enabling points the markdown globs at our view type; disabling removes only
 * the entries we added, leaving any other associations the user configured intact.
 */
export async function setDefaultMarkdownEditor(enabled: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration("workbench");
  const current = config.get<EditorAssociations>("editorAssociations") ?? {};
  const next: EditorAssociations = { ...current };

  for (const pattern of MARKDOWN_GLOB_PATTERNS) {
    if (enabled) {
      next[pattern] = CUSTOM_EDITOR_VIEW_TYPE;
    } else if (next[pattern] === CUSTOM_EDITOR_VIEW_TYPE) {
      delete next[pattern];
    }
  }

  await config.update("editorAssociations", next, vscode.ConfigurationTarget.Global);
}
