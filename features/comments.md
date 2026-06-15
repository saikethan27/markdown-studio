# markdown-studio — Inline Comments / Annotations

A plan for letting users **add comments to a Markdown document from the preview
UI**, have those comments **persist inside the `.md` file itself**, **re-render
them visually** in the preview, and — because they live in the file's bytes —
have them **travel automatically to Claude Code** (or any tool that reads the
file) when the document is referenced.

Legend: **P0** = foundational / do first · **P1** = core feature · **P2** = polish.

---

## Guiding principle

> **The file is the database.** A comment is a marked HTML comment written into
> the `.md` next to the block it annotates. HTML comments are invisible to every
> normal Markdown renderer (GitHub, etc.), they round-trip cleanly, and they are
> plain text — so when the file is `@`-referenced in Claude Code, the comment is
> read *in place, next to the relevant paragraph*. No sidecar files, no extension
> database, no extra channel to wire up.

### Why this approach (and not the alternatives)

| Approach | Persists in file? | Reaches Claude Code? | Invisible to normal readers? | Verdict |
|---|---|---|---|---|
| **Inline HTML-comment markers** (chosen) | ✅ | ✅ (it's file text) | ✅ | **Use this** |
| VS Code Comments API (gutter threads) | ❌ (extension state) | ❌ | ✅ | Nice UI, but disqualified — won't travel |
| Frontmatter array w/ line refs | ✅ | ⚠️ (detached from text, weak context) | ✅ | Line numbers drift; poor locality |
| Sidecar `*.comments.json` | ✅ (separate file) | ⚠️ (only if also referenced) | ✅ | Doesn't auto-attach to the `.md` |

---

## Storage format

One comment = one single-line HTML comment placed **immediately after the block
it annotates**:

```markdown
## Installation

Run the setup script before first use.
<!-- @ms-comment {"id":"c1","author":"Raj","ts":"2026-06-15T10:20:00Z","text":"Mention the Windows path here too","resolved":false} -->
```

- **Marker prefix** `@ms-comment` makes markers cheap to detect and namespaced
  so they never collide with ordinary HTML comments.
- **Payload is JSON** for forward-compatibility (add fields without breaking the
  parser). Required: `id`, `text`. Optional: `author`, `ts`, `resolved`,
  `anchorText`.
- **Anchoring is block/line granularity**, not character ranges. "This comment
  belongs to the block at source line N" is robust across edits; exact character
  offsets drift and corrupt. The marker physically following the block *is* the
  anchor.

### Escaping rules
- User text containing `-->` would terminate the HTML comment early → on write,
  replace `-->` with `--​>` (zero-width space) or escape to `--&gt;`;
  reverse on read.
- JSON-encode the `text` field (handles quotes, newlines, backslashes).
- Strip/normalize control chars before writing.

---

## LLM instruction block (auto-appended)

So Claude Code knows what to *do* with the comments, append a **single
instruction block at the bottom of the file** — added once, and removed
automatically when the last comment is gone.

### The block (the default message — keep it exactly this short)

```markdown
<!-- @ms-comment-instructions
These @ms-comment notes are user review comments. For each, apply the requested
change and delete its marker; when none remain, delete this block too.
-->
```

### Placement & lifecycle: one block, at the bottom, inserted once

- **One block, not one-per-comment.** The instruction is *global* ("for every
  `@ms-comment`, do X"), so it appears exactly once. Repeating it after each
  comment bloats the file, wastes LLM tokens, clutters the raw source, and risks
  copies drifting out of sync — don't.
- **Idempotent add.** On *add comment*, search the file for
  `@ms-comment-instructions`; if absent, append it at the bottom; if present, do
  nothing. (Effectively: it appears when the **first** comment is created.)
- **Auto-remove.** On *delete comment*, after removing the marker, if **no**
  `@ms-comment` markers remain, also remove the instruction block — the file
  returns to a clean, comment-free state.
- **Match by tag, never by line number** (same rule as the comments themselves).
- **Bottom, not top.** Top would collide with YAML frontmatter (`---` must be
  byte 0) and shove line 1 down (breaking `data-line` offsets and diffs). Bottom
  reads like a footer and never disturbs the document; for the LLM, position
  barely matters.

### Why this self-satisfies the "remove after updating" requirement

The block *is* the cleanup instruction. When the file reaches Claude Code, it
reads the block, edits the document to address each comment, deletes each
`@ms-comment` marker as it goes, and on the last one deletes the block too — so
the comments disappear once the request is satisfied, with no extra state on our
side. The instruction block is itself an HTML comment, so it's invisible to
normal renderers and suppressed in the preview (the C0 render rule treats
`@ms-comment-instructions` like any other marker — never shown as raw text).

---

## Architecture & data flow

```
┌─────────────┐  addComment(line,text)   ┌────────────────────────┐
│  preview.js │ ───────────────────────► │  Host (PreviewPanel /  │
│  (webview)  │ ◄─────────────────────── │  CustomEditorProvider) │
└─────────────┘   render payload incl.   └───────────┬────────────┘
       ▲          comment widgets                    │ WorkspaceEdit
       │                                              ▼
       │ renders <aside class="md-comment">   ┌────────────────┐
       └───────────────────────────────────  │  the .md file  │
              markdownRenderer.ts parses      └────────────────┘
              @ms-comment markers ──────────────────┘  (Claude Code reads this)
```

Key constraint: **the webview cannot edit the file.** All writes go through the
host via `vscode.WorkspaceEdit` (the host owns the `TextDocument`). The webview
only *requests* changes and *renders* results. This mirrors the existing
`setDefaultEditor` / `saveTheme` message pattern already in
[CustomEditorProvider.ts](src/preview/CustomEditorProvider.ts) and
[PreviewPanel.ts](src/preview/PreviewPanel.ts).

---

## Phase C0 — Parse & render markers (P0 foundation)

Make existing `@ms-comment` markers show up as comment widgets (read-only path
first; authoring comes in C1).

### Tasks
1. In [markdownRenderer.ts](src/render/markdownRenderer.ts), add a `core.ruler`
   rule (run **after** block parsing, before render) that:
   - Scans tokens for `html_block` / `html_inline` whose content matches
     `^<!--\s*@ms-comment\s*(\{.*\})\s*-->$`.
   - Parses the JSON; on success replaces the token with a custom
     `ms_comment` token carrying the parsed data, and sets `token.map` from the
     marker's line so it inherits a `data-line`.
   - On parse failure, drops the marker silently (never render raw JSON).
2. Add a renderer rule for `ms_comment` that emits:
   ```html
   <aside class="md-comment" data-comment-id="c1" data-line="N" data-resolved="false">
     <div class="md-comment__meta"><span class="md-comment__author">Raj</span>
       <time class="md-comment__time">2026-06-15</time></div>
     <div class="md-comment__body">…escaped text…</div>
     <div class="md-comment__actions">…resolve / delete buttons…</div>
   </aside>
   ```
   (HTML-escape `text`; never inject raw.)
3. Confirm the marker is **not** double-emitted as text regardless of the
   markdown-it `html` setting — the core rule must consume it.

### Verify
- A file containing a hand-written marker renders a bubble, not raw text, in both
  hosts; on GitHub the same file shows nothing.

---

## Phase C1 — Authoring from the UI (P0)

### Tasks
1. **Trigger UI** in [preview.js](media/preview.js): on a block (an element with
   `data-line`), show an "Add comment" affordance — a margin "＋" button on hover,
   or a context-menu entry. Selecting it opens a small composer (reuse the modal
   pattern from [settingsPanel.ts](src/preview/settingsPanel.ts) or an inline
   popover anchored to the block).
2. Webview posts a new message: `{ type: "addComment", line: N, text, anchorText? }`.
3. **Message protocol** — extend both hosts:
   - Add `AddCommentMessage`, `UpdateCommentMessage`, `DeleteCommentMessage`,
     `ResolveCommentMessage` interfaces.
   - Add the new `type`s to the `IncomingWebviewMessage` union **and** to
     `isIncomingMessage()` in [CustomEditorProvider.ts](src/preview/CustomEditorProvider.ts)
     and [PreviewPanel.ts](src/preview/PreviewPanel.ts).
4. **Write to file** — new shared module `src/preview/comments.ts`:
   - `addComment(document, line, text, author)` → compute the insert position
     (end of the block that starts at `line`; find the next blank line / next
     block start), build the marker, apply a `vscode.WorkspaceEdit`.
   - In the **same** `WorkspaceEdit`, `ensureInstructionBlock(document)` —
     idempotently append the LLM instruction block at the bottom if the file has
     no `@ms-comment-instructions` tag yet (see "LLM instruction block" above).
   - Generate `id` (timestamp + counter; avoid `Date.now()` only inside workflow
     scripts — here in extension host it's fine).
   - `author` from `git config user.name` fallback to OS user or `"You"`.
5. After the edit, the existing `onDidChangeTextDocument` → `scheduleRender()`
   path re-renders automatically, so the new bubble appears with no extra wiring.

### Verify
- Click a paragraph → add "fix this" → the `.md` gains a marker on the right line
  → the preview shows the bubble → undo (Ctrl+Z) removes it cleanly.

---

## Phase C2 — Manage comments (P1)

### Tasks
1. **Resolve / unresolve**: toggles `"resolved"` in the marker JSON (a
   `WorkspaceEdit` that rewrites that one comment line, matched by `id`).
   Resolved comments render dimmed / collapsed.
2. **Edit**: re-open the composer prefilled; rewrite the marker.
3. **Delete**: remove the marker line via `WorkspaceEdit`. In the same edit, if
   no `@ms-comment` markers remain afterward, also remove the
   `@ms-comment-instructions` block so the file returns to a clean state.
4. All three are host-side functions in `comments.ts`, keyed by comment `id`
   (find the line whose JSON `id` matches — don't rely on line numbers, they
   drift).
5. **Reply / threads (optional, P2)**: store `parentId` in the JSON and nest
   bubbles; multiple markers can share an anchor block.

---

## Phase C3 — Display & navigation (P1)

### Tasks
1. **Placement**: render bubbles in a right-hand margin gutter aligned to their
   `data-line`, or inline beneath the block (start inline — simpler; gutter is a
   P2 upgrade). Style entirely from `theme.css` tokens (add `--comment-*` tokens:
   bg, border, author color, resolved opacity).
2. **Anchor highlight**: on hover/click of a bubble, highlight the associated
   block (lookup by `data-line`, reuse the scroll/`data-line` plumbing already in
   [preview.js](media/preview.js)).
3. **Comment count** in the header (next to word count / reading time in the
   `RenderPayload`), and a header toggle to show/hide all comments.
4. **Jump list (optional)**: a comments pane in the TOC sidebar listing all
   comments with click-to-scroll.

---

## Phase C4 — Settings & export (P1)

### Tasks
1. **Settings panel** (extend the panel built in
   [settingsPanel.ts](src/preview/settingsPanel.ts)):
   - Toggle **Show comments** (`claudeMarkdownPreview.showComments`, default
     `true`).
   - Toggle **Include comments in export** (default `false`).
   - Default author name (`claudeMarkdownPreview.commentAuthor`).
2. **Config** in [package.json](package.json): add the three settings above under
   `contributes.configuration`.
3. **Export**: comments are chrome — hide `.md-comment` in the print media query
   in [claude-base.css](media/claude-base.css) and in the export overrides in
   [extension.ts](src/extension.ts) (the `exportHtml` inline `<style>` block),
   unless "Include comments in export" is on.

---

## Phase C5 — Claude Code handoff (P1)

The comments already travel for free (they're in the file), and the
auto-appended **LLM instruction block** (see above) tells Claude Code to address
each comment and self-clean the markers — so the round-trip works with no special
integration. This phase adds *convenience*, not capability.

### Tasks
1. **Command** `claudeMarkdownPreview.copyForClaude`: copies the document body
   plus a compact "Open comments:" digest (id, anchor heading, text) to the
   clipboard, ready to paste into Claude Code.
2. **Command** `claudeMarkdownPreview.openInClaudeCode` (best-effort): if the
   Claude Code extension/CLI is available, hand off the file path; otherwise fall
   back to copy + an info message. (Investigate available integration points
   before committing to an API — keep it behind capability detection.)
3. Document in [README.md](README.md): "comments are stored as HTML comments and
   are visible to Claude Code when you `@`-mention the file."

---

## Message protocol additions (summary)

Incoming (webview → host):

| `type` | payload | host action |
|---|---|---|
| `addComment` | `{ line, text }` | insert marker after block, re-render |
| `updateComment` | `{ id, text }` | rewrite marker by id |
| `resolveComment` | `{ id, resolved }` | toggle resolved in marker |
| `deleteComment` | `{ id }` | remove marker line |
| `revealComment` | `{ id }` | scroll editor to marker (optional) |

Outgoing (host → webview): comments ride inside the existing **render payload**
(parsed into `ms_comment` widgets by the renderer) — no new outbound message
needed for display. A `commentAuthor` field can piggyback on `settingsState`.

---

## Edge cases & risks

- **`-->` in user text** → escape on write, restore on read (see Storage format).
- **Marker drift on edit**: anchor by *position in file* (marker follows block).
  Resolve/delete/edit match by `id`, never by line number.
- **Two comments on the same block**: allowed — consecutive markers; render
  stacked.
- **Malformed / hand-edited JSON**: parser drops the marker silently; never
  render raw JSON or crash the render.
- **markdown-it `html` setting**: the core rule must consume the marker token in
  both `html: true` and `html: false` modes so it never leaks as visible text.
- **Live typing**: marker insert is one `WorkspaceEdit`; debounced render already
  handles rapid changes.
- **Export round-trip**: ensure hidden by default so PDFs/HTML don't leak notes.
- **Undo/redo**: because all writes are `WorkspaceEdit`s, native undo works — no
  separate undo stack.

---

## Testing

Extend [test/markdownRenderer.test.js](test/markdownRenderer.test.js):
1. A `@ms-comment` marker renders an `<aside class="md-comment">` with escaped
   text and the correct `data-line`.
2. A marker with `text` containing `-->` and quotes round-trips (escape → render
   → unescape) without breaking.
3. Malformed JSON marker renders nothing (no raw text, no throw).
4. `showComments=false` / export mode suppresses `.md-comment`.
5. `comments.ts`: `addComment` inserts at the right line; `deleteComment` removes
   only the matching `id`; `resolveComment` flips the flag in place.
6. Instruction block lifecycle: first `addComment` appends exactly one
   `@ms-comment-instructions` block at the bottom; a second `addComment` does
   **not** add a duplicate; deleting the **last** comment also removes the block;
   the block is never rendered as visible text.

---

## Suggested build order

1. **C0** — parse + render markers (read path). Smallest end-to-end proof.
2. **C1** — authoring via `WorkspaceEdit` (write path). Now it's a real feature.
3. **C3** — display/navigation polish (inline bubbles + anchor highlight).
4. **C2** — resolve / edit / delete management.
5. **C4** — settings toggles + export suppression.
6. **C5** — Claude Code convenience commands + README.

**MVP = C0 + C1 + minimal C3** (add a comment, see it, and it's in the file for
Claude Code). Everything after is refinement.
