# Testing markdown-studio

The suite follows the VS Code testing pyramid — many fast unit tests, a solid
band of integration tests against the real VS Code API, and a few high-value
end-to-end UI tests that drive a real window.

| Level | What it covers | Tool | Location | Command |
|---|---|---|---|---|
| 1. Unit | Pure logic: the markdown renderer + comment marker/parse/edit logic (vscode mocked) | `node --test` | `test/*.test.js` | `npm run test:unit` |
| 2. Integration | Real VS Code API: activation, command registration, `WorkspaceEdit` comment edits, the `ms-snapshot` content provider, configuration | `@vscode/test-cli` + `@vscode/test-electron` | `src/test/*.test.ts` | `npm run test:integration` |
| 3/4. UI + Webview | Human-like: opens a real window, launches the preview, reads what the webview actually renders + real notifications | `vscode-extension-tester` (ExTester) | `src/ui-test/*.test.ts` | `npm run test:ui` |

`npm test` runs level 1 (the fast default).

## Running each level

```bash
npm run test:unit         # milliseconds, no VS Code needed
npm run test:integration  # downloads a real VS Code the first time, ~seconds after
npm run test:ui           # downloads VS Code + ChromeDriver, packages the ext, drives it
```

Run fastest → slowest and fix failures at the lowest level first — a broken unit
test will cascade upward.

## What lives where

- **Level 1** (`test/markdownRenderer.test.js`, `test/comments.test.js`): the
  `@ms-comment:` core-ruler render path, escaping/round-trip, the instruction-block
  lifecycle, and the chat-digest builder. These mock `vscode` and require the
  compiled output in `out/`, so they run `npm run compile` first.
- **Level 2** (`src/test/`): `extension.test.ts` (activation + all 8 commands),
  `comments.integration.test.ts` (add/update/delete + instruction lifecycle against
  the **real** `WorkspaceEdit` pipeline — including the last-comment cleanup that
  must not produce overlapping edits), `review.integration.test.ts` (snapshot
  content provider end-to-end + comment settings). Fixtures live in
  `src/test/fixtures/test-workspace/`.
- **Level 3/4** (`src/ui-test/`): `preview.ui.test.ts` (the preview webview renders
  the document + `Copy Rendered HTML` notification), `comments.ui.test.ts` (an
  `@ms-comment` marker renders as a bubble in the real webview, and the instruction
  block is never shown raw).

## ExTester (UI) prerequisites & caveats

- UI tests need a **display**. On headless Linux/CI wrap with `xvfb-run -a`
  (the CI workflow does this).
- ExTester downloads a test VS Code + matching ChromeDriver into `test-resources/`
  (git-ignored, excluded from `tsc`/package).
- **Behind a corporate TLS proxy**, the ChromeDriver download can fail with
  `unable to get local issuer certificate`. Fix by pointing Node at your corporate
  root CA — do **not** disable TLS verification:
  ```bash
  NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem npm run test:ui
  ```
  On a normal network / CI this isn't needed.
- Pin the VS Code version in CI (`--code_version 1.xx.x`) for reproducibility;
  `max` is used locally to catch breakage early.

## CI

`.github/workflows/test.yml` runs unit on every push, integration on a
`ubuntu`/`windows`/`macos` matrix for PRs, and UI tests on PRs + nightly (Linux,
headless via `xvfb`), uploading failure screenshots as artifacts.
