import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOcclusion, formatOcclusion, imagesOnLine, newBoxId } from "../src/occlusion.ts";
import { parseNote, expandBlock, assignTextIds, addMissingIds } from "../src/parser.ts";

const NOTE = [
  "# Heart",
  "![[heart.png]]",
  "```occlusion",
  "image: heart.png",
  "mode: hide-all",
  "question: Name the structure",
  "k3d: 0.120 0.300 0.200 0.080 Left atrium",
  "a9z: 0.550 0.400 0.180 0.070 Aorta",
  "```",
  "",
  "Aorta ;; Main artery",
].join("\n");

test("parse and format round-trip", () => {
  const body = NOTE.split("\n").slice(3, 8).join("\n");
  const o = parseOcclusion(body);
  assert.equal(o.image, "heart.png");
  assert.equal(o.mode, "hide-all");
  assert.equal(o.question, "Name the structure");
  assert.deepEqual(o.boxes.map((b) => [b.id, b.label]), [["k3d", "Left atrium"], ["a9z", "Aorta"]]);
  assert.deepEqual(parseOcclusion(formatOcclusion(o)), o);
});

test("image link forms and bad box lines", () => {
  const o = parseOcclusion("image: ![[Images/heart.png|300]]\nzz: 0.1 0.1 0 0.1 zero width\nbad line\nq1: 0.1 0.2 0.3 0.4");
  assert.equal(o.image, "Images/heart.png");
  assert.equal(o.boxes.length, 1);
  assert.equal(o.boxes[0].label, "");
});

test("each box is a card; the block sits beside ordinary cards", () => {
  const blocks = parseNote(NOTE, { braceCloze: true, highlightCloze: false });
  assert.deepEqual(blocks.map((b) => b.kind), ["occlusion", "basic"]);
  assignTextIds(blocks);
  const cards = expandBlock(blocks[0]);
  assert.equal(cards.length, 2);
  assert.ok(cards[0].key.endsWith("#ok3d"));
  assert.equal(cards[1].back, "Aorta");
  assert.equal(cards[0].occlusion?.target, "k3d");
  assert.deepEqual(blocks[0].context, ["Heart"]);
});

test("editing boxes keeps the block's ID (named by its image)", () => {
  const a = parseNote(NOTE);
  const b = parseNote(NOTE.replace("Aorta\n", "Aortic arch\n").replace("a9z: 0.550", "a9z: 0.560"));
  assignTextIds(a);
  assignTextIds(b);
  assert.equal(a[0].id, b[0].id);
});

test("written IDs never go on an occlusion fence", () => {
  const blocks = parseNote(NOTE);
  assignTextIds(blocks, ["occlusion"]);
  const out = addMissingIds(NOTE, blocks, new Set())!;
  assert.ok(out.includes("```\n"), "closing fence untouched");
  assert.match(out, /Main artery \^tc-/);
});

test("finds image embeds on a line", () => {
  assert.deepEqual(imagesOnLine("See ![[heart.png|200]] and ![x](Img/lung%201.jpg) and [[note]]"), ["heart.png", "Img/lung 1.jpg"]);
});

test("new box ids are unique", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) ids.add(newBoxId(ids));
  assert.equal(ids.size, 200);
});
