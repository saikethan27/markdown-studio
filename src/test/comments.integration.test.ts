import * as assert from "assert";
import * as vscode from "vscode";
import { addComment, deleteComment, listComments, updateComment } from "../preview/comments";

/**
 * Level 2 — exercises the comment editing operations against the REAL vscode
 * WorkspaceEdit / applyEdit pipeline on real TextDocuments (the unit tests only
 * simulate applyEdit with a mock).
 */

async function markdownDoc(content: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument({ content, language: "markdown" });
}

suite("comments.ts against the real WorkspaceEdit pipeline", () => {
  test("addComment inserts a single-line marker glued after the block + instruction block", async () => {
    const doc = await markdownDoc("# Title\n\nRun the setup script.\n");
    const ok = await addComment(doc, 2, "Mention Windows here");
    assert.strictEqual(ok, true);

    const lines = doc.getText().split("\n");
    assert.strictEqual(lines[3], "<!-- @ms-comment:c1 Mention Windows here -->");
    assert.strictEqual(listComments(doc).length, 1);
    assert.match(doc.getText(), /@ms-comment-instructions/u);
  });

  test("a second addComment does not duplicate the instruction block", async () => {
    const doc = await markdownDoc("Para one.\n\nPara two.\n");
    await addComment(doc, 0, "fix one");
    await addComment(doc, 2, "fix two");

    const instrCount = (doc.getText().match(/@ms-comment-instructions/gu) || []).length;
    assert.strictEqual(instrCount, 1);
    assert.deepStrictEqual(listComments(doc).map((c) => c.id), ["c1", "c2"]);
  });

  test("deleteComment removes only the matching id", async () => {
    const doc = await markdownDoc("A.\n\nB.\n");
    await addComment(doc, 0, "first");
    await addComment(doc, 2, "second");

    const ok = await deleteComment(doc, "c1");
    assert.strictEqual(ok, true);
    const remaining = listComments(doc);
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, "c2");
    assert.match(doc.getText(), /@ms-comment-instructions/u);
  });

  test("deleting the last comment also removes the instruction block (no overlap error)", async () => {
    const doc = await markdownDoc("Only para.\n");
    await addComment(doc, 0, "note");
    assert.match(doc.getText(), /@ms-comment-instructions/u);

    const ok = await deleteComment(doc, "c1");
    assert.strictEqual(ok, true, "delete must not throw on overlapping ranges");
    assert.doesNotMatch(doc.getText(), /@ms-comment:/u);
    assert.doesNotMatch(doc.getText(), /@ms-comment-instructions/u);
    assert.match(doc.getText(), /Only para\./u);
  });

  test("updateComment rewrites text in place keeping the same id", async () => {
    const doc = await markdownDoc("Para.\n");
    await addComment(doc, 0, "old text");
    await updateComment(doc, "c1", "brand new text");

    const parsed = listComments(doc);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, "c1");
    assert.strictEqual(parsed[0].text, "brand new text");
  });

  test("escapes a literal --> and collapses multi-line input", async () => {
    const doc = await markdownDoc("Para.\n");
    await addComment(doc, 0, "use --> carefully\nsecond line");

    const marker = doc.getText().split("\n").find((l) => l.includes("@ms-comment:"));
    assert.ok(marker);
    assert.match(marker!, /<!-- @ms-comment:c1 use --&gt; carefully second line -->/u);
    // Round-trips back to the literal text on read.
    assert.strictEqual(listComments(doc)[0].text, "use --> carefully second line");
  });
});
