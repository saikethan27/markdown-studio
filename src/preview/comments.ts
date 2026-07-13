import * as vscode from "vscode";

/**
 * Inline comments (see features/comments.md).
 *
 * The file is the database and the whole protocol: a comment is a single-line
 * HTML comment written into the `.md` immediately after the block it annotates:
 *
 *   <!-- @ms-comment:ID TEXT -->
 *
 * All writes go through `vscode.WorkspaceEdit` so native undo/redo works. Edits
 * and deletes match by `id`, never by line number (line numbers drift). The
 * first comment appends a global instruction block at the bottom of the file;
 * deleting the last comment removes it again, returning the file to a clean state.
 */

/** The auto-appended LLM instruction block. Kept verbatim — it is the protocol spec. */
export const INSTRUCTION_BLOCK = `<!-- @ms-comment-instructions
The \`@ms-comment:\` lines in this file are review comments from the author. Each
one refers to the Markdown block directly above it. For each comment:
  1. Apply the requested change to that block.
  2. Delete that comment's \`@ms-comment:\` line.
Once no \`@ms-comment:\` lines remain, delete this instruction block too.
If a comment can't be applied, keep its line and append "  [skipped: <reason>]".
-->`;

const INSTRUCTIONS_TAG = "@ms-comment-instructions";
const COMMENT_TAG = "@ms-comment:";

export interface ParsedComment {
  id: string;
  text: string;
  /** 0-based line index of the marker within the document. */
  line: number;
}

// ── Text normalization / escaping ──────────────────────────────────────────────

/**
 * Normalize a raw comment body for embedding in a single-line marker:
 *   1. collapse all internal whitespace (newlines/tabs included) to single spaces,
 *   2. strip any remaining control characters (NUL etc.), and
 *   3. escape a literal `-->` (which would terminate the HTML comment early).
 * Keeps the marker a clean one-line delete for any agent.
 */
export function escapeMarkerText(raw: string): string {
  return raw
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\p{Cc}/gu, "")
    .replace(/-->/gu, "--&gt;");
}

/** Reverse the `-->` escape for display / editing. */
export function unescapeCommentText(text: string): string {
  return text.replace(/--&gt;/gu, "-->");
}

function buildMarker(id: string, escapedText: string): string {
  return `<!-- ${COMMENT_TAG}${id} ${escapedText} -->`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Per-line matcher for a specific comment id (markers are always single-line). */
function markerLineRegExpFor(id: string): RegExp {
  return new RegExp(`^\\s*<!--\\s*@ms-comment:${escapeRegExp(id)}\\s+[\\s\\S]*?-->\\s*$`, "u");
}

/** Generic single-line marker matcher capturing id + text. */
const MARKER_CAPTURE_RE = /^\s*<!--\s*@ms-comment:(\S+)\s+([\s\S]*?)\s*-->\s*$/u;

// ── Parsing / queries ─────────────────────────────────────────────────────────

/** All comments in the document, in source order. Text is unescaped for display. */
export function listComments(document: vscode.TextDocument): ParsedComment[] {
  const comments: ParsedComment[] = [];
  const lineCount = document.lineCount;
  for (let i = 0; i < lineCount; i++) {
    const match = MARKER_CAPTURE_RE.exec(document.lineAt(i).text);
    if (match) {
      comments.push({ id: match[1], text: unescapeCommentText(match[2]), line: i });
    }
  }
  return comments;
}

/** True when at least one `@ms-comment:` marker exists in the text. */
export function hasComments(text: string): boolean {
  return text.includes(COMMENT_TAG);
}

/** A short quoted anchor: the nearest non-blank, non-marker line above `line`. */
function anchorSnippetAbove(document: vscode.TextDocument, line: number, maxLen = 60): string {
  for (let i = line - 1; i >= 0; i--) {
    const text = document.lineAt(i).text.trim();
    if (text === "" || MARKER_CAPTURE_RE.test(text) || text.includes(INSTRUCTIONS_TAG)) {
      continue;
    }
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  }
  return "";
}

/**
 * Build a paste-ready prompt for chat-only tools (ChatGPT / Claude.ai web) that
 * cannot open the file: the full document body plus a compact digest of the
 * review comments. Same source of truth (`@ms-comment:` markers) as the in-file
 * channel — author once, dispatch anywhere. Returns undefined if no comments.
 */
export function buildChatDigest(document: vscode.TextDocument): string | undefined {
  const parsed = listComments(document);
  if (parsed.length === 0) {
    return undefined;
  }

  const digest = parsed
    .map((c) => {
      const anchor = anchorSnippetAbove(document, c.line);
      const near = anchor ? ` near "${anchor}"` : "";
      return `- [${c.id}]${near}: ${c.text}`;
    })
    .join("\n");

  return [
    "Below is a Markdown document with inline review comments (the",
    "`<!-- @ms-comment:ID ... -->` lines). Apply each requested change to the block",
    "directly above its comment, delete that comment's line as you go, and return",
    "the full edited document.",
    "",
    "Review comments:",
    digest,
    "",
    "--- BEGIN DOCUMENT ---",
    document.getText(),
    "--- END DOCUMENT ---"
  ].join("\n");
}

/** Generate a short, unique, human-friendly id (c1, c2, …) for the document. */
function generateId(document: vscode.TextDocument): string {
  let max = 0;
  for (const comment of listComments(document)) {
    const numeric = /^c(\d+)$/u.exec(comment.id);
    if (numeric) {
      max = Math.max(max, parseInt(numeric[1], 10));
    }
  }
  return `c${max + 1}`;
}

/** Keys the settings panel is allowed to write (guards the generic message). */
const COMMENT_CONFIG_KEYS = new Set(["showComments", "includeCommentsInExport", "commentAuthor"]);

/** Update one comment-related setting globally (from the preview settings panel). */
export async function updateCommentConfig(key: string, value: boolean | string): Promise<void> {
  if (!COMMENT_CONFIG_KEYS.has(key)) {
    return;
  }
  await vscode.workspace
    .getConfiguration("claudeMarkdownPreview")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

/** Optional attribution suffix from configuration (empty by default). */
function attributionSuffix(): string {
  const author = vscode.workspace
    .getConfiguration("claudeMarkdownPreview")
    .get<string>("commentAuthor", "")
    .trim();
  return author ? ` —${author}` : "";
}

// ── Instruction-block lifecycle ────────────────────────────────────────────────

function findInstructionBlockRange(document: vscode.TextDocument): vscode.Range | undefined {
  const lineCount = document.lineCount;
  let openLine = -1;
  for (let i = 0; i < lineCount; i++) {
    if (document.lineAt(i).text.includes(INSTRUCTIONS_TAG)) {
      openLine = i;
      break;
    }
  }
  if (openLine === -1) {
    return undefined;
  }

  // The block is a multi-line HTML comment; find the line that closes it.
  let closeLine = openLine;
  for (let i = openLine; i < lineCount; i++) {
    if (document.lineAt(i).text.includes("-->")) {
      closeLine = i;
      break;
    }
  }

  // Also swallow blank lines immediately preceding the block (added on insert)
  // so removal leaves no dangling whitespace at the end of the file. Start the
  // range at the START of the first blank line (not the end of the line before
  // it) so it never overlaps a marker deletion that abuts this block — VS Code
  // rejects overlapping edits within one WorkspaceEdit.
  let startLine = openLine;
  while (startLine > 0 && document.lineAt(startLine - 1).text.trim() === "") {
    startLine -= 1;
  }

  const startPos = document.lineAt(startLine).range.start;
  const endPos = document.lineAt(closeLine).rangeIncludingLineBreak.end;
  return new vscode.Range(startPos, endPos);
}

/**
 * Idempotently append the instruction block at the bottom of the file if it is
 * not already present. Mutates the passed `WorkspaceEdit`.
 */
export function ensureInstructionBlock(edit: vscode.WorkspaceEdit, document: vscode.TextDocument): void {
  const text = document.getText();
  if (text.includes(INSTRUCTIONS_TAG)) {
    return;
  }

  const endPos = document.lineAt(document.lineCount - 1).range.end;

  // Guarantee a blank line before the footer block.
  let prefix: string;
  if (text.endsWith("\n\n")) {
    prefix = "";
  } else if (text.endsWith("\n")) {
    prefix = "\n";
  } else {
    prefix = "\n\n";
  }

  edit.insert(document.uri, endPos, `${prefix}${INSTRUCTION_BLOCK}\n`);
}

// ── Public editing operations ──────────────────────────────────────────────────

/**
 * Insert a comment marker on its own line immediately after the block that
 * starts at `line`, and (idempotently) ensure the instruction block exists —
 * both in a single WorkspaceEdit so undo reverts them together.
 */
export async function addComment(
  document: vscode.TextDocument,
  line: number,
  rawText: string
): Promise<boolean> {
  const escaped = escapeMarkerText(`${rawText}${attributionSuffix()}`);
  if (!escaped) {
    return false;
  }

  const id = generateId(document);
  const marker = buildMarker(id, escaped);

  const insertLine = blockEndLine(document, line);
  const insertPos = document.lineAt(insertLine).range.end;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, insertPos, `\n${marker}`);
  ensureInstructionBlock(edit, document);

  return vscode.workspace.applyEdit(edit);
}

/** Rewrite the marker for `id` in place, preserving the id. */
export async function updateComment(
  document: vscode.TextDocument,
  id: string,
  rawText: string
): Promise<boolean> {
  const escaped = escapeMarkerText(rawText);
  if (!escaped) {
    return false;
  }

  const lineRe = markerLineRegExpFor(id);
  const lineCount = document.lineCount;
  for (let i = 0; i < lineCount; i++) {
    const lineText = document.lineAt(i).text;
    if (lineRe.test(lineText)) {
      const indent = /^\s*/u.exec(lineText)?.[0] ?? "";
      const marker = buildMarker(id, escaped);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, document.lineAt(i).range, `${indent}${marker}`);
      return vscode.workspace.applyEdit(edit);
    }
  }
  return false;
}

/**
 * Delete the marker for `id`. If no `@ms-comment:` markers remain afterward,
 * also remove the instruction block — same WorkspaceEdit, so undo restores both.
 */
export async function deleteComment(document: vscode.TextDocument, id: string): Promise<boolean> {
  const lineRe = markerLineRegExpFor(id);
  const lineCount = document.lineCount;
  let targetLine = -1;
  for (let i = 0; i < lineCount; i++) {
    if (lineRe.test(document.lineAt(i).text)) {
      targetLine = i;
      break;
    }
  }
  if (targetLine === -1) {
    return false;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.delete(document.uri, document.lineAt(targetLine).rangeIncludingLineBreak);

  // Would any markers remain after this deletion? (Count all, minus the target.)
  const remaining = listComments(document).filter((c) => c.line !== targetLine).length;
  if (remaining === 0) {
    const blockRange = findInstructionBlockRange(document);
    if (blockRange) {
      edit.delete(document.uri, blockRange);
    }
  }

  return vscode.workspace.applyEdit(edit);
}

// ── Internals ──────────────────────────────────────────────────────────────────

/** Start of a list item (ordered or unordered), capturing its leading indent. */
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+/u;
/** Start of an ATX heading. */
const HEADING_RE = /^\s*#{1,6}\s+/u;

/**
 * The last line of the single block that starts at `startLine`. The marker is
 * glued right after this line so it sits immediately below the annotated block.
 *
 * A plain paragraph is a contiguous run of non-blank lines. A list item is the
 * item plus its continuation / nested children but NOT the next sibling item —
 * otherwise a "tight" list (bullets with no blank lines between them) would
 * collapse into one block and every comment would land at the list's end.
 */
function blockEndLine(document: vscode.TextDocument, startLine: number): number {
  const lineCount = document.lineCount;
  let line = Math.max(0, Math.min(startLine, lineCount - 1));

  // If the target line is itself blank, anchor to it (insert right after it).
  if (document.lineAt(line).text.trim() === "") {
    return line;
  }

  const listMatch = LIST_ITEM_RE.exec(document.lineAt(line).text);
  if (listMatch) {
    const markerIndent = listMatch[1].length;
    while (line + 1 < lineCount) {
      const next = document.lineAt(line + 1).text;
      if (next.trim() === "") {
        break;
      }
      const nextList = LIST_ITEM_RE.exec(next);
      // A sibling or shallower list item begins a new block; deeper (nested)
      // items and indented / lazy continuation lines belong to this item.
      if (nextList && nextList[1].length <= markerIndent) {
        break;
      }
      line += 1;
    }
    return line;
  }

  // Non-list block: contiguous non-blank lines, but a following list or heading
  // starts a new block even when no blank line separates them.
  while (line + 1 < lineCount) {
    const next = document.lineAt(line + 1).text;
    if (next.trim() === "" || LIST_ITEM_RE.test(next) || HEADING_RE.test(next)) {
      break;
    }
    line += 1;
  }
  return line;
}
