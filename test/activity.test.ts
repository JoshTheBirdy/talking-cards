import { test } from "node:test";
import assert from "node:assert/strict";
import { activeKeys, formatRules, isActive, parseRules, toggle, type Rules } from "../src/activity.ts";
import { cardsInScope } from "../src/scope.ts";

const CH = "Uni/HMSC222/Chapter 1.md";
const EX = "Uni/Exams/HMSC222 Exam prep.md";
const OLD = "Uni/Y2 S1/PSYC211/SU9.md";
const copies = [
  { key: "c1", path: CH, deck: "Uni/HMSC222" },
  { key: "s1", path: CH, deck: "Uni/HMSC222" },
  { key: "s1", path: EX, deck: "Uni/Exams" },
  { key: "e1", path: EX, deck: "Uni/Exams" },
  { key: "o1", path: OLD, deck: "Uni/Y2 S1/PSYC211" },
];
const keys = (l: { key: string }[]) => l.map((c) => c.key);

test("everything is active by default", () => {
  assert.equal(isActive(CH, new Map()), true);
  assert.deepEqual([...activeKeys(copies, new Map())].sort(), ["c1", "e1", "o1", "s1"]);
});

test("an inactive folder switches off everything inside it; the nearest rule wins", () => {
  const rules: Rules = new Map([["Uni/Y2 S1", false], ["Uni/Y2 S1/PSYC211/SU9.md", true]]);
  assert.equal(isActive("Uni/Y2 S1/PSYC211/Other.md", rules), false);
  assert.equal(isActive(OLD, rules), true);
  assert.equal(isActive("Uni/Y2 S1x/a.md", rules), true); // a folder name that merely starts the same is a different folder
});

test("a duplicate stays active when any copy is in an active place", () => {
  const rules: Rules = new Map([["Uni/HMSC222", false]]);
  const active = activeKeys(copies, rules);
  assert.deepEqual([...active].sort(), ["e1", "o1", "s1"]); // c1 only lives in the inactive chapter
  assert.deepEqual(keys(cardsInScope(copies, { kind: "all", value: "" }, true, "", active)), ["s1", "e1", "o1"]);
});

test("toggle flips, and drops rules the parent already implies", () => {
  let r: Rules = new Map();
  r = toggle(r, "Uni/Y2 S1");
  assert.deepEqual([...r], [["Uni/Y2 S1", false]]);
  r = toggle(r, "Uni/Y2 S1/PSYC211"); // back on inside an inactive folder
  assert.deepEqual([...r].sort(), [["Uni/Y2 S1", false], ["Uni/Y2 S1/PSYC211", true]]);
  r = toggle(r, "Uni/Y2 S1"); // whole folder on again: the inner "+" is redundant
  assert.deepEqual([...r], []);
});

test("rules round-trip through the note", () => {
  const r: Rules = new Map([["Uni/Y2 S1", false], ["Uni/Y2 S1/PSYC211", true]]);
  assert.deepEqual(parseRules(formatRules(r)), r);
  assert.deepEqual(parseRules("no block here"), new Map());
});
