// Which folders and notes are active for studying. Pure: no Obsidian imports.
//
// Everything is active unless switched off. A switch applies to a folder and everything inside
// it; the nearest one wins, so a note or sub-folder can be switched back on inside an inactive
// folder. A card is active if any of its copies is in an active place: switching off a chapter
// folder doesn't hide cards that an active exam-prep note also holds.
//
// Stored in the vault (so Sync carries it to every device) as a note in the data folder:
//   ```talking-cards-study
//   - Uni/Y2 S1
//   + Uni/Y2 S1/PSYC211
//   ```
// `-` = inactive, `+` = active again inside an inactive folder.

export type Rules = Map<string, boolean>;

export const ACTIVITY_FILE = "study-folders.md";
const FENCE = "```talking-cards-study";

export function parseRules(text: string): Rules {
  const rules: Rules = new Map();
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!inside) {
      if (line === FENCE) inside = true;
      continue;
    }
    if (line.startsWith("```")) break;
    const m = /^([+-])\s+(.+)$/.exec(line);
    if (m) rules.set(m[2].trim().replace(/\/+$/, ""), m[1] === "+");
  }
  return rules;
}

export function formatRules(rules: Rules): string {
  const lines = [...rules.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, on]) => `${on ? "+" : "-"} ${p}`);
  return [
    "---",
    "talking-cards: study-folders",
    "---",
    "Folders and notes switched off for studying, written by the Talking Cards plugin. `-` = inactive, `+` = active again inside an inactive folder. Change them from the deck browser.",
    "",
    FENCE,
    ...lines,
    "```",
    "",
  ].join("\n");
}

/** A note or folder path is active unless it, or the nearest folder above it with a rule, is switched off. */
export function isActive(path: string, rules: Rules): boolean {
  if (!rules.size) return true;
  let p = path.replace(/\/+$/, "");
  for (;;) {
    const r = rules.get(p);
    if (r !== undefined) return r;
    const i = p.lastIndexOf("/");
    if (i < 0) return p === "" ? true : (rules.get("") ?? true);
    p = p.slice(0, i);
  }
}

/** Card keys with at least one copy in an active note. */
export function activeKeys(copies: { key: string; path: string }[], rules: Rules): Set<string> {
  const active = new Set<string>();
  const cache = new Map<string, boolean>();
  for (const c of copies) {
    let on = cache.get(c.path);
    if (on === undefined) cache.set(c.path, (on = isActive(c.path, rules)));
    if (on) active.add(c.key);
  }
  return active;
}

/**
 * Flips `path` and returns the new rules. The rule is dropped when the inherited state already
 * gives the wanted result, so the list stays short.
 */
export function toggle(rules: Rules, path: string): Rules {
  const next: Rules = new Map(rules);
  const want = !isActive(path, rules);
  next.delete(path);
  if (isActive(path, next) !== want) next.set(path, want);
  // Rules inside this folder that now say the same as it are redundant.
  for (const [p, on] of [...next]) {
    if (p.startsWith(path + "/") && on === want) {
      next.delete(p);
      if (isActive(p, next) !== on) next.set(p, on);
    }
  }
  return next;
}
