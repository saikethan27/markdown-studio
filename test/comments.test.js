const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

// ── Minimal vscode mock (document + WorkspaceEdit + applyEdit) ─────────────────

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class Uri {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
  static file(p) {
    return new Uri("file://" + p);
  }
}

// Backing store for the single document under test, keyed by uri string.
const docRegistry = new Map();

class Doc {
  constructor(text, uri) {
    this.uri = uri;
    this._set(text);
    docRegistry.set(uri.toString(), this);
  }
  _set(text) {
    this._text = text;
    this._lines = text.split("\n");
  }
  get lineCount() {
    return this._lines.length;
  }
  getText() {
    return this._text;
  }
  lineAt(i) {
    const lineText = this._lines[i];
    const endPos = new Position(i, lineText.length);
    const inclEnd =
      i < this._lines.length - 1 ? new Position(i + 1, 0) : new Position(i, lineText.length);
    return {
      text: lineText,
      range: new Range(new Position(i, 0), endPos),
      rangeIncludingLineBreak: new Range(new Position(i, 0), inclEnd)
    };
  }
  offsetAt(pos) {
    let off = 0;
    for (let l = 0; l < pos.line; l++) {
      off += this._lines[l].length + 1; // +1 for the "\n"
    }
    return off + pos.character;
  }
}

class WorkspaceEdit {
  constructor() {
    this.ops = [];
  }
  insert(uri, pos, text) {
    this.ops.push({ uri, start: pos, end: pos, text });
  }
  replace(uri, range, text) {
    this.ops.push({ uri, start: range.start, end: range.end, text });
  }
  delete(uri, range) {
    this.ops.push({ uri, start: range.start, end: range.end, text: "" });
  }
}

let commentAuthor = "";

const mockVscode = {
  Position,
  Range,
  Uri,
  WorkspaceEdit,
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration() {
      return {
        get(key, dflt) {
          if (key === "commentAuthor") {
            return commentAuthor;
          }
          return dflt;
        }
      };
    },
    async applyEdit(edit) {
      const doc = docRegistry.get(edit.ops[0].uri.toString());
      const resolved = edit.ops.map((op) => ({
        start: doc.offsetAt(op.start),
        end: doc.offsetAt(op.end),
        text: op.text
      }));
      // Reject overlapping edits exactly as real VS Code does (touching is OK).
      const byStart = [...resolved].sort((a, b) => a.start - b.start);
      for (let i = 1; i < byStart.length; i++) {
        if (byStart[i].start < byStart[i - 1].end) {
          throw new Error("Overlapping ranges are not allowed in a WorkspaceEdit");
        }
      }
      // Apply from the highest offset down so earlier offsets stay valid.
      resolved.sort((a, b) => b.start - a.start);
      let text = doc.getText();
      for (const op of resolved) {
        text = text.slice(0, op.start) + op.text + text.slice(op.end);
      }
      doc._set(text);
      return true;
    }
  }
};

const originalLoad = Module._load;
Module._load = (request, parent, isMain) =>
  request === "vscode" ? mockVscode : originalLoad(request, parent, isMain);

const comments = require("../out/preview/comments");

function makeDoc(text) {
  return new Doc(text, Uri.file("/w/note-" + Math.random().toString(36).slice(2) + ".md"));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("addComment inserts a single-line marker glued after the block", async () => {
  commentAuthor = "";
  const doc = makeDoc("# Title\n\nRun the setup script.\n");
  // Line 2 = "Run the setup script."
  await comments.addComment(doc, 2, "Mention Windows here");

  const lines = doc.getText().split("\n");
  // Marker glued directly after line 2, on its own single line.
  assert.equal(lines[3], "<!-- @ms-comment:c1 Mention Windows here -->");
  // Exactly one real marker (the instruction block prose also mentions the tag).
  assert.equal(comments.listComments(doc).length, 1);
});

test("addComment on a tight-list bullet anchors to that bullet, not the list end", async () => {
  commentAuthor = "";
  const doc = makeDoc("## Sec\n\n- F-33 first\n- F-31 second\n- F-40 third\n");
  await comments.addComment(doc, 2, "note on first");

  const lines = doc.getText().split("\n");
  // Marker glued right after the first bullet, before its sibling — not the end.
  assert.equal(lines[3], "<!-- @ms-comment:c1 note on first -->");
  assert.equal(lines[4], "- F-31 second");
});

test("addComment on a middle bullet of a tight list anchors to that bullet", async () => {
  commentAuthor = "";
  const doc = makeDoc("- a\n- b\n- c\n");
  await comments.addComment(doc, 1, "on b");

  const lines = doc.getText().split("\n");
  assert.equal(lines[1], "- b");
  assert.equal(lines[2], "<!-- @ms-comment:c1 on b -->");
  assert.equal(lines[3], "- c");
});

test("addComment on a list item includes its wrapped continuation line", async () => {
  commentAuthor = "";
  const doc = makeDoc("- item one\n  continues here\n- item two\n");
  await comments.addComment(doc, 0, "note");

  const lines = doc.getText().split("\n");
  assert.equal(lines[1], "  continues here");
  assert.equal(lines[2], "<!-- @ms-comment:c1 note -->");
  assert.equal(lines[3], "- item two");
});

test("addComment on a paragraph stops before an immediately-following list", async () => {
  commentAuthor = "";
  const doc = makeDoc("Intro paragraph.\n- first\n- second\n");
  await comments.addComment(doc, 0, "para note");

  const lines = doc.getText().split("\n");
  assert.equal(lines[0], "Intro paragraph.");
  assert.equal(lines[1], "<!-- @ms-comment:c1 para note -->");
  assert.equal(lines[2], "- first");
});

test("first addComment appends exactly one instruction block; second does not duplicate", async () => {
  commentAuthor = "";
  const doc = makeDoc("Para one.\n\nPara two.\n");
  await comments.addComment(doc, 0, "fix one");
  await comments.addComment(doc, 2, "fix two");

  const text = doc.getText();
  const instrCount = (text.match(/@ms-comment-instructions/g) || []).length;
  assert.equal(instrCount, 1, "instruction block must appear exactly once");

  const markers = comments.listComments(doc);
  assert.equal(markers.length, 2);
  assert.deepEqual(markers.map((m) => m.id), ["c1", "c2"]);
});

test("deleteComment removes only the matching id", async () => {
  commentAuthor = "";
  const doc = makeDoc("A.\n\nB.\n");
  await comments.addComment(doc, 0, "first");
  await comments.addComment(doc, 2, "second");

  await comments.deleteComment(doc, "c1");
  const remaining = comments.listComments(doc);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "c2");
  assert.equal(remaining[0].text, "second");
  // Instruction block still present (one comment remains).
  assert.match(doc.getText(), /@ms-comment-instructions/);
});

test("deleting the last comment also removes the instruction block", async () => {
  commentAuthor = "";
  const doc = makeDoc("Only para.\n");
  await comments.addComment(doc, 0, "note");
  assert.match(doc.getText(), /@ms-comment-instructions/);

  await comments.deleteComment(doc, "c1");
  const text = doc.getText();
  assert.doesNotMatch(text, /@ms-comment:/);
  assert.doesNotMatch(text, /@ms-comment-instructions/);
  // File returns to a clean state (no trailing marker debris).
  assert.match(text, /Only para\./);
});

test("updateComment rewrites the text in place keeping the same id", async () => {
  commentAuthor = "";
  const doc = makeDoc("Para.\n");
  await comments.addComment(doc, 0, "old text");
  await comments.updateComment(doc, "c1", "new improved text");

  const markers = comments.listComments(doc);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].id, "c1");
  assert.equal(markers[0].text, "new improved text");
});

test("escapes a literal --> and collapses multi-line input to one line", async () => {
  commentAuthor = "";
  const doc = makeDoc("Para.\n");
  await comments.addComment(doc, 0, "use --> carefully\nsecond line\tafter tab");

  const lines = doc.getText().split("\n");
  const marker = lines.find((l) => l.includes("@ms-comment:"));
  // Single physical line, terminator escaped, whitespace collapsed.
  assert.match(marker, /<!-- @ms-comment:c1 use --&gt; carefully second line after tab -->/);

  // Round-trips back to the literal text on read.
  const parsed = comments.listComments(doc)[0];
  assert.equal(parsed.text, "use --> carefully second line after tab");
});

test("attribution is off by default and applied when configured", async () => {
  commentAuthor = "";
  const doc1 = makeDoc("Para.\n");
  await comments.addComment(doc1, 0, "no author");
  assert.doesNotMatch(doc1.getText(), /—/);

  commentAuthor = "Raj";
  const doc2 = makeDoc("Para.\n");
  await comments.addComment(doc2, 0, "with author");
  assert.match(doc2.getText(), /with author —Raj -->/);
  commentAuthor = "";
});

test("escapeMarkerText / unescapeCommentText round-trip", () => {
  const raw = "line one\nline two --> end";
  const escaped = comments.escapeMarkerText(raw);
  assert.equal(escaped, "line one line two --&gt; end");
  assert.equal(comments.unescapeCommentText(escaped), "line one line two --> end");
});

test("listComments returns id, unescaped text, and 0-based line for each marker", async () => {
  commentAuthor = "";
  const doc = makeDoc("Alpha.\n\nBeta.\n");
  await comments.addComment(doc, 0, "first");
  await comments.addComment(doc, 3, "second --> note");

  const parsed = comments.listComments(doc);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((c) => c.id), ["c1", "c2"]);
  // Text is unescaped back to the literal on read.
  assert.equal(parsed[1].text, "second --> note");
  // Lines are 0-based and point at the marker line, in source order.
  assert.ok(parsed[0].line < parsed[1].line);
  assert.match(doc.getText().split("\n")[parsed[0].line], /@ms-comment:c1/);
});

test("hasComments reflects presence of markers", async () => {
  commentAuthor = "";
  const doc = makeDoc("Body.\n");
  assert.equal(comments.hasComments(doc.getText()), false);
  await comments.addComment(doc, 0, "note");
  assert.equal(comments.hasComments(doc.getText()), true);
});

test("buildChatDigest returns undefined with no comments", () => {
  const doc = makeDoc("Just prose, no comments.\n");
  assert.equal(comments.buildChatDigest(doc), undefined);
});

test("buildChatDigest embeds the document plus a digest with ids and anchors", async () => {
  commentAuthor = "";
  const doc = makeDoc("# Title\n\nRun the setup script.\n");
  await comments.addComment(doc, 2, "Mention Windows too");

  const digest = comments.buildChatDigest(doc);
  assert.ok(digest, "digest should be produced when comments exist");
  // Instruction preamble + the full document body.
  assert.match(digest, /return\s+the full edited document/u);
  assert.match(digest, /--- BEGIN DOCUMENT ---/u);
  assert.match(digest, /Run the setup script\./u);
  // A digest line with the id, an anchor snippet from the block above, and text.
  assert.match(digest, /- \[c1\] near "Run the setup script\.": Mention Windows too/u);
});
