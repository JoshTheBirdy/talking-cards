import { test } from "node:test";
import assert from "node:assert/strict";
import { Links, matchEdits, editScore, snapOf, type SnapCard } from "../src/links.ts";
import { parseNote, assignTextIds } from "../src/parser.ts";
import { groupByKey, replayKeys, makeFsrs, DEFAULT_SCHEDULER, todayCounts, type LogEntry, type CardState } from "../src/scheduler.ts";

const card = (id: string, q: string, a: string, pos = 0, kind: SnapCard["kind"] = "basic"): SnapCard => ({ id, kind, q, a, pos });

/** Cards of a note as edit tracking sees them (text-derived IDs). */
function snaps(md: string): SnapCard[] {
  const blocks = parseNote(md, { braceCloze: true, highlightCloze: false, codeBlockCards: true });
  assignTextIds(blocks);
  return snapOf(blocks);
}

/** What tracking would link for a note edited from `a` to `b`. */
function edit(a: string, b: string): [string, string][] {
  const before = snaps(a);
  const after = snaps(b);
  const afterIds = new Set(after.map((c) => c.id));
  const beforeIds = new Set(before.map((c) => c.id));
  return matchEdits(before.filter((c) => !afterIds.has(c.id)), after.filter((c) => !beforeIds.has(c.id)));
}

test("answer edited: same card", () => {
  const pairs = edit("Mitochondria ;; Powerhouse", "Mitochondria ;; Powerhouse of the cell");
  assert.equal(pairs.length, 1);
});

test("question edited: same card", () => {
  assert.equal(edit("Mitochondira ;; Makes ATP", "Mitochondria ;; Makes ATP").length, 1);
});

test("small edits on both sides: same card", () => {
  assert.equal(edit("Function of the ribosome ;; Protein synthesis", "Function of ribosomes ;; Protein synthesis (translation)").length, 1);
});

test("rewritten card: new card", () => {
  assert.equal(edit("Mitochondria ;; Powerhouse", "Krebs cycle location ;; Matrix").length, 0);
});

test("removing ;; removes the card: nothing to link", () => {
  assert.equal(edit("Mitochondria ;; Powerhouse", "Mitochondria are the powerhouse").length, 0);
});

test("list card: an item added keeps the card", () => {
  assert.equal(edit("Muscle types ;;\n\tSkeletal\n\tCardiac", "Muscle types ;;\n\tSkeletal\n\tCardiac\n\tSmooth").length, 1);
});

test("cloze edited: same card; cloze never matches a Q/A card", () => {
  assert.equal(edit("The {{mitochondria}} makes ATP.", "The {{mitochondrion}} makes ATP.").length, 1);
  assert.equal(editScore(card("a", "Mitochondria makes ATP", "", 0, "cloze"), card("b", "Mitochondria makes ATP", "x")), 0);
});

test("two similar cards edited at once pair by position", () => {
  const before = [card("a1", "Bone cell types", "osteoblast", 0), card("a2", "Bone cell types", "osteoclast", 1)];
  const after = [card("b1", "Bone cell type", "osteoblast", 0), card("b2", "Bone cell type", "osteoclast", 1)];
  assert.deepEqual(matchEdits(before, after), [["a1", "b1"], ["a2", "b2"]]);
});

test("each card is used once", () => {
  const pairs = matchEdits([card("a", "Q", "Answer one")], [card("b", "Q", "Answer two", 0), card("c", "Q", "Answer three", 1)]);
  assert.equal(pairs.length, 1);
});

test("edit in a note with other cards only touches the edited one", () => {
  const a = "# Cells\nNucleus ;; Holds DNA\nRibosome ;; Makes protein\nLysosome ;; Digests waste";
  const b = "# Cells\nNucleus ;; Holds DNA\nRibosome ;; Makes proteins\nLysosome ;; Digests waste";
  assert.equal(edit(a, b).length, 1);
});

test("Links: chains, reverts and the same root on every device", () => {
  const l1 = new Links([{ t: 1, k: "b", a: "link", from: "a" }, { t: 2, k: "c", a: "link", from: "b" }, { t: 3, k: "a", a: "link", from: "c" }]);
  const l2 = new Links([{ t: 3, k: "a", a: "link", from: "c" }, { t: 1, k: "b", a: "link", from: "a" }, { t: 2, k: "c", a: "link", from: "b" }]);
  assert.equal(l1.find("c"), "a");
  assert.equal(l2.find("c"), "a");
  assert.deepEqual(l1.group("b").sort(), ["a", "b", "c"]);
  assert.equal(l1.canon("c#r"), "a#r");
  assert.equal(l1.canon("zzz#c2"), "zzz#c2");
});

test("an edited card keeps its history and isn't new again", () => {
  const S = DEFAULT_SCHEDULER;
  const f = makeFsrs(S);
  const T = new Date(2026, 9, 14, 12).getTime();
  const entries: LogEntry[] = [
    { t: T, k: "old", r: 3 },
    { t: T + 600_000, k: "old", r: 3 },
    { t: T + 700_000, k: "new", a: "link", from: "old" },
    { t: T + 800_000, k: "new", r: 3 },
  ];
  const links = new Links(entries);
  const groups = groupByKey(entries, (k) => links.canon(k));
  assert.deepEqual([...groups.keys()], ["new"]);
  const states = new Map<string, CardState>();
  replayKeys(states, groups, groups.keys(), f, S);
  assert.equal(states.get("new")!.fsrs.reps, 3);
  assert.equal(todayCounts(entries, T + 900_000, 4, (k) => links.canon(k)).newToday, 1);
});
