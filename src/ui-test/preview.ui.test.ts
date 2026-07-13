import * as assert from "assert";
import * as path from "path";
import {
  By,
  EditorView,
  Notification,
  NotificationType,
  VSBrowser,
  WebDriver,
  WebView,
  Workbench
} from "vscode-extension-tester";

/**
 * Level 3/4 — drives a real VS Code window the way a human would: opens a
 * markdown file, launches the preview, and reads what is actually rendered in
 * the webview + the real notification text.
 */

const SAMPLE = path.resolve("src", "test", "fixtures", "test-workspace", "sample.md");

describe("markdown-studio preview (UI)", function () {
  let driver: WebDriver;

  before(async function () {
    this.timeout(120000);
    driver = VSBrowser.instance.driver;
    await VSBrowser.instance.openResources(SAMPLE);
  });

  after(async function () {
    this.timeout(30000);
    await new EditorView().closeAllEditors();
  });

  it("renders the document inside the preview webview", async function () {
    this.timeout(120000);
    await new Workbench().executeCommand("markdown-studio: Open Preview to the Side");

    const view = new WebView();
    await view.switchToFrame(30000);
    try {
      await driver.wait(async () => {
        const headings = await view.findWebElements(By.css("#content h1, #content h2"));
        for (const heading of headings) {
          if ((await heading.getText()).includes("Sample Document")) {
            return true;
          }
        }
        return false;
      }, 30000, "preview webview never rendered the document heading");
    } finally {
      // CRITICAL: leave the iframe before touching any VS Code chrome again.
      await view.switchBack();
    }
  });

  it("Copy Rendered HTML shows a confirmation notification", async function () {
    this.timeout(60000);
    const workbench = new Workbench();
    await workbench.executeCommand("markdown-studio: Copy Rendered HTML");

    const notification = (await driver.wait(async () => {
      const center = await workbench.openNotificationsCenter();
      const items = await center.getNotifications(NotificationType.Info);
      for (const item of items) {
        if (/copied/i.test(await item.getMessage())) {
          return item;
        }
      }
      return undefined;
    }, 20000, "no 'copied' notification appeared")) as Notification;

    assert.match(await notification.getMessage(), /copied/i);
  });
});
