// Edit tracking: keeps a card's history when its text changes. Pure: no Obsidian imports.
//
// Without written IDs a card's ID comes from its text, so an edit gives it a new ID. When a
// note changes, cards that vanished are paired with cards that appeared, and each pair is
// recorded as a "link" entry in the review log. Linked IDs are one card: they share history.
import type { BlockKind, CardBlock } from "./parser.ts";
import type { LogEntry } from "./scheduler.ts";

/** What edit tracking remembers about a card: enough to recognise it after an edit. */
export interface SnapCard {
  id: string;
  kind: BlockKind;
  q: string;
  a: string;
  /** Position among the note's cards, for telling apart equally similar candidates. */
  pos: number;
}

export function snapOf(blocks: CardBlock[]): SnapCard[] {
  return blocks.filter((b) => b.id).map((b, pos) => ({ id: b.id!, kind: b.kind, q: b.question, a: b.answer, pos }));
}

/** Union-find over block IDs, built from `link` entries. */
export class Links {
  private parent = new Map<string, string>();
  private members = new Map<string, string[]>();

  constructor(entries: LogEntry[] = []) {
    for (const e of entries) if (e.a === "link" && e.from) this.union(e.k, e.from);
  }

  get size() {
    return this.parent.size;
  }

  find(id: string): string {
    let r = id;
    while (this.parent.has(r)) r = this.parent.get(r)!;
    // Path compression.
    while (this.parent.has(id)) {
      const next = this.parent.get(id)!;
      if (next !== r) this.parent.set(id, r);
      id = next;
    }
    return r;
  }

  /** Joins two IDs; true if they weren't joined already. The smaller ID is the root, so every device agrees. */
  union(a: string, b: string): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    const [root, child] = ra < rb ? [ra, rb] : [rb, ra];
    this.parent.set(child, root);
    const m = [...(this.members.get(root) ?? [root]), ...(this.members.get(child) ?? [child])];
    this.members.set(root, m);
    this.members.delete(child);
    return true;
  }

  /** Every ID joined with `id`, itself included. */
  group(id: string): string[] {
    return this.members.get(this.find(id)) ?? [id];
  }

  /** Card key with its block ID replaced by the group's root: `abc#r` → `root#r`. */
  canon(key: string): string {
    if (!this.parent.size) return key;
    const i = key.indexOf("#");
    const block = i < 0 ? key : key.slice(0, i);
    const root = this.find(block);
    return root === block ? key : root + (i < 0 ? "" : key.slice(i));
  }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character pairs: 1 = identical, 0 = nothing in common. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const x = bigrams(a);
  const y = bigrams(b);
  let both = 0;
  for (const [g, n] of x) both += Math.min(n, y.get(g) ?? 0);
  return (2 * both) / (a.length - 1 + (b.length - 1));
}

const family = (k: BlockKind) => (k === "cloze" || k === "occlusion" ? k : "qa");

/** How likely `b` is `a` after an edit, 0–1. */
export function editScore(a: SnapCard, b: SnapCard): number {
  if (family(a.kind) !== family(b.kind)) return 0;
  const qa = norm(a.q);
  const qb = norm(b.q);
  const aa = norm(a.a);
  const ab = norm(b.a);
  if (qa === qb && qa.length >= 2) return 1; // only the answer changed
  if (aa === ab && aa.length >= 3) return 0.95; // only the question changed
  return similarity(`${qa}\u0000${aa}`, `${qb}\u0000${ab}`);
}

/** Below this, an edited card counts as a new one. */
export const MIN_EDIT_SCORE = 0.6;

/**
 * Pairs cards that vanished from a note with cards that appeared in it, best match first.
 * Each card is used at most once. Returns [old ID, new ID] pairs.
 */
export function matchEdits(removed: SnapCard[], added: SnapCard[], min = MIN_EDIT_SCORE): [string, string][] {
  const pairs: { from: SnapCard; to: SnapCard; score: number; dist: number }[] = [];
  for (const from of removed)
    for (const to of added) {
      const score = editScore(from, to);
      if (score >= min) pairs.push({ from, to, score, dist: Math.abs(from.pos - to.pos) });
    }
  pairs.sort((x, y) => y.score - x.score || x.dist - y.dist);
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();
  const out: [string, string][] = [];
  for (const p of pairs) {
    if (usedFrom.has(p.from.id) || usedTo.has(p.to.id)) continue;
    usedFrom.add(p.from.id);
    usedTo.add(p.to.id);
    out.push([p.from.id, p.to.id]);
  }
  return out;
}
