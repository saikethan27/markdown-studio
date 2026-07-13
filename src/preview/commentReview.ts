import * as vscode from "vscode";

/**
 * Snapshot-on-send + native diff review (features/comments.md, Phase C5).
 *
 * On "send" (copy-for-chat / send-to-agent) we freeze the document text as the
 * "before" anchor. "Review changes" then opens VS Code's built-in diff between
 * that frozen snapshot and the live file — no custom diff UI. The diff is pull,
 * not push: it opens only when the user asks, so typing/saving never trigger it.
 */

export const SNAPSHOT_SCHEME = "ms-snapshot";

/** Frozen "before" text, keyed by the original document uri string. */
const snapshots = new Map<string, string>();

const onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

/** Content provider that serves the frozen snapshot text under `ms-snapshot:`. */
export const snapshotContentProvider: vscode.TextDocumentContentProvider = {
  onDidChange: onDidChangeEmitter.event,
  provideTextDocumentContent(uri: vscode.Uri): string {
    // The original uri string is carried in the query (see snapshotUriFor).
    return snapshots.get(uri.query) ?? "";
  }
};

/** Freeze the current text of `document` as the review "before" anchor. */
export function takeSnapshot(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  snapshots.set(key, document.getText());
  // Invalidate any diff already showing this snapshot so a re-send refreshes it.
  onDidChangeEmitter.fire(snapshotUriFor(document.uri));
}

/** Whether a snapshot exists for `uri`. */
export function hasSnapshot(uri: vscode.Uri): boolean {
  return snapshots.has(uri.toString());
}

/** The `ms-snapshot:` uri that maps back to `originalUri`'s frozen text. */
export function snapshotUriFor(originalUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.from({
    scheme: SNAPSHOT_SCHEME,
    path: originalUri.path,
    query: originalUri.toString()
  });
}
