import { test } from "node:test";
import assert from "node:assert/strict";
import { cardsInScope, dedupeCopies, inScope, type CardCopy } from "../src/scope.ts";

// A chapter note and an exam-prep note in different folders, sharing cards s1..s3.
const CH = { path: "Uni/HMSC222/HMSC222 Flashcard chapter 1.md", deck: "Uni/HMSC222" };
const EX = { path: "Exams/HMSC222 Exam prep.md", deck: "Exams" };
const OTHER = { path: "Exams/BMAN221 Exam prep.md", deck: "Exams" };
const copy = (key: string, at: { path: string; deck: string }): CardCopy => ({ key, ...at });
const COPIES: CardCopy[] = [
  copy("c1", CH), copy("s1", CH), copy("s2", CH), copy("s3", CH),
  copy("s1", EX), copy("s2", EX), copy("s3", EX), copy("e1", EX),
  copy("b1", OTHER),
];
const keys = (l: CardCopy[]) => l.map((c) => c.key);

test("a folder serves every card written in it, whichever note's name is preferred", () => {
  for (const prefer of ["exam prep", "flashcard", ""]) {
    assert.deepEqual(keys(cardsInScope(COPIES, { kind: "deck", value: "Uni/HMSC222" }, true, prefer)), ["c1", "s1", "s2", "s3"], prefer);
    assert.deepEqual(keys(cardsInScope(COPIES, { kind: "deck", value: "Exams" }, true, prefer)), ["s1", "s2", "s3", "e1", "b1"], prefer);
  }
});

test("all cards: each card once", () => {
  assert.deepEqual(keys(cardsInScope(COPIES, { kind: "all", value: "" }, true, "")), ["c1", "s1", "s2", "s3", "e1", "b1"]);
});

test("a parent folder holding both copies counts the card once", () => {
  const nested = COPIES.map((c) => ({ ...c, deck: `Uni/${c.deck}` }));
  assert.equal(cardsInScope(nested, { kind: "deck", value: "Uni" }, true, "").length, 6);
});

test("a note serves its own cards; a card repeated inside one note appears once", () => {
  const withRepeat = [...COPIES, copy("e1", EX)];
  assert.deepEqual(keys(cardsInScope(withRepeat, { kind: "note", value: EX.path }, true, "")), ["s1", "s2", "s3", "e1"]);
});

test("preferred name only picks whose context is shown, in the card's first place in the order", () => {
  const all = dedupeCopies(COPIES, "exam prep");
  const s2 = all.find((c) => c.key === "s2")!;
  assert.equal(s2.path, EX.path);
  assert.equal(all.indexOf(s2), 2);
  assert.equal(dedupeCopies(COPIES, "").find((c) => c.key === "s2")!.path, CH.path);
});

test("merging off: every copy is served", () => {
  assert.equal(cardsInScope(COPIES, { kind: "all", value: "" }, false, "").length, COPIES.length);
  assert.equal(cardsInScope(COPIES, { kind: "deck", value: "Exams" }, false, "").length, 5);
});

test("vault-root deck means notes at the top level only; folder prefixes don't over-match", () => {
  const root = copy("r1", { path: "Loose.md", deck: "" });
  assert.equal(inScope(root, { kind: "deck", value: "" }), true);
  assert.equal(inScope(copy("x", CH), { kind: "deck", value: "" }), false);
  assert.equal(inScope(copy("x", { path: "Exams2/a.md", deck: "Exams2" }), { kind: "deck", value: "Exams" }), false);
});
