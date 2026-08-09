import * as fs from "node:fs";
import * as vscode from "vscode";

/**
 * Webview assets that are shipped as files rather than bundled into the
 * extension code: KaTeX's stylesheet (plus its font files) and the Mermaid
 * browser build.
 *
 * `npm run vendor` copies them out of node_modules into `media/vendor/`, which
 * lets the .vsix drop `node_modules` entirely. The node_modules location stays
 * as a fallback so a fresh source checkout works before the copy step has run.
 */

function firstExisting(
  extensionUri: vscode.Uri,
  vendored: string[],
  nodeModules: string[]
): string | undefined {
  const vendoredPath = vscode.Uri.joinPath(extensionUri, "media", "vendor", ...vendored).fsPath;
  if (fs.existsSync(vendoredPath)) {
    return vendoredPath;
  }

  const fallbackPath = vscode.Uri.joinPath(extensionUri, "node_modules", ...nodeModules).fsPath;
  return fs.existsSync(fallbackPath) ? fallbackPath : undefined;
}

/** Absolute path to katex.min.css, or undefined when it is not available. */
export function katexCssPath(extensionUri: vscode.Uri): string | undefined {
  return firstExisting(
    extensionUri,
    ["katex", "katex.min.css"],
    ["katex", "dist", "katex.min.css"]
  );
}

/** Absolute path to the Mermaid browser bundle, or undefined when unavailable. */
export function mermaidScriptPath(extensionUri: vscode.Uri): string | undefined {
  return firstExisting(
    extensionUri,
    ["mermaid", "mermaid.min.js"],
    ["mermaid", "dist", "mermaid.min.js"]
  );
}
