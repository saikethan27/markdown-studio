import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "saikethan.markdown-studio";

const EXPECTED_COMMANDS = [
  "claudeMarkdownPreview.openInStudio",
  "claudeMarkdownPreview.openPreview",
  "claudeMarkdownPreview.exportHtml",
  "claudeMarkdownPreview.exportPdf",
  "claudeMarkdownPreview.copyHtml",
  "claudeMarkdownPreview.sendToAgent",
  "claudeMarkdownPreview.copyCommentsForChat",
  "claudeMarkdownPreview.reviewChanges"
];

suite("Extension activation & contributions", () => {
  test("extension is present and activates", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found — check publisher.name in package.json`);
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  test("registers all contributed commands", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    await ext!.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const command of EXPECTED_COMMANDS) {
      assert.ok(commands.includes(command), `command not registered: ${command}`);
    }
  });

  test("declares the custom editor for markdown", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const editors = ext!.packageJSON?.contributes?.customEditors ?? [];
    const viewTypes = editors.map((e: { viewType: string }) => e.viewType);
    assert.ok(viewTypes.includes("claudeMarkdownPreview.customEditor"));
  });
});
