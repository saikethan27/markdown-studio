# markdown-studio

A polished Markdown preview for VS Code — a webview rendering experience with
syntax-highlighted code, diagrams, an outline sidebar, scroll sync, theming, and
export. All styling is driven by a single CSS token layer, so re-theming is easy.

## Features

### Two ways to view
- **Open with markdown-studio** — custom editor for `.md` / `.markdown` files (right-click a file → *Open With…* → `markdown-studio`, or the editor title-bar button).
- **Open Preview to the Side** — side-by-side preview next to the text editor (`Ctrl+Alt+M`, or the command palette).
- Live content updates while you edit.

### Rendering
- **Syntax-highlighted code blocks** (`highlight.js`) with a **language badge**, a **copy button**, and an optional **line-number gutter** (`showLineNumbers`).
- **GFM alerts / admonitions** — `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]` render as styled callouts.
- **Heading anchors** — slugged `id`s with a hover `#` link; click any in-page anchor to smooth-scroll.
- **YAML front matter** rendered as a metadata table (`enableFrontmatter`).
- **Emoji shortcodes** — `:rocket:` → 🚀 (`enableEmoji`).
- **Task lists**, **footnotes**, and **KaTeX math**.
- **Word count + reading time** shown in the header.

### Diagrams & media
- **Mermaid** diagrams (`enableMermaid`) — theme-aware, with **inline pan & zoom** (scroll to zoom, drag to pan, zoom/reset controls).
- **PlantUML** diagrams (`enablePlantuml`, off by default) for `plantuml` / `puml` fences, rendered via a configurable PlantUML server.
- **Lightbox** — click an image or PlantUML diagram to open a zoom/pan overlay.

### Navigation
- **Outline / Table of Contents** sidebar — nested headings, click-to-jump, scrollspy highlighting, and a collapse toggle (state persists).
- **Collapsible headings** — fold/unfold any section from its heading, plus a **Collapse All / Expand All** toolbar button.
- **Two-way scroll sync** between the editor and the preview (`scrollSync`).
- **Double-click** any rendered block to jump to its source line.
- **Find in preview** — `Ctrl+F` searches and highlights within the rendered content.
- **Edit** button to open the underlying source document.

### Appearance & theming
- VS Code **light / dark** sync.
- **Theme style** — `claude` (warm built-in palette) or `github` (`theme` setting).
- **Font-size zoom** (`Ctrl+=` / `Ctrl+-` / `Ctrl+0`, or header buttons) and **reading-width** control (Narrow / Normal / Wide / Full).
- **Single source of truth styling** — every color, width, font, size, and spacing value is a CSS custom property defined in [`media/theme.css`](media/theme.css). Override those tokens via **`customCssPath`** to re-theme the preview without touching extension files.

### Export & share
- **Export to HTML** — standalone file with inlined styles.
- **Print / Export to PDF** — opens the print dialog (choose *Save as PDF*).
- **Copy rendered HTML** to the clipboard.

### Inline comments & agent review loop
- **Comment on any block** — hover a block and click the **＋** margin button (or a
  comment's *Edit*) to write a review note. Comments render as inline bubbles in
  the preview.
- **The file is the database.** Each comment is stored as a plain single-line HTML
  comment written right after the block it annotates:
  `<!-- @ms-comment:c1 your note -->`. It's invisible to GitHub and every normal
  Markdown renderer, and it round-trips as plain text.
- **Travels to any agent.** Because comments live in the file's bytes, any tool that
  reads the `.md` (Claude Code, Cursor, Copilot-in-editor, …) sees them in place. A
  one-time instruction block is appended at the bottom telling the agent to apply
  each change and **delete the marker as it goes** — so addressed comments simply
  vanish. Deleting the last comment removes the instruction block too.
- **Copy for chat** — for chat-only tools (ChatGPT / Claude.ai web) that can't open
  the file, *Copy Comments for Chat* builds a paste-ready prompt (document body + a
  digest of the comments).
- **Review changes** — *Send to Agent* / *Copy for Chat* snapshots the file first;
  after the agent edits it, *Review Changes* opens VS Code's native before/after
  diff so you can see exactly what changed.
- Resolve a comment by clicking **Resolve** (deletes its marker) — the same edit an
  agent makes when it addresses one. All writes are `WorkspaceEdit`s, so **undo/redo**
  works. Comments are hidden from HTML/PDF export by default (`includeCommentsInExport`).

### Link handling
- `http` / `https` / `mailto` open externally.
- Relative `.md` links open in the editor and retarget the preview.
- Relative image / asset paths resolve inside the webview.

## Commands

| Command | Title |
| --- | --- |
| `claudeMarkdownPreview.openInStudio` | Open with markdown-studio (editor title-bar button) |
| `claudeMarkdownPreview.openPreview` | Open Preview to the Side |
| `claudeMarkdownPreview.exportHtml` | Export to HTML |
| `claudeMarkdownPreview.exportPdf` | Print / Export to PDF |
| `claudeMarkdownPreview.copyHtml` | Copy Rendered HTML |
| `claudeMarkdownPreview.sendToAgent` | Send to Agent (snapshot for review) |
| `claudeMarkdownPreview.copyCommentsForChat` | Copy Comments for Chat |
| `claudeMarkdownPreview.reviewChanges` | Review Changes (diff vs. snapshot) |

## Keyboard shortcuts

| Shortcut | Action | When |
| --- | --- | --- |
| `Ctrl+Alt+M` | Open Preview to the Side | editing a Markdown file |
| `Ctrl+F` | Find in preview | preview focused |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset | preview focused |

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `claudeMarkdownPreview.autoUpdateDebounceMs` | `150` | Debounce (ms) for live preview updates. |
| `claudeMarkdownPreview.enableMermaid` | `true` | Render Mermaid diagrams for `mermaid` fences. |
| `claudeMarkdownPreview.enableMath` | `true` | Render KaTeX math expressions. |
| `claudeMarkdownPreview.enableTaskLists` | `true` | GitHub-style task list checkboxes. |
| `claudeMarkdownPreview.enableFootnotes` | `true` | Markdown footnote syntax. |
| `claudeMarkdownPreview.showLineNumbers` | `false` | Show a line-number gutter in code blocks. |
| `claudeMarkdownPreview.scrollSync` | `true` | Sync scroll position between editor and preview. |
| `claudeMarkdownPreview.enableFrontmatter` | `true` | Render YAML front matter as a metadata table. |
| `claudeMarkdownPreview.enableEmoji` | `true` | Render emoji shortcodes (`:rocket:` → 🚀). |
| `claudeMarkdownPreview.theme` | `"claude"` | Visual theme style: `claude` or `github`. |
| `claudeMarkdownPreview.customCssPath` | `""` | Path to a custom CSS file loaded last (absolute or workspace-relative). Override tokens to re-theme. |
| `claudeMarkdownPreview.enablePlantuml` | `false` | Render PlantUML diagrams (`plantuml` / `puml` fences) via a server. |
| `claudeMarkdownPreview.plantumlServerUrl` | `"https://www.plantuml.com/plantuml"` | PlantUML server base URL. Diagram text is sent to this server; requires network access. |
| `claudeMarkdownPreview.showComments` | `true` | Render inline review comments (`@ms-comment:` markers) as bubbles. |
| `claudeMarkdownPreview.includeCommentsInExport` | `false` | Include comment bubbles in HTML/PDF export. |
| `claudeMarkdownPreview.commentAuthor` | `""` | Optional author appended to new comments as `—Name`. |

## Custom theming

Because all visual values are CSS custom properties in [`media/theme.css`](media/theme.css)
(colors, `--content-max-width`, `--font-size-base`, the `--text-*` scale, `--leading-*`,
spacing, and `--hl-*` syntax colors), you can fully re-theme the preview by pointing
`customCssPath` at a file that redefines those tokens — for example:

```css
/* my-theme.css */
body.theme-light {
  --primary: #6c4ad6;
  --content-max-width: 1100px;
  --font-sans: "Inter", system-ui, sans-serif;
}
```

## Usage

1. Open a Markdown file.
2. Either:
   - Right-click the file tab/explorer item → **Open With…** → `markdown-studio`, or
   - Run **markdown-studio: Open Preview to the Side** (`Ctrl+Alt+M`).
3. Keep editing — the preview refreshes automatically.

## Development

1. Install dependencies: `npm install`
2. Build: `npm run compile` (watch with `npm run watch`)
3. Test: `npm test`
4. Run in an Extension Development Host: press `F5`.
5. Package: `npx @vscode/vsce package`

## Notes

- Raw HTML in markdown is disabled (`markdown-it` with `html: false`) for safer rendering.
- **PlantUML** is opt-in because diagram text is sent to an external server.
- Exported standalone HTML inlines the CSS; **Mermaid** diagrams are left as source in the export (they need the in-app script to render).
