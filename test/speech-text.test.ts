import { test } from "node:test";
import assert from "node:assert/strict";
import { speechFor, cleanMarkdown } from "../src/speech-text.ts";
import { parseCards } from "../src/parser.ts";

test("wikilinks read their alias or note name", () => {
  assert.equal(speechFor("See [[Shared_space/Health/Sleep|sleep notes]] and [[Biology/Mitosis#Stages]]"), "See sleep notes and Mitosis Stages.");
});

test("formatting, tags, urls and block ids disappear", () => {
  assert.equal(speechFor("**Bold** _it_ ==hl== `code` #tag https://x.com ^tc-abc123"), "Bold it hl code.");
});

test("lists and tables", () => {
  assert.equal(cleanMarkdown("- Prophase\n- Metaphase"), "Prophase.\nMetaphase.");
  assert.equal(cleanMarkdown("| a | b |\n|---|---|\n| 1 | [[x\\|y]] |"), "a, b.\n1, y.");
});

test("cloze sides", () => {
  const [c] = parseCards("The {{mitochondria}} makes {{c1::ATP::molecule}} ^tc-aaaaaa");
  assert.equal(speechFor(c.front), "The mitochondria makes blank, molecule.");
  assert.equal(speechFor(c.back), "The mitochondria makes ATP.");
  const [, c2] = parseCards("The {{mitochondria}} makes {{c1::ATP}} ^tc-aaaaaa");
  assert.equal(speechFor(c2.front), "The blank makes ATP.");
});

test("maths, images and comments", () => {
  assert.equal(speechFor("Area is $\\pi r^2$ ![[diagram.png]] %%private%%"), "Area is formula.");
  assert.equal(speechFor("![a red cell](cell.png)"), "a red cell.");
});

test("%%say%% overrides", () => {
  assert.equal(speechFor("Ca²⁺ %%say: calcium ion%%"), "calcium ion");
});

test("questions keep their question mark", () => {
  assert.equal(speechFor("What is ATP?"), "What is ATP?");
});

test("plainText previews", async () => {
  const { plainText } = await import("../src/speech-text.ts");
  assert.equal(plainText("- **Prophase**\n- [[Bio/Metaphase|metaphase]] ^tc-aaaaaa"), "Prophase · metaphase");
  const [c] = parseCards("The {{mitochondria}} ^tc-bbbbbb");
  assert.equal(plainText(c.front), "The […]");
});
