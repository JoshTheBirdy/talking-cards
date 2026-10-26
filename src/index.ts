import { Events, TFile, type App } from "obsidian";
import { parseNote, expandBlock, assignTextIds, type Card, type CardBlock, type ParseOptions } from "./parser.ts";
import { cardsInScope, type Scope } from "./scope.ts";
import { isLogFileName } from "./logfile.ts";

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
  /** The same question + answer in several notes is one card (one history), shown once per review. */
  dedupe: boolean;
  /** With dedupe: when a review holds several copies, show the context of a note whose name contains this. */
  dedupePrefer: string;
  /** Editing a card's text keeps its history (matched by similarity; see links.ts). */
  trackEdits: boolean;
}

export type IndexedCard = Card & { path: string; deck: string };

/** Keeps every note's cards in memory and up to date as files change. Emits "changed". */
export class CardIndex extends Events {
  notes = new Map<string, NoteCards>();
  ready = false;
  /** Every copy of every card, duplicates included. */
  private cache: IndexedCard[] | null = null;
  /** cardsIn() results, per scope. Cleared with `cache`. */
  private scoped = new Map<string, IndexedCard[]>();

  constructor(private app: App, private settings: () => IndexSettings) {
    super();
  }

  async build() {
    this.invalidate();
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
    if (file.extension !== "md" || this.isIgnored(file.path) || isLogFileName(file.name)) {
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
    const maybe = text.includes("occlusion") || text.includes("::") || text.includes(";;") || text.includes(">>>") || /^\s*\?\??\s*$/m.test(text) || (s.braceCloze && text.includes("{{")) || (s.highlightCloze && text.includes("=="));
    const blocks = maybe ? parseNote(text, s) : [];
    assignTextIds(blocks, s.writeIds ? ["occlusion"] : undefined);
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
    this.invalidate();
    this.notes.set(file.path, { path: file.path, deck: deck === "/" ? "" : deck, blocks, cards, tts });
    if (notify) this.trigger("changed");
    edited(blocks);
  }

  /** Recomputes the card list (dedupe settings changed); notes aren't re-read. */
  refresh() {
    this.invalidate();
    this.trigger("changed");
  }

  remove(path: string, notify = true) {
    const had = this.notes.delete(path);
    if (had) this.invalidate();
    if (had && notify) this.trigger("changed");
  }

  private invalidate() {
    this.cache = null;
    this.scoped.clear();
  }

  /** Every copy of every card, in note order: a card written in two notes appears twice. */
  copies(): IndexedCard[] {
    this.cache ??= [...this.notes.values()].flatMap((n) => n.cards.map((c) => ({ ...c, path: n.path, deck: n.deck })));
    return this.cache;
  }

  /**
   * The cards a review serves: every card written in the folder / note / vault. With `dedupe`,
   * copies of the same card count once (they share one history either way).
   */
  cardsIn(scope: Scope): IndexedCard[] {
    const id = `${scope.kind}\u0000${scope.value}`;
    let list = this.scoped.get(id);
    if (!list) {
      const s = this.settings();
      list = cardsInScope(this.copies(), scope, s.dedupe, s.dedupePrefer);
      this.scoped.set(id, list);
    }
    return list;
  }

  /** Every card in the vault, each once. */
  allCards(): IndexedCard[] {
    return this.cardsIn({ kind: "all", value: "" });
  }
}

export interface DeckNode {
  name: string;
  path: string;
  cards: number;
  notes: number;
  children: DeckNode[];
}

/**
 * Folder tree of decks. `cards` is what studying that folder serves (sub-folders included), so a
 * card written in two notes under one folder counts once. Folders without cards are left out.
 */
export function deckTree(index: CardIndex, dedupe = true): DeckNode {
  const root: DeckNode = { name: "All cards", path: "", cards: 0, notes: 0, children: [] };
  const keys = new Map<DeckNode, Set<string>>();
  const count = (node: DeckNode, key: string) => {
    if (!dedupe) return void node.cards++;
    let set = keys.get(node);
    if (!set) keys.set(node, (set = new Set()));
    set.add(key);
  };
  const nodeFor = (deck: string, addNote: boolean): DeckNode[] => {
    const chain = [root];
    if (addNote) root.notes++;
    if (!deck) return chain;
    let node = root;
    let path = "";
    for (const part of deck.split("/")) {
      path = path ? `${path}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) node.children.push((child = { name: part, path, cards: 0, notes: 0, children: [] }));
      if (addNote) child.notes++;
      chain.push(child);
      node = child;
    }
    return chain;
  };
  for (const n of index.notes.values()) {
    const chain = nodeFor(n.deck, true);
    for (const c of n.cards) for (const node of chain) count(node, c.key);
  }
  if (dedupe) for (const [node, set] of keys) node.cards = set.size;
  const sort = (n: DeckNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}
