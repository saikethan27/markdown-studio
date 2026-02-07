# Claude UI Markdown Viewer

VS Code extension that previews Markdown files in a Claude-style webview experience.

## Features

- Custom preview command: `Claude Markdown: Open Preview`
- Live content updates while editing Markdown
- VS Code light/dark theme sync
- Enhanced markdown support:
  - Syntax-highlighted code blocks (`highlight.js`)
  - Task lists
  - Footnotes
  - KaTeX math
  - Mermaid diagrams
- Link handling:
  - `http/https/mailto` open externally
  - Relative `.md` links open in editor and retarget the preview
  - Relative image/asset paths resolve in webview

## Configuration

- `claudeMarkdownPreview.autoUpdateDebounceMs` (default `150`)
- `claudeMarkdownPreview.enableMermaid` (default `true`)
- `claudeMarkdownPreview.enableMath` (default `true`)
- `claudeMarkdownPreview.enableTaskLists` (default `true`)
- `claudeMarkdownPreview.enableFootnotes` (default `true`)

## Development

1. Install dependencies:
   - `npm install`
2. Build:
   - `npm run compile`
3. Run extension in development:
   - Press `F5` in VS Code to launch an Extension Development Host.

## Usage

1. Open a Markdown file.
2. Run command palette action:
   - `Claude Markdown: Open Preview`
3. Keep editing the Markdown file and watch the preview refresh automatically.

## Notes

- Raw HTML in markdown is disabled (`markdown-it` with `html: false`) for safer rendering.
- v1 intentionally excludes scroll-sync, PDF export, and custom-editor replacement.
