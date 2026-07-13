# markdown-studio — Feature Roadmap

A prioritized plan for the Markdown preview extension. Items are grouped into
phases. **Phase 0 (Theming Foundation)** and **Phase 1 (Source-Line Mapping)**
are foundations that unlock many later features — build them first.

Legend: **P0** = do first / foundational · **P1** = high value · **P2** = nice to have.

---

## Phase 0 — Single Source of Truth for Styling (P0)

> **Principle:** Everything visual lives in **one CSS token layer**. No
> component, renderer, or markdown rule hardcodes a color, width, font, size, or
> spacing value. Every rule references a `var(--token)`. Adding a custom theme
> later = overriding the token block, nothing else.

### Why now

Today the tokens are split and incomplete:

- Colors **are** tokenized in [claude-base.css](media/claude-base.css) (`:root`, `body.theme-light`, `body.theme-dark`) — good.
- **Width is hardcoded** — `max-width: 980px` in `.preview-main`.
- **Font sizes, line-heights, weights, and spacing are hardcoded** throughout [claude-markdown.css](media/claude-markdown.css) (`1.875rem`, `1.7`, `0.75rem`, …).
- **No syntax-highlight color tokens** — highlight.js emits `.hljs-keyword`, `.hljs-string`, etc., but no CSS colors them, so code blocks render almost monochrome. (This is the *real* gap behind the original "color & style by code type" goal.)
- Heavy `!important` usage makes drop-in custom CSS hard to override.

### Deliverable: `media/theme.css` — the one token file

Create a dedicated token file (the single source of truth), imported before all
other CSS. Every token defined once per theme. Categories:

```
/* Layout & width */
--content-max-width      /* replaces hardcoded 980px */
--content-padding
--page-padding

/* Font family */
--font-sans
--font-mono

/* Font size — base + type scale */
--font-size-base         /* root size, e.g. 16px; user-zoomable */
--text-body
--text-h1 … --text-h6
--text-code
--text-small

/* Typography — rhythm */
--leading-body           /* line-height for body */
--leading-heading
--leading-code
--weight-normal / --weight-semibold / --weight-bold
--letter-spacing-heading
--space-paragraph / --space-block / --space-section

/* Color (already present — keep here) */
--background --foreground --card --card-foreground
--primary --primary-foreground --secondary --muted --muted-foreground
--accent --accent-foreground --border --ring

/* Syntax highlighting (NEW) */
--hl-bg --hl-keyword --hl-string --hl-number --hl-comment
--hl-function --hl-variable --hl-type --hl-attr --hl-tag
--hl-operator --hl-meta --hl-deletion --hl-addition

/* Shape */
--radius --border-width
```

### Tasks

1. Create [media/theme.css](media/theme.css) with all tokens above, defined for `theme-light` and `theme-dark`.
2. Refactor [claude-base.css](media/claude-base.css) and [claude-markdown.css](media/claude-markdown.css) so **every** numeric/visual value references a `var(--token)` — no literals.
3. Add a `.hljs-*` color block driven entirely by the `--hl-*` tokens (this lights up code-block colors).
4. Reduce `!important` to only what's required to override injected KaTeX/Mermaid styles, so custom CSS can win.
5. Load `theme.css` first in both webview hosts ([PreviewPanel.ts](src/preview/PreviewPanel.ts), [CustomEditorProvider.ts](src/preview/CustomEditorProvider.ts)).

### Enables later (Phase 6)

- `claudeMarkdownPreview.theme` setting to switch built-in themes.
- `claudeMarkdownPreview.customCssPath` to point at a user token file.
- Font-size zoom = just bumping `--font-size-base`.
- Reading width control = just changing `--content-max-width`.

---

## Phase 1 — Source-Line Mapping (P0 foundation)

A markdown-it rule that stamps `data-line="N"` onto rendered block elements,
mapping each DOM node back to its source line in [markdownRenderer.ts](src/render/markdownRenderer.ts).

**This single foundation unlocks three roadmap items at once:**
- Table-of-contents click-to-jump (Phase 3)
- Two-way scroll sync (Phase 4)
- "Edit-mode optimization" — keep editor and preview at the same position (Phase 4)

### Tasks

1. Add a `core.ruler` / token-level rule that writes `token.map[0]` to a `data-line` attribute.
2. Post the current editor cursor/scroll position to the webview; webview reveals the matching `data-line`.
3. Post webview scroll position back so the editor can follow (custom-editor mode).

---

## Phase 2 — Code Block Upgrades (P1)

Builds on the `--hl-*` tokens from Phase 0. Original goal: *"give color and style
based on code type"* — partially done (highlight.js detects language); finish it.

- [ ] **Syntax colors** via `--hl-*` tokens — covers yaml, python, bash, json, ts/js, go, rust, etc. (highlight.js already detects the language at [markdownRenderer.ts:277](src/render/markdownRenderer.ts#L277)).
- [ ] **Language label badge** on each code block (top-right, reads from `language-*` class).
- [ ] **Copy button** per code block (copies raw source to clipboard).
- [ ] **Optional line numbers** (config toggle).

---

## Phase 3 — Outline / Table of Contents (P1)

Original goal: *"outline table of content"* — new, not yet built.

- [ ] Left panel listing all headings/subheadings with proper indentation.
- [ ] Show/hide toggle button.
- [ ] Click a heading → scroll to it (uses Phase 1 line mapping + heading anchors).
- [ ] Highlight the currently-visible heading as you scroll (scrollspy).
- [ ] Styled entirely from `theme.css` tokens (width, colors, spacing).

---

## Phase 4 — Navigation & Sync (P1/P2)

Original goal: *"edit mode optimization"* — keep edit and preview aligned.

- [ ] **Two-way scroll sync** (editor ↔ preview), using Phase 1 mapping. *(P1)*
- [ ] **Editor title-bar button + keybinding** to open the preview (`menus: editor/title` in [package.json](package.json)). The original "preview button in text editor" goal — `Open With…` already works, this adds a visible button. *(P1)*
- [ ] **Find in preview** (Ctrl+F search within rendered content). *(P2)*
- [ ] **Click rendered element → jump to source line** in the editor. *(P2)*

---

## Phase 5 — Content & Markdown Features (P1)

Quick, high-value rendering additions in [markdownRenderer.ts](src/render/markdownRenderer.ts).

- [ ] **GFM alerts / admonitions** — `> [!NOTE]`, `> [!WARNING]`, `> [!TIP]`, `[!IMPORTANT]`, `[!CAUTION]` callout boxes (styled via tokens).
- [ ] **Heading anchors** — hover `#` link icon, copyable deep links (also powers TOC).
- [ ] **YAML front-matter** rendered as a metadata table instead of being dropped/shown raw.
- [ ] **Emoji shortcodes** (`:rocket:`) via `markdown-it-emoji`.
- [ ] **Word count + reading time** in the header.

---

## Phase 6 — Theming & Appearance (P2)

Made trivial by Phase 0.

- [ ] `claudeMarkdownPreview.theme` setting — switch built-in themes (Claude / GitHub-flavored).
- [ ] `claudeMarkdownPreview.customCssPath` — point at a user token override file.
- [ ] **Font-size zoom** controls (bumps `--font-size-base`).
- [ ] **Reading width** control (changes `--content-max-width`).

---

## Phase 7 — Export & Share (P2)

README notes PDF was deferred from v1 — good candidate now.

- [ ] **Export to standalone HTML** (inlined `theme.css` + content).
- [ ] **Export / Print to PDF**.
- [ ] **Copy rendered HTML** to clipboard.

---

## Phase 8 — Diagrams & Media (P2)

- [ ] **Image & Mermaid zoom / pan** (lightbox).
- [ ] **PlantUML** support alongside Mermaid.

---

## Suggested build order

1. **Phase 0** — token layer (single source of truth). Everything else styles cleanly on top.
2. **Phase 1** — source-line mapping. Unlocks TOC jump + scroll sync + edit alignment.
3. **Phase 2** — code colors/badge/copy (immediately visible upgrade).
4. **Phase 3** — outline/TOC.
5. **Phase 4** — scroll sync + editor button.
6. **Phase 5** — alerts, anchors, front-matter, emoji, reading time.
7. **Phases 6–8** — theming, export, diagrams.
