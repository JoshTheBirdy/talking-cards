// Rough timings for the heavy paths. Not part of `npm test`; run with:
//   node test/perf.ts [path-to-vault]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseNote, expandBlock } from "../src/parser.ts";
import { makeFsrs, DEFAULT_SCHEDULER, replay, buildQueue, todayCounts, groupByKey, replayKeys, type LogEntry, type QueueCard } from "../src/scheduler.ts";
import { replayWithReviews, perDay } from "../src/stats.ts";
import { formatLogFile, parseLogFile } from "../src/logfile.ts";

const time = <T>(label: string, fn: () => T): T => {
  const t = performance.now();
  const r = fn();
  console.log(`${label.padEnd(52)} ${(performance.now() - t).toFixed(1).padStart(8)} ms`);
  return r;
};

// 1. Parse a real vault.
const vault = process.argv[2];
if (vault) {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      if (f.startsWith(".")) continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".md")) files.push(p);
    }
  };
  walk(vault);
  const texts = files.map((f) => readFileSync(f, "utf8"));
  const mb = texts.reduce((n, t) => n + t.length, 0) / 1e6;
  const blocks = time(`parse ${files.length} notes (${mb.toFixed(1)} MB), no prefilter`, () => texts.flatMap((t) => parseNote(t)));
  const maybe = (t: string) => t.includes("::") || t.includes(">>>") || /^\s*\?\??\s*$/m.test(t) || t.includes("{{");
  time("parse with the index's prefilter", () => texts.flatMap((t) => (maybe(t) ? parseNote(t) : [])));
  console.log(`  notes needing a full parse: ${texts.filter(maybe).length}`);
  time(`expand ${blocks.length} blocks`, () => blocks.flatMap((b) => expandBlock(b)));
}

// 2. Synthetic heavy user: 5,000 cards in 100 decks, ~3 years of daily study.
const S = DEFAULT_SCHEDULER;
const f = makeFsrs(S);
const D = 86400_000;
const now = Date.now();
const N = 5000;
const cards: (QueueCard & { deck: string })[] = Array.from({ length: N }, (_, i) => ({ key: `k${i}`, blockId: `k${i}`, deck: `Deck${i % 100}` }));
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const entries: LogEntry[] = [];
for (let i = 0; i < N; i++) {
  let t = now - 1100 * D + (i / N) * 1000 * D;
  let ivl = 1;
  while (t < now) {
    const r = (rnd() < 0.1 ? 1 : 3) as 1 | 3;
    entries.push({ t, k: cards[i].key, r, ms: 5000 });
    ivl = r === 1 ? 1 : ivl * 2.5;
    t += ivl * D;
  }
}
console.log(`\nsynthetic: ${N} cards, ${entries.length} log entries`);

const text = time("format log file", () => formatLogFile("linux-perf", entries));
console.log(`  log file size: ${(text.length / 1e6).toFixed(1)} MB`);
time("parse log file", () => parseLogFile(text));
const states = time("replay (load / remote sync)", () => replay(entries, f, S));
time("replayWithReviews (Stats tab)", () => replayWithReviews(entries, f, S));
const reviews = replayWithReviews(entries, f, S).reviews;
time("perDay (heatmap)", () => perDay(reviews, 4));
const counts = time("todayCounts", () => todayCounts(entries, now, 4));
time("buildQueue all cards", () => buildQueue(cards, states, counts, now, { newPerDay: 20, reviewsPerDay: 200, burySiblings: true }, 4));
time("dashboard: 100 deck rows, todayCounts each (old)", () => {
  for (let d = 0; d < 100; d++) {
    const dc = cards.filter((c) => c.deck === `Deck${d}`);
    buildQueue(dc, states, todayCounts(entries, now, 4), now, { newPerDay: 20, reviewsPerDay: 200, burySiblings: true }, 4);
  }
});
time("dashboard: 100 deck rows, cached todayCounts (new)", () => {
  for (let d = 0; d < 100; d++) {
    const dc = cards.filter((c) => c.deck === `Deck${d}`);
    buildQueue(dc, states, counts, now, { newPerDay: 20, reviewsPerDay: 200, burySiblings: true }, 4);
  }
});
const groups = time("groupByKey", () => groupByKey(entries));
time("replayKeys: another device reviewed 100 cards", () => replayKeys(states, groups, cards.slice(0, 100).map((c) => c.key), f, S));
time("replayKeys: bulk suspend 500 cards", () => replayKeys(states, groups, cards.slice(0, 500).map((c) => c.key), f, S));
