import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, parseCards, addMissingIds, splitOnColons } from "../src/parser.ts";

const md = (s: TemplateStringsArray) => s[0].replace(/^\n/, "");

test("basic and reversed single-line cards", () => {
  const b = parseNote("Mitosis :: cell division\nATP ::: adenosine triphosphate\n");
  assert.equal(b.length, 2);
  assert.deepEqual([b[0].kind, b[0].question, b[0].answer], ["basic", "Mitosis", "cell division"]);
  assert.equal(b[1].kind, "bidi");
  const cards = parseCards("ATP ::: adenosine triphosphate ^tc-abc123");
  assert.deepEqual(cards.map((c) => [c.key, c.front, c.back]), [
    ["abc123", "ATP", "adenosine triphosphate"],
    ["abc123#r", "adenosine triphosphate", "ATP"],
  ]);
});

test("block ID is read and stripped", () => {
  const [b] = parseNote("Q :: A ^tc-x1y2z3");
  assert.equal(b.id, "x1y2z3");
  assert.equal(b.answer, "A");
});

test("colon runs that aren't separators", () => {
  assert.equal(splitOnColons("Use `std::vector` here"), null);
  assert.equal(splitOnColons("time 12:30 and http://x.com"), null);
  assert.equal(splitOnColons("a :::: b"), null);
  assert.equal(splitOnColons(":: no question"), null);
  assert.equal(parseNote("The {{c1::Krebs}} cycle").length, 1); // cloze, not basic
  assert.equal(parseNote("The {{c1::Krebs}} cycle")[0].kind, "cloze");
});

test("multi-line cards", () => {
  const b = parseNote(md`
What are the stages
of mitosis?
??
Prophase, metaphase,
anaphase, telophase ^tc-aaaaaa

Not a card
`);
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, "multi-bidi");
  assert.equal(b[0].question, "What are the stages\nof mitosis?");
  assert.equal(b[0].answer, "Prophase, metaphase,\nanaphase, telophase");
  assert.equal(b[0].id, "aaaaaa");
  assert.equal(b[0].lastLine, 4);
});

test("list answer", () => {
  const b = parseNote(md`
- Stages of mitosis >>>
  - Prophase
  - Metaphase
  - Anaphase
- Next :: thing
`);
  assert.equal(b.length, 2);
  assert.equal(b[0].kind, "list");
  assert.equal(b[0].question, "Stages of mitosis");
  assert.equal(b[0].answer, "- Prophase\n- Metaphase\n- Anaphase");
  assert.equal(b[0].lastLine, 3);
  assert.deepEqual(b[1].context, []);
});

test("cloze: ungrouped, grouped and hints", () => {
  const cards = parseCards("The {{mitochondria}} makes {{c1::ATP::molecule}} and {{c1::heat}} ^tc-cccccc");
  assert.deepEqual(cards.map((c) => c.key), ["cccccc#c1", "cccccc#c2"]);
  assert.match(cards[0].front, /The mitochondria makes .*\[molecule\].* and .*\[…\]/);
  assert.match(cards[0].back, /tc-cloze-answer">ATP</);
  assert.match(cards[1].front, /The .*\[…\].* makes ATP and heat/);
});

test("highlight cloze only when enabled", () => {
  assert.equal(parseNote("A ==highlight== here").length, 0);
  assert.equal(parseNote("A ==highlight== here", { braceCloze: true, highlightCloze: true }).length, 1);
});

test("context from headings and parent bullets", () => {
  const b = parseNote(md`
# Biology
## Cells
- Organelles
  - Mitochondria :: powerhouse
  - Ribosome :: makes proteins
- Top :: level
`);
  assert.deepEqual(b[0].context, ["Biology", "Cells", "Organelles"]);
  assert.deepEqual(b[1].context, ["Biology", "Cells", "Organelles"]);
  assert.deepEqual(b[2].context, ["Biology", "Cells"]);
});

test("skips frontmatter, code, comments and math", () => {
  const b = parseNote(md`
---
tags: a::b
---
\`\`\`cpp
std :: thing
\`\`\`
%%
hidden :: card
%%
$$
x :: y
$$
real :: card
`);
  assert.deepEqual(b.map((x) => x.question), ["real"]);
});

test("addMissingIds appends IDs, keeps existing ones, is idempotent", () => {
  const text = "Q1 :: A1\nQ2 :: A2 ^tc-keep01\n\n- L >>>\n  - a\n  - b";
  const blocks = parseNote(text);
  const out = addMissingIds(text, blocks, new Set())!;
  const again = parseNote(out);
  assert.equal(again.length, 3);
  assert.ok(again.every((b) => b.id));
  assert.equal(again[1].id, "keep01");
  assert.match(out.split("\n")[5], /^ {2}- b \^tc-[a-z0-9]{6}$/);
  assert.equal(addMissingIds(out, again, new Set()), null);
});

test("ordinary prose produces no cards", () => {
  const prose = "Meeting at 10:30. See [[Note|alias]] and ==important== bits.\n\n- a list\n- of things";
  assert.equal(parseNote(prose).length, 0);
});

test("duplicate IDs get fresh ones", () => {
  const text = "A :: 1 ^tc-same01\nB :: 2 ^tc-same01\nC :: 3 ^tc-other1";
  const out = addMissingIds(text, parseNote(text), new Set(["same01", "other1"]), new Set(["other1"]))!;
  const ids = parseNote(out).map((b) => b.id);
  assert.equal(ids[0], "same01");
  assert.notEqual(ids[1], "same01");
  assert.notEqual(ids[2], "other1");
  assert.equal(out.split("\n")[1].match(/\^tc-/g)!.length, 1);
});

// RemNote-style format: `Q ;; A` and `Q ;;` with tab-indented answer lines
test(";; basic cards", () => {
  const b = parseNote("What is the function of the mitochondria? ;; It produces ATP.\nDefine plyometrics. ;; Eccentric then concentric");
  assert.deepEqual(b.map((x) => [x.kind, x.question, x.answer]), [
    ["basic", "What is the function of the mitochondria?", "It produces ATP."],
    ["basic", "Define plyometrics.", "Eccentric then concentric"],
  ]);
});

test(";; list cards with tab-indented items", () => {
  const text = "What are the four stages of mitosis, in order? ;;\n\tProphase\n\tMetaphase\n\tAnaphase\n\tTelophase\nNext ;; card";
  const b = parseNote(text);
  assert.equal(b.length, 2);
  assert.equal(b[0].kind, "list");
  assert.equal(b[0].question, "What are the four stages of mitosis, in order?");
  assert.equal(b[0].answer, "- Prophase\n- Metaphase\n- Anaphase\n- Telophase");
  assert.equal(b[0].lastLine, 4);
  assert.equal(b[1].question, "Next");
  const withIds = addMissingIds(text, b, new Set())!;
  assert.match(withIds.split("\n")[4], /^\tTelophase \^tc-[a-z0-9]{6}$/);
  assert.equal(parseNote(withIds)[0].answer, "- Prophase\n- Metaphase\n- Anaphase\n- Telophase");
});

test(";; inside code blocks and inline code is ignored", () => {
  assert.equal(parseNote("```\nQ ;; A\n```").length, 0);
  assert.equal(parseNote("Use `a ;; b` here").length, 0);
  assert.equal(parseNote(";; no question").length, 0);
});

test(";; cards inside plain code blocks, only when enabled, never in tagged code", async () => {
  const text = "# BMAN\n```\nQ1 ;; A1\nWhat are the two? ;;\n\tOne\n\tTwo\nstd::vector :: nope\n```\n```cpp\nint ;; x\n```";
  assert.equal(parseNote(text).length, 0);
  const b = parseNote(text, { braceCloze: true, highlightCloze: false, codeBlockCards: true });
  assert.deepEqual(b.map((x) => [x.kind, x.question, x.answer]), [["basic", "Q1", "A1"], ["list", "What are the two?", "- One\n- Two"]]);
  assert.deepEqual(b[0].context, ["BMAN"]);
});

test("text IDs: stable, shared by identical cards, rewritten only when IDs are turned on", async () => {
  const { assignTextIds } = await import("../src/parser.ts");
  const a = parseNote("Q ;; A\nOther ;; B");
  const b = parseNote("intro\n\nQ  ;;  A");
  assignTextIds(a);
  assignTextIds(b);
  assert.equal(a[0].id, b[0].id);
  assert.notEqual(a[0].id, a[1].id);
  assert.match(a[0].id!, /^h[0-9a-f]{12}$/);
  const written = addMissingIds("Q ;; A", a.slice(0, 1), new Set())!;
  assert.match(written, /^Q ;; A \^tc-[a-z0-9]{6}$/);
});
