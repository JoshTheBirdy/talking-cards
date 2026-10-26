// Which cards a review serves. Pure: no Obsidian imports.
//
// A card written in several notes (same text, so the same key) is one card with one review
// history. Each place it's written still shows it: duplicates are removed within a review, not
// across the vault, so a folder or note always gets every card written inside it.

export type ScopeKind = "all" | "deck" | "note";

export interface Scope {
  kind: ScopeKind;
  /** Folder path for "deck" ("" = notes at the vault root), note path for "note". */
  value: string;
}

export interface CardCopy {
  key: string;
  path: string;
  deck: string;
}

export function inScope(c: CardCopy, scope: Scope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "note") return c.path === scope.value;
  return c.deck === scope.value || c.deck.startsWith(scope.value + "/");
}

/**
 * One copy per card key, in the order cards first appear. When several notes hold the card, the
 * copy from a note whose name contains `prefer` is the one shown (its note title and headings);
 * otherwise the first. Nothing is dropped except repeats of a card already kept.
 */
export function dedupeCopies<T extends CardCopy>(copies: T[], prefer: string): T[] {
  const want = prefer.trim().toLowerCase();
  const preferred = (c: T) => !!want && c.path.split("/").pop()!.toLowerCase().includes(want);
  const kept = new Map<string, number>(); // key → index in out
  const out: T[] = [];
  for (const c of copies) {
    const at = kept.get(c.key);
    if (at === undefined) {
      kept.set(c.key, out.length);
      out.push(c);
    } else if (preferred(c) && !preferred(out[at])) {
      out[at] = c; // same place in the order, the preferred note's context
    }
  }
  return out;
}

/**
 * The cards a review serves: every card written inside the scope, each once (when `dedupe`).
 * `active`: only cards with these keys (see activity.ts); null = no filter.
 */
export function cardsInScope<T extends CardCopy>(copies: T[], scope: Scope, dedupe: boolean, prefer: string, active: Set<string> | null = null): T[] {
  let inside = scope.kind === "all" ? copies : copies.filter((c) => inScope(c, scope));
  if (active) inside = inside.filter((c) => active.has(c.key));
  return dedupe ? dedupeCopies(inside, prefer) : inside;
}
