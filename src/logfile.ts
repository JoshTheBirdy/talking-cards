// Review-log files: one per device per year, `.md` so Obsidian Sync always carries them.
import type { LogEntry } from "./scheduler.ts";

const FENCE = "```talking-cards";

export function logFileName(deviceId: string, year: number): string {
  return `reviews-${deviceId}-${year}.md`;
}

export function isLogFileName(name: string): boolean {
  return /^reviews-.+-\d{4}\.md$/.test(name);
}

export function deviceOf(name: string): string | null {
  return /^reviews-(.+)-\d{4}\.md$/.exec(name)?.[1] ?? null;
}

export function formatLogFile(deviceId: string, entries: LogEntry[]): string {
  return [
    "---",
    "talking-cards: review-log",
    `device: ${deviceId}`,
    "---",
    "Review history from one device, written by the Talking Cards plugin. Don't edit by hand.",
    "",
    FENCE,
    ...entries.map((e) => JSON.stringify(e)),
    "```",
    "",
  ].join("\n");
}

/** Lenient: skips lines that aren't valid entries (e.g. a sync conflict marker). */
export function parseLogFile(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!inside) {
      if (t === FENCE) inside = true;
      continue;
    }
    if (t.startsWith("```")) break;
    if (!t) continue;
    try {
      const e = JSON.parse(t) as Partial<LogEntry> | null;
      if (e && typeof e.t === "number" && typeof e.k === "string" && (e.r || e.a)) out.push(e as LogEntry);
    } catch {
      // ignore
    }
  }
  return out;
}

/** Same entry = same moment, card and action. */
export function entrySig(e: LogEntry): string {
  return `${e.t}|${e.k}|${e.r ?? ""}|${e.a ?? ""}|${e.from ?? ""}`;
}

/**
 * Drops repeated entries (a device's log found in two folders, or merged from both), keeping the
 * first of each. Order is otherwise unchanged.
 */
export function dedupeEntries(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const s = entrySig(e);
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}
