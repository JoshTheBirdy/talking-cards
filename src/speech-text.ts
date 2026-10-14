// Card Markdown → what the voice should say: strips Markdown syntax, links, math and comments,
// plus card-specific bits (cloze gaps, %%say%%).

const ESCAPE = /\\([\\`*_{}[\]()#+\-.!|~=])/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const EMBED = /!\[\[[^\]]*\]\]/g;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const WIKILINK = /\[\[([^\]]+)\]\]/g;
const MDLINK = /\[([^\]]+)\]\([^)]*\)/g;
const BARE_URL = /<?https?:\/\/\S+>?/g;
const FOOTNOTE = /\[\^[^\]]+\]/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const TAG = /(^|[^\w&])#([a-zA-Z][\w/-]*)/g;
const EMPHASIS = /(\*\*\*|\*\*|\*|___|__|_|==|~~)(\S(?:[\s\S]*?\S)?)\1/g;
const LEFTOVER = /\*\*+|\[\[|\]\]/g;
const BLOCK_ID = /\s\^[\w-]+\s*$/gm;
const MATH_BLOCK = /\$\$[\s\S]*?\$\$/g;
const MATH_INLINE = /(^|[^\\])\$[^$\s](?:[^$\n]*?[^$\s])?\$/g;
const SAY = /%%\s*say:\s*([\s\S]*?)%%/i;
const COMMENT = /%%[\s\S]*?%%/g;
const CLOZE_GAP = /<span class="tc-cloze-gap">\[(.*?)\]<\/span>/g;
const CLOZE_ANSWER = /<span class="tc-cloze-answer">(.*?)<\/span>/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

const CALLOUT = /^>\s*\[!([a-zA-Z]+)\][-+]?\s*(.*)$/;
const HRULE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST = /^\s*([-*+]|\d+[.)])\s+/;
const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+/;
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const ENDS_SENTENCE = /[.!?:;,…]$/;

const CALLOUT_WORDS: Record<string, string> = {
  note: "Note", warning: "Warning", tip: "Tip", info: "Info", important: "Important",
  danger: "Danger", caution: "Caution", example: "Example", question: "Question", quote: "Quote",
};

/** [[path/Note|Display]] → Display. [[path/Note#Heading]] → Note Heading. */
function wikilinkText(inner: string): string {
  if (inner.includes("|")) return inner.split("|").slice(1).join("|").trim();
  const target = inner.split("/").pop()!;
  return target.split("#").map((p) => p.trim()).filter(Boolean).join(" ");
}

function stripInline(s: string): string {
  // Escaped characters are parked first so the emphasis rule can't eat them.
  s = s.replace(ESCAPE, (_, c: string) => `\u0000${c.charCodeAt(0)}\u0000`);
  s = s.replace(HTML_COMMENT, "");
  s = s.replace(EMBED, "");
  s = s.replace(IMAGE, (_, alt: string) => (alt && !/^\d+(x\d+)?$/.test(alt) ? alt : ""));
  s = s.replace(WIKILINK, (_, inner: string) => wikilinkText(inner));
  s = s.replace(MDLINK, "$1");
  s = s.replace(BARE_URL, "");
  s = s.replace(FOOTNOTE, "");
  s = s.replace(INLINE_CODE, "$1");
  s = s.replace(TAG, "$1");
  for (let i = 0; i < 3; i++) {
    const next = s.replace(EMPHASIS, "$2");
    if (next === s) break;
    s = next;
  }
  s = s.replace(LEFTOVER, "");
  // eslint-disable-next-line no-control-regex -- NUL marks placeholders this function inserted itself
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => String.fromCharCode(Number(n)));
  return s.split(/\s+/).filter(Boolean).join(" ");
}

function tableRow(line: string): string | null {
  if (TABLE_SEP.test(line)) return null;
  const SENT = "\u0000PIPE\u0000";
  const cells = line
    .replace(/\\\|/g, SENT)
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => stripInline(c.split(SENT).join("|")))
    .filter(Boolean);
  return cells.length ? cells.join(", ") : null;
}

function sentence(s: string): string {
  return ENDS_SENTENCE.test(s) ? s : s + ".";
}

/** Markdown in, speakable prose out. */
export function cleanMarkdown(text: string): string {
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(HTML_COMMENT, "");
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let line = raw.trimEnd();
    if (!line.trim()) {
      out.push("");
      continue;
    }
    if (HRULE.test(line)) continue;

    const callout = CALLOUT.exec(line);
    if (callout) {
      const word = CALLOUT_WORDS[callout[1].toLowerCase()] ?? callout[1][0].toUpperCase() + callout[1].slice(1);
      const rest = stripInline(callout[2]);
      out.push(rest ? `${word}. ${rest}` : `${word}.`);
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      line = line.trimStart().slice(1).trimStart();
      if (!line) continue;
    }
    if (line.includes("|") && line.trim().startsWith("|")) {
      const row = tableRow(line);
      if (row) out.push(sentence(row));
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const title = stripInline(h[2]);
      if (title) out.push(sentence(title));
      continue;
    }
    const task = TASK.exec(line);
    if (task) line = (task[1].toLowerCase() === "x" ? "Done. " : "To do. ") + line.replace(TASK, "");
    else line = line.replace(LIST, "");
    line = stripInline(line);
    if (line) out.push(sentence(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * What to say for one side of a card. `%%say: …%%` overrides everything; cloze gaps are
 * read as "blank" (or their hint), maths as "formula".
 */
export function speechFor(markdown: string): string {
  const say = SAY.exec(markdown);
  if (say) return say[1].trim();
  let s = markdown
    .replace(COMMENT, "")
    .replace(BLOCK_ID, "")
    .replace(CLOZE_GAP, (_, hint: string) => (hint === "…" ? " blank " : ` blank, ${hint}, `))
    .replace(CLOZE_ANSWER, "$1")
    .replace(MATH_BLOCK, " formula. ")
    .replace(MATH_INLINE, "$1 formula ")
    .replace(HTML_TAG, "");
  s = cleanMarkdown(s);
  // A one-line card side shouldn't get a forced full stop if it was a question fragment;
  // keep what cleanMarkdown produced but avoid ".." from "…."
  return s.replace(/\.{2,}/g, ".").replace(/,\s*,/g, ",").replace(/,\s*$/, ".").trim();
}

/** One-line plain preview of card Markdown, for lists. Cloze gaps show as […]. */
export function plainText(markdown: string): string {
  const s = markdown
    .replace(COMMENT, "")
    .replace(BLOCK_ID, "")
    .replace(CLOZE_GAP, (_, hint: string) => `[${hint}]`)
    .replace(CLOZE_ANSWER, "$1")
    .replace(HTML_TAG, "");
  return s
    .split(/\r?\n/)
    .map((l) => stripInline(l.replace(TASK, "").replace(LIST, "").replace(/^\s*>\s?/, "").replace(/^#+\s+/, "")))
    .filter(Boolean)
    .join(" · ");
}
