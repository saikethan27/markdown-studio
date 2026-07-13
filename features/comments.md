# markdown-studio — Inline Comments / Annotations

A plan for letting users **add comments to a Markdown document from the preview
UI**, have those comments **persist inside the `.md` file itself**, **re-render
them visually** in the preview, and — because they live in the file's bytes —
have them **travel automatically to any LLM / agent tool** (Claude Code, Cursor,
Copilot, a pasted chat, …) that reads the file. The agent applies each requested
change and **deletes the comment as it goes**; the user then **reviews the delta**
with a native before/after diff and iterates.

Legend: **P0** = foundational / do first · **P1** = core feature · **P2** = polish.

---

## Guiding principle

> **The file is the database — and the whole protocol.** A comment is a marked
> HTML comment written into the `.md` next to the block it annotates. HTML
> comments are invisible to every normal Markdown renderer (GitHub, etc.), they
> round-trip cleanly, and they are plain text — so when the file is referenced by
> **any** agent, the comment is read *in place, next to the relevant paragraph*.
> No sidecar files, no extension database, no tool-specific integration. The
> extension only ever **writes** comments, **renders** them, and **watches** the
> file — it never needs to know *which* tool edited it.

### Why this approach (and not the alternatives)

| Approach | Persists in file? | Reaches any agent? | Invisible to normal readers? | Verdict |
|---|---|---|---|---|
| **Inline HTML-comment markers** (chosen) | ✅ | ✅ (it's file text) | ✅ | **Use this** |
| VS Code Comments API (gutter threads) | ❌ (extension state) | ❌ | ✅ | Nice UI, but disqualified — won't travel |
| Frontmatter array w/ line refs | ✅ | ⚠️ (detached from text, weak context) | ✅ | Line numbers drift; poor locality |
| Sidecar `*.comments.json` | ✅ (separate file) | ⚠️ (only if also referenced) | ✅ | Doesn't auto-attach to the `.md` |

### Tool-agnostic by design

Nothing here shells out to a specific CLI or depends on a specific model. The
comment markers + one instruction block make the file **self-explanatory to any
agent**. For file-aware agents (Claude Code, Cursor, Copilot-in-editor) the
comments travel for free when the file is referenced; for chat-only tools
(ChatGPT / Claude.ai web) a **"Copy for chat"** command emits the same comments as
a paste-ready prompt (see Phase C5). One source of truth, dispatch anywhere.

---

## Storage format

One comment = one **single-line, plain-text** HTML comment placed **immediately
after the block it annotates**:

```markdown
## Installation

Run the setup script before first use.
<!-- @ms-comment:c1 Mention the Windows path here too — the setup script differs on Windows. -->
```

### Why single-line plain text (not JSON)

The earlier draft used a JSON payload
(`{"id":"c1","author":"Raj","ts":"…","text":"…","resolved":false}`). We switched
to the lean form above because it wins on every axis that matters here:

- **LLM legibility** — it reads like a margin note, not a data structure. The
  agent sees the instruction directly; no tokens wasted on braces / metadata that
  have nothing to do with the task.
- **Perfect anchoring for free** — the marker sits *immediately after the block
  it's about*. LLMs reliably read "the note right after this paragraph is about
  this paragraph." No line numbers, no character offsets (both drift and corrupt).
- **Reliable cleanup** — deleting **one whole line** matching `@ms-comment:` is
  the single easiest, most reliable edit for *any* agent, weak or strong. A
  multi-line JSON blob is a multi-line delete = more ways to get it wrong.
- **Still machine-parseable** by the extension with one regex (below).
- **Invisible** to GitHub / normal renderers (it's still an HTML comment). ✅

### Format spec

```
<!-- @ms-comment:ID TEXT -->
```

- **`@ms-comment:` prefix** makes markers cheap to detect and namespaced so they
  never collide with ordinary HTML comments.
- **`ID`** — short, opaque, unique (e.g. `c1`, `c2`, or a short random token).
  Used by the extension to edit/delete a specific comment; never rely on line
  numbers, which drift.
- **`TEXT`** — free plain text, the literal instruction to the agent. May carry a
  trailing ` —Author` by convention; the renderer shows it verbatim, no special
  parsing required.
- **Anchoring is block/line granularity**, not character ranges. "This comment
  belongs to the block above the marker" is robust across edits; the marker
  physically following the block *is* the anchor.
- **No `resolved` field.** In a tool-agnostic world, "resolved" *is* "the marker
  got deleted." Keep the format minimal (see Phase C2).

### Parse regex

```
^<!--\s*@ms-comment:(\S+)\s+([\s\S]*?)\s*-->$
```

Group 1 = `ID`, group 2 = `TEXT`.

### Escaping / normalization rules (on write)

- **Collapse to a single physical line** — replace internal newlines/tabs with a
  space so the marker stays one line (this is what makes the agent's delete a
  clean one-line delete).
- **Escape a literal `-->`** in the user's text (would terminate the HTML comment
  early) → replace `-->` with `--&gt;`; reverse on read.
- **Strip/normalize control chars** before writing.

---

## LLM instruction block (auto-appended)

So any agent knows what to *do* with the comments — and, crucially, **cleans them
up when done** — append **one instruction block at the bottom of the file**,
added once and removed automatically when the last comment is gone. This block is
the entire protocol spec; different models interpret vague instructions
differently, so it is explicit, ordered, and has a fallback.

### The block

```markdown
<!-- @ms-comment-instructions
The `@ms-comment:` lines in this file are review comments from the author. Each
one refers to the Markdown block directly above it. For each comment:
  1. Apply the requested change to that block.
  2. Delete that comment's `@ms-comment:` line.
Once no `@ms-comment:` lines remain, delete this instruction block too.
If a comment can't be applied, keep its line and append "  [skipped: <reason>]".
-->
```

Why each line earns its place:

- **"refers to the block directly above it"** — states the anchoring rule so the
  agent never guesses which text a comment targets.
- **Numbered apply → delete** — couples the edit and the cleanup so removal
  happens *per comment*, not as a forgotten final step.
- **"delete this block when none remain"** — the file returns to a clean,
  comment-free state on its own.
- **`[skipped: <reason>]`** — the escape hatch. A weak agent that can't do
  something leaves a visible trail (which surfaces in the preview and the review
  diff) instead of silently dropping the request.

### Placement & lifecycle: one block, at the bottom, inserted once

- **One block, not one-per-comment.** The instruction is *global* ("for every
  `@ms-comment:`, do X"), so it appears exactly once. Repeating it after each
  comment bloats the file, wastes tokens, and risks copies drifting — don't.
- **Idempotent add.** On *add comment*, search for `@ms-comment-instructions`; if
  absent, append it at the bottom; if present, do nothing. (Effectively: it
  appears when the **first** comment is created.)
- **Auto-remove.** On *delete comment*, after removing the marker, if **no**
  `@ms-comment:` markers remain, also remove the instruction block — the file
  returns to a clean, comment-free state.
- **Match by tag, never by line number** (same rule as the comments themselves).
- **Bottom, not top.** Top would collide with YAML frontmatter (`---` must be
  byte 0) and shove line 1 down (breaking `data-line` offsets and diffs). Bottom
  reads like a footer and never disturbs the document.

### Why this self-satisfies the "remove after updating" requirement

The block *is* the cleanup instruction. When the file reaches the agent, it reads
the block, edits the document to address each comment, deletes each
`@ms-comment:` marker as it goes, and on the last one deletes the block too — so
the comments disappear once the request is satisfied, with no extra state on our
side. The instruction block is itself an HTML comment, so it's invisible to
normal renderers and suppressed in the preview (the C0 render rule treats
`@ms-comment-instructions` like any other marker — never shown as raw text).

**Robustness note (any tool):** not every agent cleans up perfectly. The
single-line marker makes deletion as easy as possible, and the human is the
backstop — leftover markers stay visible in the preview and the review diff, and
can be deleted from the UI (Phase C2). Never assume the agent cleaned up; let the
file's actual state drive the UI.

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
       └───────────────────────────────────  │  the .md file  │ ◄─── any agent
              markdownRenderer.ts parses      └───────┬────────┘      edits & self-cleans
              @ms-comment: markers ──────────────────┘  │
                                                         │ file change
                                                         ▼
                                       preview auto-refreshes (existing engine)
                                       + "Review changes" diff vs. send-time snapshot
```

Key constraints:

- **The webview cannot edit the file.** All writes go through the host via
  `vscode.WorkspaceEdit` (the host owns the `TextDocument`). The webview only
  *requests* changes and *renders* results. Mirrors the existing
  `setDefaultEditor` / `saveTheme` message pattern in
  [CustomEditorProvider.ts](src/preview/CustomEditorProvider.ts) and
  [PreviewPanel.ts](src/preview/PreviewPanel.ts).
- **The preview *is* the review view.** When the agent edits the file (on disk or
  via WorkspaceEdit), the existing `onDidChangeTextDocument` → `scheduleRender()`
  path re-renders automatically. No separate "agent manager" panel is needed —
  addressed comments vanish (markers deleted), skipped ones stay visible.
- **The extension never detects "who edited."** VS Code doesn't tag changes with
  provenance, and we don't need it. The review diff is "everything since Send"
  (see Phase C5), which reads naturally as "what the agent did."

---

## Phase C0 — Parse & render markers (P0 foundation)

Make existing `@ms-comment:` markers show up as comment widgets (read-only path
first; authoring comes in C1).

> **Current renderer note:** [markdownRenderer.ts:171](src/render/markdownRenderer.ts#L171)
> runs with `html: false`, so an unhandled marker renders as **raw escaped text**.
> The core rule below is what turns it into a bubble — it must consume the token.

### Tasks
1. In [markdownRenderer.ts](src/render/markdownRenderer.ts), add a `core.ruler`
   rule (run **after** block parsing, before render) that:
   - Scans tokens for `html_block` / `html_inline` whose content matches
     `^<!--\s*@ms-comment:(\S+)\s+([\s\S]*?)\s*-->$`.
   - Extracts `id` (group 1) and `text` (group 2); replaces the token with a
     custom `ms_comment` token carrying that data, and sets `token.map` from the
     marker's line so it inherits a `data-line`.
   - On no match, leaves ordinary comments alone. There is no JSON to fail on —
     any `@ms-comment:` line with a non-empty id + text is valid.
   - Also matches `@ms-comment-instructions` and consumes it silently (never
     rendered).
2. Add a renderer rule for `ms_comment` that emits:
   ```html
   <aside class="md-comment" data-comment-id="c1" data-line="N">
     <div class="md-comment__body">…HTML-escaped text…</div>
     <div class="md-comment__actions">…edit / delete buttons…</div>
   </aside>
   ```
   (HTML-escape `text`; never inject raw. Any trailing ` —Author` is just part of
   the escaped text and displays verbatim.)
3. Confirm the marker is **not** double-emitted as text regardless of the
   markdown-it `html` setting — the core rule must consume it in both `html:false`
   (current) and `html:true` modes.

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
2. Webview posts a new message: `{ type: "addComment", line: N, text }`.
3. **Message protocol** — extend both hosts:
   - Add `AddCommentMessage`, `UpdateCommentMessage`, `DeleteCommentMessage`
     interfaces.
   - Add the new `type`s to the `IncomingWebviewMessage` union **and** to
     `isIncomingMessage()` in [CustomEditorProvider.ts](src/preview/CustomEditorProvider.ts)
     and [PreviewPanel.ts](src/preview/PreviewPanel.ts).
4. **Write to file** — new shared module `src/preview/comments.ts`:
   - `addComment(document, line, text)` → compute the insert position (end of the
     block that starts at `line`; find the next blank line / next block start),
     normalize + escape the text (single line, escape `-->`), build the marker
     `<!-- @ms-comment:ID TEXT -->`, apply a `vscode.WorkspaceEdit`.
   - In the **same** `WorkspaceEdit`, `ensureInstructionBlock(document)` —
     idempotently append the LLM instruction block at the bottom if the file has
     no `@ms-comment-instructions` tag yet.
   - Generate `id` (short counter/token; `Date.now()` is fine in the extension
     host — the "no `Date.now()`" rule only applies inside workflow scripts).
   - Optional attribution: append ` —<name>` from `git config user.name` /
     `claudeMarkdownPreview.commentAuthor` if set (off by default — keep it lean).
5. The existing `onDidChangeTextDocument` → `scheduleRender()` path re-renders
   automatically, so the new bubble appears with no extra wiring.

### Verify
- Click a paragraph → add "fix this" → the `.md` gains a single-line marker on the
  right line → the preview shows the bubble → undo (Ctrl+Z) removes it cleanly.

---

## Phase C2 — Manage comments (P1)

No `resolved` state — **resolving a comment = deleting its marker** (which is
exactly what an agent does when it addresses one). This keeps the on-disk format
minimal and the semantics unambiguous for any tool.

### Tasks
1. **Delete**: remove the marker line via `WorkspaceEdit`, matched by `id` (find
   the line whose `@ms-comment:ID` matches — never by line number). In the same
   edit, if no `@ms-comment:` markers remain afterward, also remove the
   `@ms-comment-instructions` block so the file returns to a clean state.
2. **Edit**: re-open the composer prefilled with the current text; rewrite the
   marker in place (same `id`), re-applying the normalize/escape rules.
3. Both are host-side functions in `comments.ts`, keyed by comment `id`.
4. **Manual cleanup of leftovers**: because some agents won't self-clean, deleting
   a stale marker from the preview is the human backstop — same delete path.
5. **Reply / threads (optional, P2)**: multiple consecutive markers can share an
   anchor block; render them stacked.

---

## Phase C3 — Display & navigation (P1)

### Tasks
1. **Placement**: render bubbles inline beneath the block (start inline — simpler;
   a right-hand gutter aligned to `data-line` is a P2 upgrade). Style entirely
   from `theme.css` tokens (add `--comment-*` tokens: bg, border, text, actions).
2. **Anchor highlight**: on hover/click of a bubble, highlight the associated
   block (lookup by `data-line`, reuse the scroll/`data-line` plumbing already in
   [preview.js](media/preview.js)).
3. **Comment count** in the header (next to word count / reading time in the
   `RenderPayload`), and a header toggle to show/hide all comments.
4. **Round-trip progress (ties into C5)**: after an agent run, the header can show
   "N of M comments resolved" — derived by comparing the current marker set with
   the send-time snapshot's marker set (see C5). Purely a count; no panel.
5. **Jump list (optional)**: a comments pane in the TOC sidebar listing all
   comments with click-to-scroll.

---

## Phase C4 — Settings & export (P1)

### Tasks
1. **Settings panel** (extend [settingsPanel.ts](src/preview/settingsPanel.ts)):
   - Toggle **Show comments** (`claudeMarkdownPreview.showComments`, default `true`).
   - Toggle **Include comments in export** (default `false`).
   - Optional **Default author name** (`claudeMarkdownPreview.commentAuthor`,
     default empty = no attribution).
2. **Config** in [package.json](package.json): add the settings above under
   `contributes.configuration`.
3. **Export**: comments are chrome — hide `.md-comment` in the print media query
   in [claude-base.css](media/claude-base.css) and in the export overrides in
   [extension.ts](src/extension.ts) (the `exportHtml` inline `<style>` block),
   unless "Include comments in export" is on.

---

## Phase C5 — Agent handoff & review loop (P1, tool-agnostic)

The comments already travel for free (they're in the file) and the auto-appended
instruction block tells any agent to address each comment and self-clean the
markers — so the round-trip works with **no tool-specific integration**. This
phase adds the two conveniences that make it feel like a real review loop:
a **second dispatch channel** for chat-only tools, and a **before/after diff** so
the user can clearly review what changed.

### Task 1 — "Copy for chat" (covers chat-only tools)

File-aware agents (Claude Code, Cursor, Copilot-in-editor) read the `.md`
directly. Chat-only tools (ChatGPT / Claude.ai web) can't open the file — so add
command `claudeMarkdownPreview.copyCommentsForChat`:

- Builds a paste-ready prompt from the current markers: the document body plus a
  compact "Address these review comments and return the full edited document:"
  digest (each item = id + a short quoted anchor from the block above it + the
  comment text).
- Same source of truth (`@ms-comment:` markers) as the in-file channel — author
  once, dispatch anywhere.

### Task 2 — Snapshot-on-send + native diff review (the review loop)

The preview auto-refreshes when the file changes, so the user *sees* the new
state. To make "what did the agent change?" **clear**, add a local before/after
checkpoint using VS Code's built-in diff — **no custom diff UI, no panel**.

- **On send** (a `claudeMarkdownPreview.sendToAgent` / "Copy for chat" action):
  freeze the text → `snapshots.set(uri.toString(), document.getText())`. This is
  the "before" anchor; it's frozen and unaffected by later edits.
- **`claudeMarkdownPreview.reviewChanges` command**: register a
  `TextDocumentContentProvider` on a scheme like `ms-snapshot:` that returns the
  stashed string, then
  `vscode.commands.executeCommand('vscode.diff', snapshotUri, fileUri, 'Agent changes')`.
  VS Code renders its native red/green side-by-side diff.

**Timing / behavior (important):**
- The diff is **pull, not push** — it opens **only** when the user clicks "Review
  changes." Typing does **not** trigger it; saving does **not** trigger it. (Live
  preview refresh on edit is a *separate*, existing path.) This avoids keystroke
  races and flicker while the agent is mid-edit.
- The diff compares **snapshot (before) vs. the live file now (after)** — it never
  asks *who* changed it. It reads naturally as "what the agent did," because the
  snapshot still **has** the markers and the current file has them **removed** +
  the edits applied. User hand-edits made *while waiting* also appear — acceptable.
- **Zero-code fallback:** the file is git-tracked, so VS Code's built-in "Open
  Changes" already diffs against `HEAD`. Downside: it shows *all* uncommitted
  changes, not just "since Send" — less precise for the loop. The snapshot
  (~30–50 lines, in-memory `Map` + a content provider) gives the exact before/after
  boundary and is the recommended path.

### Task 3 — README

Document in [README.md](README.md): "comments are stored as plain HTML comments;
any agent that reads the file (or the *Copy for chat* prompt) sees them, applies
the changes, and deletes them — then use *Review changes* to see the diff."

---

## Message protocol additions (summary)

Incoming (webview → host):

| `type` | payload | host action |
|---|---|---|
| `addComment` | `{ line, text }` | insert single-line marker after block, ensure instruction block, re-render |
| `updateComment` | `{ id, text }` | rewrite marker by id |
| `deleteComment` | `{ id }` | remove marker line by id; remove instruction block if none remain |
| `revealComment` | `{ id }` | scroll editor to marker (optional) |

Commands (host, palette / buttons): `sendToAgent` (snapshot),
`reviewChanges` (diff vs. snapshot), `copyCommentsForChat` (digest prompt).

Outgoing (host → webview): comments ride inside the existing **render payload**
(parsed into `ms_comment` widgets by the renderer) — no new outbound message
needed for display. `commentAuthor` can piggyback on `settingsState`.

---

## Edge cases & risks

- **`-->` in user text** → escape on write (`--&gt;`), restore on read.
- **Multi-line user input** → collapse to a single physical line on write, so the
  marker stays one line and stays a clean one-line delete for the agent.
- **Marker drift on edit**: anchor by *position in file* (marker follows block).
  Edit/delete match by `id`, never by line number.
- **Two comments on the same block**: allowed — consecutive markers; render stacked.
- **Agent didn't clean up** (left a marker, or missed the instruction block): the
  file's actual state drives the UI — leftover markers stay visible and can be
  deleted from the preview. Never assume cleanup happened.
- **Agent used `[skipped: …]`**: the marker stays with its reason visible in the
  bubble and the diff — the user re-comments or deletes.
- **markdown-it `html` setting**: the core rule must consume the marker token in
  both `html:true` and `html:false` (current) modes so it never leaks as text.
- **Live typing**: marker insert is one `WorkspaceEdit`; debounced render already
  handles rapid changes. The review diff is manual (pull), so typing never
  triggers it.
- **Export round-trip**: hidden by default so PDFs/HTML don't leak notes.
- **Undo/redo**: all writes are `WorkspaceEdit`s, so native undo works — no
  separate undo stack.

---

## Testing

Extend [test/markdownRenderer.test.js](test/markdownRenderer.test.js):
1. A `@ms-comment:c1 …` marker renders an `<aside class="md-comment">` with
   escaped text and the correct `data-line` (and not as raw text under `html:false`).
2. A marker with `text` containing `-->` and quotes round-trips (escape → render →
   unescape) without breaking; a multi-line input collapses to one line on write.
3. An ordinary HTML comment (no `@ms-comment:` prefix) is left untouched.
4. `@ms-comment-instructions` is consumed and never rendered as visible text.
5. `showComments=false` / export mode suppresses `.md-comment`.
6. `comments.ts`: `addComment` inserts a single-line marker at the right line;
   `deleteComment` removes only the matching `id`; `updateComment` rewrites text
   in place keeping the same `id`.
7. Instruction-block lifecycle: first `addComment` appends exactly one
   `@ms-comment-instructions` block at the bottom; a second `addComment` does
   **not** add a duplicate; deleting the **last** comment also removes the block.
8. Review loop: after a snapshot is taken, `reviewChanges` diffs the frozen
   snapshot against current content (removed markers + edited blocks show as the
   delta).

---

## Suggested build order

1. **C0** — parse + render the single-line markers (read path). Smallest
   end-to-end proof; note the `html:false` consume requirement.
2. **C1** — authoring via `WorkspaceEdit` (write path) + idempotent instruction
   block. Now it's a real feature that travels to any agent.
3. **C3** — display/navigation polish (inline bubbles + anchor highlight + count).
4. **C2** — edit / delete management (delete = resolve).
5. **C5** — "Copy for chat" digest + snapshot-on-send + "Review changes" diff.
6. **C4** — settings toggles + export suppression + README.

**MVP = C0 + C1 + minimal C3** (add a comment, see it, and it's in the file for
any agent). Adding **C5's snapshot-diff** early makes the review loop feel real.
Everything else is refinement.
