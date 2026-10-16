// Finds flashcards in a note's Markdown. Pure: no Obsidian imports, so it runs under `node --test`.
// Syntax is documented in SCOPE.md §3.
import { parseOcclusion, type Occlusion } from "./occlusion.ts";

export type BlockKind = "basic" | "bidi" | "multi" | "multi-bidi" | "list" | "cloze" | "occlusion";

/** One card definition in the source. A block expands to one or more reviewable cards. */
export interface CardBlock {
  kind: BlockKind;
  /** Block ID without the `^tc-` prefix; null until the plugin assigns one. */
  id: string | null;
  /** True when `id` was derived from the card's text rather than written in the note. */
  textId?: boolean;
  question: string;
  /** Empty for cloze blocks: the question holds the whole text. */
  answer: string;
  firstLine: number;
  /** The line the `^tc-` ID lives on (or will be appended to). */
  lastLine: number;
  /** Enclosing headings and parent bullets, outermost first. */
  context: string[];
}

export interface Card {
  /** Unique, stable key: `id`, `id#r` (reverse side) or `id#c2` (cloze group 2). */
  key: string;
  blockId: string;
  kind: BlockKind;
  front: string;
  back: string;
  context: string[];
  /** Image occlusion cards: the image, its boxes, and which box this card asks about. */
  occlusion?: Occlusion & { target: string };
}

export interface ParseOptions {
  /** `{{answer}}` and `{{c1::answer}}` */
  braceCloze: boolean;
  /** `==answer==` — off by default: ordinary highlights would all become cards. */
  highlightCloze: boolean;
  /** `;;` cards inside plain ``` blocks (no language tag). Real code is never read. */
  codeBlockCards?: boolean;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = { braceCloze: true, highlightCloze: false };

export const ID_PREFIX = "tc-";
const ID_RE = /\s*\^tc-([a-z0-9]+)\s*$/;
const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const LIST_ANSWER_MARK = ">>>";

export function parseNote(text: string, opts: ParseOptions = DEFAULT_PARSE_OPTIONS): CardBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: CardBlock[] = [];
  const headings: string[] = [];
  let parents: { indent: number; text: string }[] = [];

  let i = skipFrontmatter(lines);
  let fence: string | null = null;
  let fenceCards = false;
  /** Inside an ```occlusion block: where it started and its lines. */
  let occ: { start: number; body: string[] } | null = null;
  let inComment = false;
  let inMath = false;
  let para: number[] = [];

  const flush = (semisOnly = false) => {
    if (para.length) parseParagraph(para, semisOnly);
    para = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (fence) {
      if (occ && trimmed.startsWith(fence)) {
        // The image path is the question (it names the card); the box list is the answer.
        const o = parseOcclusion(occ.body.join("\n"));
        if (o.image && o.boxes.length) {
          blocks.push({ kind: "occlusion", id: null, question: o.image, answer: occ.body.join("\n"), firstLine: occ.start, lastLine: i, context: headings.filter((h) => h) });
        }
        occ = null;
        fence = null;
        continue;
      }
      if (occ) {
        occ.body.push(line);
        continue;
      }
      if (trimmed.startsWith(fence)) {
        if (fenceCards) flush(true);
        fence = null;
        fenceCards = false;
      } else if (fenceCards) {
        if (trimmed === "") flush(true);
        else para.push(i);
      }
      continue;
    }
    if (inComment) {
      if (trimmed.includes("%%")) inComment = false;
      continue;
    }
    if (inMath) {
      if (trimmed.endsWith("$$")) inMath = false;
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) {
      flush();
      fence = f[1];
      if (trimmed.slice(f[1].length).trim() === "occlusion") {
        occ = { start: i, body: [] };
        continue;
      }
      // A plain ``` block (no language) may hold a deck of `;;` cards, kept there for copying.
      fenceCards = !!opts.codeBlockCards && trimmed.slice(f[1].length).trim() === "";
      continue;
    }
    if (trimmed.startsWith("%%") && !trimmed.slice(2).includes("%%")) {
      flush();
      inComment = true;
      continue;
    }
    if (trimmed === "$$" || (trimmed.startsWith("$$") && !trimmed.slice(2).includes("$$"))) {
      flush();
      inMath = true;
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      headings.length = h[1].length - 1;
      headings[h[1].length - 1] = stripId(h[2]);
      parents = [];
      continue;
    }
    if (trimmed === "") {
      flush();
      continue;
    }
    para.push(i);
  }
  flush();
  return blocks;

  /** `semisOnly`: inside a code block, where only `;;` cards count. */
  function parseParagraph(idx: number[], semisOnly = false) {
    const out = blocks;
    const headingCtx = headings.filter((h) => h);

    // Multi-line card: the paragraph contains a line that is just `?` or `??`.
    const sepAt = semisOnly ? -1 : idx.findIndex((n) => /^\?\??$/.test(lines[n].trim()));
    if (sepAt > 0 && sepAt < idx.length - 1) {
      const bidi = lines[idx[sepAt]].trim() === "??";
      const last = idx[idx.length - 1];
      const { text: lastText, id } = splitId(lines[last]);
      const answerLines = idx.slice(sepAt + 1).map((n) => (n === last ? lastText : lines[n]));
      out.push({
        kind: bidi ? "multi-bidi" : "multi",
        id,
        question: idx.slice(0, sepAt).map((n) => lines[n]).join("\n").trim(),
        answer: answerLines.join("\n").trim(),
        firstLine: idx[0],
        lastLine: last,
        context: headingCtx,
      });
      return;
    }

    for (let k = 0; k < idx.length; k++) {
      const n = idx[k];
      const line = lines[n];
      const list = LIST_RE.exec(line);
      const indent = list ? list[1].replace(/\t/g, "    ").length : -1;
      if (list) {
        while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop();
      } else if (!/^\s/.test(line)) {
        parents = [];
      }
      const body = list ? line.slice(list[0].length) : line.trim();
      const context = [...headingCtx, ...parents.map((p) => p.text)];
      const { text: bodyText, id } = splitId(body);

      // RemNote style: `Question ;;` then one tab-indented line per list item.
      if (/\S\s*;;$/.test(bodyText.trimEnd()) && !/;;;$/.test(bodyText.trimEnd())) {
        let end = k;
        while (end + 1 < idx.length && /^\t/.test(lines[idx[end + 1]])) end++;
        if (end > k) {
          const lastN = idx[end];
          const { text: lastText, id: lastId } = splitId(lines[lastN]);
          const items = idx.slice(k + 1, end + 1).map((m) => (m === lastN ? lastText : lines[m]).trim()).filter(Boolean);
          out.push({
            kind: "list",
            id: lastId,
            question: bodyText.trimEnd().replace(/\s*;;$/, "").trim(),
            answer: items.map((i) => `- ${i}`).join("\n"),
            firstLine: n,
            lastLine: lastN,
            context,
          });
          k = end;
          continue;
        }
      }

      if (semisOnly) {
        const semi = splitOnSemicolons(bodyText);
        if (semi) out.push({ kind: "basic", id, question: semi.left.trim(), answer: semi.right.trim(), firstLine: n, lastLine: n, context });
        continue;
      }

      // List answer: `Question >>>` followed by the list items nested under it.
      if (bodyText.trimEnd().endsWith(LIST_ANSWER_MARK)) {
        let end = k;
        while (end + 1 < idx.length) {
          const next = lines[idx[end + 1]];
          const nl = LIST_RE.exec(next);
          if (!nl) break;
          const nIndent = nl[1].replace(/\t/g, "    ").length;
          if (list ? nIndent <= indent : false) break;
          end++;
        }
        if (end > k) {
          const lastN = idx[end];
          const { text: lastText, id: lastId } = splitId(lines[lastN]);
          const items = idx.slice(k + 1, end + 1).map((m) => (m === lastN ? lastText : lines[m]));
          const minIndent = Math.min(...items.map((s) => s.length - s.trimStart().length));
          out.push({
            kind: "list",
            id: lastId,
            question: bodyText.trimEnd().slice(0, -LIST_ANSWER_MARK.length).trim(),
            answer: items.map((s) => s.slice(minIndent)).join("\n").trimEnd(),
            firstLine: n,
            lastLine: lastN,
            context,
          });
          if (list) parents.push({ indent, text: bodyText.trimEnd().slice(0, -LIST_ANSWER_MARK.length).trim() });
          k = end;
          continue;
        }
      }

      const split = splitOnSemicolons(bodyText) ?? splitOnColons(bodyText);
      if (split) {
        out.push({
          kind: split.sep === 3 ? "bidi" : "basic",
          id,
          question: split.left.trim(),
          answer: split.right.trim(),
          firstLine: n,
          lastLine: n,
          context,
        });
      } else if (hasCloze(bodyText, opts)) {
        out.push({ kind: "cloze", id, question: bodyText.trim(), answer: "", firstLine: n, lastLine: n, context });
      }
      if (list) parents.push({ indent, text: (split ? split.left : bodyText).trim() });
    }
  }
}

function skipFrontmatter(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)\s*$/.test(lines[i])) return i + 1;
  return 0;
}

function splitId(line: string): { text: string; id: string | null } {
  const m = ID_RE.exec(line);
  return m ? { text: line.slice(0, m.index), id: m[1] } : { text: line, id: null };
}

function stripId(s: string): string {
  return splitId(s).text;
}

/** RemNote's `Question ;; Answer` (forward card): a run of exactly two semicolons outside inline code. */
export function splitOnSemicolons(s: string): { sep: 2; left: string; right: string } | null {
  if (!s.includes(";;")) return null;
  const masked = s.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
  const m = /(?<!;);;(?!;)/.exec(masked);
  if (!m) return null;
  const left = s.slice(0, m.index);
  const right = s.slice(m.index + 2);
  return left.trim() && right.trim() ? { sep: 2, left, right } : null;
}

/**
 * Finds the first run of exactly two or three colons outside inline code and `{{…}}`.
 * `std::vector` inside backticks and `{{c1::x}}` are not separators.
 */
export function splitOnColons(s: string): { sep: 2 | 3; left: string; right: string } | null {
  let code = 0; // length of the backtick run that opened the current code span
  let braces = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "`") {
      let j = i;
      while (s[j] === "`") j++;
      const run = j - i;
      if (code === 0) code = run;
      else if (code === run) code = 0;
      i = j - 1;
      continue;
    }
    if (code) continue;
    if (c === "{" && s[i + 1] === "{") {
      braces++;
      i++;
      continue;
    }
    if (c === "}" && s[i + 1] === "}" && braces) {
      braces--;
      i++;
      continue;
    }
    if (braces || c !== ":") continue;
    let j = i;
    while (s[j] === ":") j++;
    const run = j - i;
    if (run === 2 || run === 3) {
      const left = s.slice(0, i);
      const right = s.slice(j);
      if (left.trim() && right.trim()) return { sep: run, left, right };
    }
    i = j - 1;
  }
  return null;
}

const BRACE_CLOZE_RE = /\{\{(?:c(\d+)::)?(.+?)(?:::(.+?))?\}\}/g;
const HIGHLIGHT_CLOZE_RE = /==([^=]+?)==/g;

function hasCloze(s: string, opts: ParseOptions): boolean {
  const t = withoutInlineCode(s);
  return (opts.braceCloze && /\{\{.+?\}\}/.test(t)) || (opts.highlightCloze && /==[^=]+?==/.test(t));
}

function withoutInlineCode(s: string): string {
  return s.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
}

interface ClozeSpan {
  start: number;
  end: number;
  group: number;
  answer: string;
  hint: string | null;
}

function findClozes(s: string, opts: ParseOptions): ClozeSpan[] {
  const t = withoutInlineCode(s);
  const spans: ClozeSpan[] = [];
  const explicit: number[] = [];
  if (opts.braceCloze) {
    for (const m of t.matchAll(BRACE_CLOZE_RE)) {
      const group = m[1] ? Number(m[1]) : 0;
      if (group) explicit.push(group);
      spans.push({ start: m.index, end: m.index + m[0].length, group, answer: m[2], hint: m[3] ?? null });
    }
  }
  if (opts.highlightCloze) {
    for (const m of t.matchAll(HIGHLIGHT_CLOZE_RE)) {
      spans.push({ start: m.index, end: m.index + m[0].length, group: 0, answer: m[1], hint: null });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  // Ungrouped clozes each get their own card, numbered after the explicit groups.
  let next = Math.max(0, ...explicit) + 1;
  for (const sp of spans) if (!sp.group) sp.group = next++;
  return spans;
}

const GAP = (hint: string | null) => `<span class="tc-cloze-gap">[${hint ?? "…"}]</span>`;
const REVEAL = (answer: string) => `<span class="tc-cloze-answer">${answer}</span>`;

/** Turns a block into the cards you actually review. */
export function expandBlock(b: CardBlock, opts: ParseOptions = DEFAULT_PARSE_OPTIONS): Card[] {
  const id = b.id ?? `~${b.firstLine}`;
  const base = { blockId: id, kind: b.kind, context: b.context };
  switch (b.kind) {
    case "basic":
    case "multi":
    case "list":
      return [{ ...base, key: id, front: b.question, back: b.answer }];
    case "bidi":
    case "multi-bidi":
      return [
        { ...base, key: id, front: b.question, back: b.answer },
        { ...base, key: `${id}#r`, front: b.answer, back: b.question },
      ];
    case "occlusion": {
      const o = parseOcclusion(b.answer);
      return o.boxes.map((box, i) => ({
        ...base,
        key: `${id}#o${box.id}`,
        front: `Image occlusion: ${o.image} (${i + 1} of ${o.boxes.length})`,
        back: box.label || `Box ${i + 1}`,
        occlusion: { ...o, target: box.id },
      }));
    }
    case "cloze": {
      const spans = findClozes(b.question, opts);
      const groups = [...new Set(spans.map((s) => s.group))].sort((a, z) => a - z);
      return groups.map((g) => {
        let front = "";
        let back = "";
        let pos = 0;
        for (const sp of spans) {
          const before = b.question.slice(pos, sp.start);
          front += before + (sp.group === g ? GAP(sp.hint) : sp.answer);
          back += before + (sp.group === g ? REVEAL(sp.answer) : sp.answer);
          pos = sp.end;
        }
        front += b.question.slice(pos);
        back += b.question.slice(pos);
        return { ...base, key: `${id}#c${g}`, front, back };
      });
    }
  }
}

/** 64-bit FNV-1a, hex. Stable across devices and runs. */
export function fnv64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * Gives every block without a written ID one derived from its text, so nothing has to be
 * written into the note. Same question + answer → same ID, in any note or device; editing
 * the card's text makes it a new card.
 */
export function assignTextIds(blocks: CardBlock[], kinds?: BlockKind[]) {
  for (const b of blocks) {
    if (b.id || (kinds && !kinds.includes(b.kind))) continue;
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    // An occlusion is named by its image alone: editing boxes mustn't make it a new card set.
    if (b.kind === "occlusion") {
      b.id = "h" + fnv64(`occlusion\u0000${norm(b.question)}`).slice(0, 12);
      b.textId = true;
      continue;
    }
    b.id = "h" + fnv64(`${b.kind === "bidi" || b.kind === "multi-bidi" ? "bidi" : b.kind}\u0000${norm(b.question)}\u0000${norm(b.answer)}`).slice(0, 12);
    b.textId = true;
  }
}

export function parseCards(text: string, opts: ParseOptions = DEFAULT_PARSE_OPTIONS): Card[] {
  return parseNote(text, opts).flatMap((b) => expandBlock(b, opts));
}

export function newId(taken: Set<string>): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    let id = "";
    for (let i = 0; i < 6; i++) id += abc[Math.floor(Math.random() * abc.length)];
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/**
 * Appends `^tc-…` to every block without an ID, and gives a fresh ID to blocks whose ID is
 * in `duplicates` (a pasted copy of another card). Returns null when nothing changed, so
 * callers can skip writing the file.
 */
export function addMissingIds(
  text: string,
  blocks: CardBlock[],
  taken: Set<string>,
  duplicates: Set<string> = new Set(),
): string | null {
  const seen = new Set<string>();
  const todo = blocks.filter((b) => {
    if (b.kind === "occlusion") return false; // always image-derived; a fence line can't carry an ID
    if (!b.id || b.textId) return true;
    const dup = duplicates.has(b.id) || seen.has(b.id);
    seen.add(b.id);
    return dup;
  });
  if (!todo.length) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  for (const b of todo) {
    b.id = newId(taken);
    lines[b.lastLine] = `${splitId(lines[b.lastLine]).text.trimEnd()} ^${ID_PREFIX}${b.id}`;
  }
  return lines.join(eol);
}
