import { defineConfig } from "@vscode/test-cli";

// Level 2 — integration tests run inside a real (downloaded) VS Code instance.
// `files` points at COMPILED output (src/test/*.ts → out/test/*.js via tsc).
export default defineConfig({
  files: "out/test/**/*.test.js",
  version: "stable",
  workspaceFolder: "./src/test/fixtures/test-workspace",
  mocha: {
    ui: "tdd",
    timeout: 60000
  },
  // Isolate from the developer's other installed extensions; the extension
  // under test is always loaded regardless of this flag.
  launchArgs: ["--disable-extensions"]
});
