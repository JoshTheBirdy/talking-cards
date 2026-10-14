import { FuzzySuggestModal, normalizePath, type App } from "obsidian";
import type TalkingCards from "./main.ts";
import type { CardBlock } from "./parser.ts";
import { matchEdits, snapOf, type SnapCard } from "./links.ts";

/** A reviewed card that vanished and wasn't matched to an edit; kept so it can be merged by hand. */
export interface LostCard extends SnapCard {
  path: string;
  at: number;
}

interface Snapshot {
  v: 1;
  /** Per note: every card ID, plus the text of cards with history. */
  notes: Record<string, { ids: string[]; cards: SnapCard[] }>;
  lost: LostCard[];
}

/** A reviewed card that vanishes stays matchable this long, so an answer retyped from scratch still counts as an edit. */
const POOL_MS = 5 * 60_000;
const MAX_LOST = 300;
const SAVE_DELAY = 20_000;

/**
 * Keeps a card's history when its text is edited (cards without written IDs get a new ID on
 * every edit). Watches note edits as they happen, and on startup compares against a snapshot
 * to catch edits made while Obsidian was closed or before Sync delivered them.
 */
export class EditTracker {
  lost: LostCard[] = [];
  private pool = new Map<string, LostCard[]>();
  private saveTimer: number | null = null;
  private written = "";

  constructor(private plugin: TalkingCards) {}

  private get file() {
    return normalizePath(`${this.plugin.manifest.dir}/edit-snapshot.json`);
  }

  private get on() {
    return this.plugin.settings.trackEdits;
  }

  /** Card IDs in every note except `path`: a card that still exists elsewhere was moved, not edited. */
  private idsOutside(path: string): Set<string> {
    const ids = new Set<string>();
    for (const n of this.plugin.index.notes.values()) if (n.path !== path) for (const b of n.blocks) if (b.id) ids.add(b.id);
    return ids;
  }

  /** A note's cards changed while Obsidian was running. */
  onEdited(path: string, before: CardBlock[], after: CardBlock[]) {
    this.scheduleSave();
    if (!this.on) return;
    const store = this.plugin.store;
    const now = Date.now();
    const afterIds = new Set(after.map((b) => b.id));
    const beforeIds = new Set(before.map((b) => b.id));
    const pooled = (this.pool.get(path) ?? []).filter((c) => now - c.at < POOL_MS && !afterIds.has(c.id));
    const gone = snapOf(before).filter((c) => !afterIds.has(c.id) && store.hasHistory(c.id));
    if (!gone.length && !pooled.length) return;
    const elsewhere = this.idsOutside(path);
    const removed = [...pooled, ...gone.filter((c) => !elsewhere.has(c.id)).map((c) => ({ ...c, path, at: now }))];
    const added = snapOf(after).filter((c) => !beforeIds.has(c.id) && !elsewhere.has(c.id) && !store.hasHistory(c.id));
    this.resolve(path, removed, added, now);
  }

  private resolve(path: string, removed: LostCard[], added: SnapCard[], now: number) {
    const linked = new Set<string>();
    for (const [from, to] of matchEdits(removed, added)) {
      this.plugin.store.link(from, to, now);
      linked.add(from);
    }
    const left = removed.filter((c) => !linked.has(c.id));
    if (left.length) this.pool.set(path, left);
    else this.pool.delete(path);
    // Unmatched cards go to the lost list (newest first) for "Take progress from…".
    const leftIds = new Set(left.map((c) => c.id));
    this.lost = [...left, ...this.lost.filter((c) => !leftIds.has(c.id) && !linked.has(c.id))].slice(0, MAX_LOST);
  }

  /** At startup, after the index and store are ready: catches edits made while the plugin wasn't running. */
  async checkSnapshot() {
    const snap = await this.read();
    if (!snap) return this.scheduleSave();
    const { index, store } = this.plugin;
    const present = new Set<string>();
    for (const n of index.notes.values()) for (const b of n.blocks) if (b.id) present.add(b.id);
    this.lost = snap.lost.filter((c) => !present.has(c.id) && !this.isLinkedToPresent(c.id, present));
    if (this.on) {
      const now = Date.now();
      for (const [path, old] of Object.entries(snap.notes)) {
        const removed = old.cards.filter((c) => !present.has(c.id) && store.hasHistory(c.id) && !this.isLinkedToPresent(c.id, present));
        if (!removed.length) continue;
        const oldIds = new Set(old.ids);
        const blocks = index.notes.get(path)?.blocks ?? [];
        const added = snapOf(blocks).filter((c) => !oldIds.has(c.id) && !store.hasHistory(c.id));
        this.resolve(path, removed.map((c) => ({ ...c, path, at: now })), added, now);
      }
      this.pool.clear(); // the startup pass is a one-off; don't hold these for live edits
    }
    this.scheduleSave();
  }

  /** True if another device already linked this card to one that exists now. */
  private isLinkedToPresent(id: string, present: Set<string>): boolean {
    return this.plugin.store.links.group(id).some((m) => m !== id && present.has(m));
  }

  /** Joins a lost card's history to `blockId` by hand. */
  merge(lost: LostCard, blockId: string) {
    this.plugin.store.link(lost.id, blockId);
    this.lost = this.lost.filter((c) => c.id !== lost.id);
    this.scheduleSave();
  }

  scheduleSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), SAVE_DELAY);
  }

  async save() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const { index, store } = this.plugin;
    if (!index.ready || !store.ready) return;
    const notes: Snapshot["notes"] = {};
    for (const n of index.notes.values()) {
      const snaps = snapOf(n.blocks);
      notes[n.path] = { ids: snaps.map((c) => c.id), cards: snaps.filter((c) => store.hasHistory(c.id)) };
    }
    const text = JSON.stringify({ v: 1, notes, lost: this.lost } satisfies Snapshot);
    if (text === this.written) return;
    await this.plugin.app.vault.adapter.write(this.file, text);
    this.written = text;
  }

  private async read(): Promise<Snapshot | null> {
    try {
      const snap = JSON.parse(await this.plugin.app.vault.adapter.read(this.file)) as Snapshot | null;
      return snap?.v === 1 ? snap : null;
    } catch {
      return null;
    }
  }
}

/** Picks a lost card whose progress should move to the selected one. */
export class LostCardModal extends FuzzySuggestModal<LostCard> {
  constructor(app: App, private cards: LostCard[], private pick: (c: LostCard) => void) {
    super(app);
    this.setPlaceholder("Card whose progress to take…");
    this.emptyStateText = "No removed cards with progress";
  }
  getItems() {
    return this.cards;
  }
  getItemText(c: LostCard) {
    const note = c.path.replace(/\.md$/, "").split("/").pop();
    return `${c.q}${c.a ? ` — ${c.a.split("\n")[0]}` : ""}  (${note})`;
  }
  onChooseItem(c: LostCard) {
    this.pick(c);
  }
}
