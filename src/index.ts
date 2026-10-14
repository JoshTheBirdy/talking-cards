import { Events, TFile, type App } from "obsidian";
import { parseNote, expandBlock, assignTextIds, type Card, type CardBlock, type ParseOptions } from "./parser.ts";

export interface NoteCards {
  path: string;
  deck: string;
  blocks: CardBlock[];
  cards: Card[];
  /** Frontmatter `tts-front` / `tts-back`: a language ("es", "en-GB") or a voice ("piper:…"). */
  tts: { front?: string; back?: string };
}

export interface IndexSettings extends ParseOptions {
  /** Folder prefixes or path substrings to skip, one per entry. */
  ignore: string[];
  dataFolder: string;
  /** Write `^tc-` IDs into notes. Off: cards are identified by their text and notes are never changed. */
  writeIds: boolean;
  /** The same question + answer in several notes is studied once. */
  dedupe: boolean;
  /** With dedupe: the copy in a note whose name contains this wins (e.g. a "flashcards" sheet). */
  dedupePrefer: string;
  /** Editing a card's text keeps its history (matched by similarity; see links.ts). */
  trackEdits: boolean;
}

type IndexedCard = Card & { path: string; deck: string };

/** Keeps every note's cards in memory and up to date as files change. Emits "changed". */
export class CardIndex extends Events {
  notes = new Map<string, NoteCards>();
  ready = false;
  private cache: IndexedCard[] | null = null;

  constructor(private app: App, private settings: () => IndexSettings) {
    super();
  }

  async build() {
    this.cache = null;
    this.notes.clear();
    let n = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      await this.update(file, false);
      if (++n % 200 === 0) await new Promise((r) => window.setTimeout(r, 0)); // keep the UI responsive
    }
    this.ready = true;
    this.trigger("changed");
  }

  isIgnored(path: string): boolean {
    const s = this.settings();
    if (path.startsWith(s.dataFolder + "/")) return true;
    return s.ignore.some((p) => p && (path.startsWith(p.replace(/\/?$/, "/")) || path.includes(p)));
  }

  /** Re-reads one note. With `notify`, emits "edited" (path, old blocks, new blocks) when it had or has cards. */
  async update(file: TFile, notify = true) {
    const before = this.notes.get(file.path)?.blocks ?? [];
    const edited = (after: CardBlock[]) => {
      if (notify && this.ready && (before.length || after.length)) this.trigger("edited", file.path, before, after);
    };
    if (file.extension !== "md" || this.isIgnored(file.path)) {
      this.remove(file.path, notify);
      return;
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.cards === false) {
      this.remove(file.path, notify);
      return;
    }
    const text = await this.app.vault.cachedRead(file);
    // Most notes have no cards: skip the full parse unless a card marker appears at all.
    const s = this.settings();
    const maybe = text.includes("::") || text.includes(";;") || text.includes(">>>") || /^\s*\?\??\s*$/m.test(text) || (s.braceCloze && text.includes("{{")) || (s.highlightCloze && text.includes("=="));
    const blocks = maybe ? parseNote(text, s) : [];
    if (!s.writeIds) assignTextIds(blocks);
    if (!blocks.length) {
      this.remove(file.path, notify);
      edited(blocks);
      return;
    }
    const deck = typeof fm?.deck === "string" ? fm.deck : (file.parent?.path ?? "");
    const title = file.basename;
    // A note's H1 usually repeats its title; don't show "Organelles › Organelles".
    const withTitle = (ctx: string[]) => (ctx[0]?.trim().toLowerCase() === title.toLowerCase() ? [title, ...ctx.slice(1)] : [title, ...ctx]);
    const cards = blocks
      .flatMap((b) => expandBlock(b, this.settings()))
      .map((c) => {
        // Cards without an ID yet get a line-number key; make it unique across the vault.
        if (!c.blockId.startsWith("~")) return { ...c, context: withTitle(c.context) };
        const blockId = `~${file.path}${c.blockId}`;
        return { ...c, blockId, key: blockId + c.key.slice(c.blockId.length), context: withTitle(c.context) };
      });
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const tts = { front: str(fm?.["tts-front"]), back: str(fm?.["tts-back"]) };
    this.cache = null;
    this.notes.set(file.path, { path: file.path, deck: deck === "/" ? "" : deck, blocks, cards, tts });
    if (notify) this.trigger("changed");
    edited(blocks);
  }

  /** Recomputes the card list (dedupe settings changed); notes aren't re-read. */
  refresh() {
    this.cache = null;
    this.trigger("changed");
  }

  remove(path: string, notify = true) {
    const had = this.notes.delete(path);
    if (had) this.cache = null;
    if (had && notify) this.trigger("changed");
  }

  /**
   * Every card, in note order. With `dedupe`, a card found in several notes appears once —
   * from a note whose name contains `dedupePrefer` if there is one, else the first.
   */
  allCards(): IndexedCard[] {
    if (this.cache) return this.cache;
    const notes = [...this.notes.values()];
    const winner = new Map<string, string>();
    const s = this.settings();
    if (s.dedupe) {
      const want = s.dedupePrefer.trim().toLowerCase();
      const rank = (p: string) => (want && p.split("/").pop()!.toLowerCase().includes(want) ? 1 : 0);
      for (const n of notes)
        for (const c of n.cards) {
          const cur = winner.get(c.key);
          if (cur === undefined || rank(n.path) > rank(cur)) winner.set(c.key, n.path);
        }
    }
    this.cache = notes.flatMap((n) =>
      n.cards.filter((c) => !winner.size || winner.get(c.key) === n.path).map((c) => ({ ...c, path: n.path, deck: n.deck })),
    );
    return this.cache;
  }
}

export interface DeckNode {
  name: string;
  path: string;
  cards: number;
  notes: number;
  children: DeckNode[];
}

/** Folder tree of decks; counts include sub-decks. Folders without cards are left out. */
export function deckTree(index: CardIndex): DeckNode {
  const root: DeckNode = { name: "All cards", path: "", cards: 0, notes: 0, children: [] };
  for (const n of index.notes.values()) {
    let node = root;
    node.cards += n.cards.length;
    node.notes++;
    if (!n.deck) continue;
    let path = "";
    for (const part of n.deck.split("/")) {
      path = path ? `${path}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) node.children.push((child = { name: part, path, cards: 0, notes: 0, children: [] }));
      child.cards += n.cards.length;
      child.notes++;
      node = child;
    }
  }
  const sort = (n: DeckNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}
