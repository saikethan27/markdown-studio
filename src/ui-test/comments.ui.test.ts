import * as assert from "assert";
import * as path from "path";
import { By, EditorView, VSBrowser, WebDriver, WebView, Workbench } from "vscode-extension-tester";

/**
 * Level 4 — verifies inline comments render as bubbles inside the real preview
 * webview, end to end (C0 render path through the actual message bridge).
 */

const COMMENTED = path.resolve("src", "test", "fixtures", "test-workspace", "commented.md");

describe("Inline comment bubbles in the webview (UI)", function () {
  let driver: WebDriver;

  before(async function () {
    this.timeout(120000);
    driver = VSBrowser.instance.driver;
    await VSBrowser.instance.openResources(COMMENTED);
  });

  after(async function () {
    this.timeout(30000);
    await new EditorView().closeAllEditors();
  });

  it("renders an @ms-comment marker as a comment bubble (not raw text)", async function () {
    this.timeout(120000);
    await new Workbench().executeCommand("markdown-studio: Open Preview to the Side");

    const view = new WebView();
    await view.switchToFrame(30000);
    try {
      const bubbleText = await driver.wait(async () => {
        const bodies = await view.findWebElements(By.css(".md-comment .md-comment__body"));
        if (bodies.length > 0) {
          return bodies[0].getText();
        }
        return undefined;
      }, 30000, "comment bubble never rendered in the webview");

      assert.match(bubbleText as string, /Mention the Windows path here too/);

      // The instruction block must be consumed — never shown as raw text.
      const content = await view.findWebElement(By.css("#content"));
      const rawContent = await content.getText();
      assert.doesNotMatch(rawContent, /ms-comment-instructions/);
    } finally {
      await view.switchBack();
    }
  });
});
