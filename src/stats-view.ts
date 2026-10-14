import type TalkingCards from "./main.ts";
import { barChart, barList, heatmap, statTile } from "./charts.ts";
import {
  replayWithReviews, perDay, lastDays, forecast, retention, breakdown, intervalHistogram, difficultyHistogram, INTERVAL_BUCKETS,
} from "./stats.ts";
import { streak } from "./scheduler.ts";

const DAY = 86400_000;

function minutes(ms: number): string {
  const m = ms / 60_000;
  return m < 1 ? `${Math.round(ms / 1000)}s` : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`;
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

/** Renders the Stats tab for one deck ("" = all). */
export function renderStats(el: HTMLElement, plugin: TalkingCards, deck: string) {
  const { store, settings, index } = plugin;
  const now = Date.now();
  const h = settings.dayStartHour;
  const cards = index.allCards().filter((c) => !deck || c.deck === deck || c.deck.startsWith(deck + "/"));
  const keys = cards.map((c) => c.key);
  const keySet = new Set(keys.map((k) => store.links.canon(k)));
  const { reviews: all } = replayWithReviews(store.entries, store.fsrs, settings, (k) => store.links.canon(k));
  const reviews = deck ? all.filter((r) => keySet.has(r.k)) : all;
  const states = store.states;
  const days = perDay(reviews, h);

  // ---- tiles ----
  const tiles = el.createDiv({ cls: "tc-strip" });
  const ret = retention(reviews, now - 30 * DAY);
  statTile(tiles, "Retention, 30 days", ret.rate === null ? "—" : `${Math.round(ret.rate * 100)}%`, ret.total ? `${ret.passed} of ${ret.total} reviews` : "no reviews yet");
  const today = days.get(lastDays(now, 1, h)[0].key);
  statTile(tiles, "Today", String(today?.count ?? 0), today ? minutes(today.ms) : undefined);
  const month = lastDays(now, 30, h).map((d) => days.get(d.key));
  const monthCount = month.reduce((n, d) => n + (d?.count ?? 0), 0);
  statTile(tiles, "Last 30 days", String(monthCount), `${Math.round(monthCount / 30)} a day`);
  statTile(tiles, "Day streak", String(streak(store.entries, now, h)));

  // ---- year heatmap ----
  const year = lastDays(now, 365, h);
  const studied = year.filter((d) => days.has(d.key)).length;
  heatmap(
    el,
    "Reviews, last 12 months",
    year.map((d) => {
      const s = days.get(d.key);
      const date = d.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
      return { key: d.key, date: d.date, count: s?.count ?? 0, tip: s ? `${date}: ${plural(s.count, "review")}, ${minutes(s.ms)}` : `${date}: none` };
    }),
    `${studied} of 365 days studied`,
  );

  // ---- forecast ----
  const fc = forecast(keys, states, now, 30, h);
  barChart(
    el,
    "Due in the next 30 days",
    fc.map((n, i) => {
      const date = new Date(now + i * DAY);
      const label = i === 0 ? "Today" : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
      return { label, value: n, tip: `${label}: ${plural(n, "card")}${i === 0 ? " (incl. overdue)" : ""}`, showLabel: i % 7 === 0 };
    }),
    ["Day", "Cards due"],
    plural(fc.reduce((a, b) => a + b, 0), "card"),
  );

  // ---- reviews per day ----
  barChart(
    el,
    "Reviews per day, last 30 days",
    lastDays(now, 30, h).map((d, i, arr) => {
      const s = days.get(d.key);
      const label = d.date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
      return { label, value: s?.count ?? 0, tip: `${label}: ${plural(s?.count ?? 0, "review")}${s ? `, ${minutes(s.ms)}` : ""}`, showLabel: (arr.length - 1 - i) % 7 === 0 };
    }),
    ["Day", "Reviews"],
  );

  // ---- card states ----
  const b = breakdown(keys, states);
  barList(el, "Cards by state", [
    { label: "New", value: b.new },
    { label: "Learning", value: b.learning },
    { label: "Young (< 21 days)", value: b.young },
    { label: "Mature (21+ days)", value: b.mature },
    { label: "Suspended", value: b.suspended },
  ]);

  // ---- intervals & difficulty ----
  const iv = intervalHistogram(keys, states);
  barChart(
    el,
    "Current intervals",
    INTERVAL_BUCKETS.map(([label], i) => ({ label, value: iv[i], tip: `${label}: ${plural(iv[i], "card")}`, showLabel: true })),
    ["Interval", "Cards"],
  );
  const df = difficultyHistogram(keys, states);
  barChart(
    el,
    "Difficulty (FSRS)",
    df.map((n, i) => ({ label: String(i + 1), value: n, tip: `Difficulty ${i + 1}: ${plural(n, "card")}`, showLabel: true })),
    ["Difficulty", "Cards"],
    "1 = easy, 10 = hard",
  );
}
