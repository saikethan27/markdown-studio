import * as assert from "assert";
import * as vscode from "vscode";
import { updateCommentConfig } from "../preview/comments";
import {
  SNAPSHOT_SCHEME,
  hasSnapshot,
  snapshotContentProvider,
  snapshotUriFor,
  takeSnapshot
} from "../preview/commentReview";

const EXTENSION_ID = "saikethan.markdown-studio";

suite("Review loop (snapshot provider) & comment settings", () => {
  suiteSetup(async () => {
    // Ensure the extension registered its ms-snapshot content provider.
    await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
  });

  test("takeSnapshot freezes the before-text; provider serves it after later edits", async () => {
    const doc = await vscode.workspace.openTextDocument({
      content: "before edits\n",
      language: "markdown"
    });
    takeSnapshot(doc);
    assert.strictEqual(hasSnapshot(doc.uri), true);

    // Mutate the live document — the frozen snapshot must NOT change.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(doc.lineCount - 1, 0), "AFTER\n");
    await vscode.workspace.applyEdit(edit);

    const served = snapshotContentProvider.provideTextDocumentContent(
      snapshotUriFor(doc.uri),
      new vscode.CancellationTokenSource().token
    );
    assert.strictEqual(await served, "before edits\n");
  });

  test("the ms-snapshot scheme is registered end-to-end (openTextDocument)", async () => {
    const doc = await vscode.workspace.openTextDocument({
      content: "snapshot me\n",
      language: "markdown"
    });
    takeSnapshot(doc);

    const snapDoc = await vscode.workspace.openTextDocument(snapshotUriFor(doc.uri));
    assert.strictEqual(snapDoc.uri.scheme, SNAPSHOT_SCHEME);
    assert.strictEqual(snapDoc.getText(), "snapshot me\n");
  });

  test("updateCommentConfig writes recognized keys and ignores unknown ones", async () => {
    const cfg = () => vscode.workspace.getConfiguration("claudeMarkdownPreview");
    try {
      await updateCommentConfig("commentAuthor", "Raj");
      assert.strictEqual(cfg().get<string>("commentAuthor"), "Raj");

      await updateCommentConfig("showComments", false);
      assert.strictEqual(cfg().get<boolean>("showComments"), false);

      // Unknown keys are silently ignored (no throw, no write).
      await updateCommentConfig("totallyBogusKey", "x");
    } finally {
      await cfg().update("commentAuthor", undefined, vscode.ConfigurationTarget.Global);
      await cfg().update("showComments", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("reviewChanges is a no-op (not a throw) when no preview is active", async () => {
    // With no custom-editor/preview focused there is no target; the command
    // should return quietly rather than error.
    await vscode.commands.executeCommand("claudeMarkdownPreview.reviewChanges");
  });
});
