// Numbers for the Stats tab and the card browser. Pure: no Obsidian imports.
import { State, type FSRS } from "ts-fsrs";
import { dayKey, emptyState, nextDayKey, type CardState, type LogEntry, type SchedulerSettings } from "./scheduler.ts";

export interface ReviewRecord {
  t: number;
  k: string;
  rating: 1 | 2 | 3 | 4;
  /** Card state before this review: New, Learning, Review or Relearning. */
  before: State;
  ms: number;
}

/** Like scheduler.replay, but also returns every review with the state it was made in. */
export function replayWithReviews(entries: LogEntry[], f: FSRS, s: SchedulerSettings, keyOf: (k: string) => string = (k) => k): { states: Map<string, CardState>; reviews: ReviewRecord[] } {
  const sorted = [...entries].sort((a, b) => a.t - b.t || a.k.localeCompare(b.k));
  const states = new Map<string, CardState>();
  const reviews: ReviewRecord[] = [];
  for (const e of sorted) {
    if (e.a === "link") continue;
    const k = keyOf(e.k);
    let st = states.get(k);
    if (!st) states.set(k, (st = emptyState(e.t)));
    if (e.r) {
      reviews.push({ t: e.t, k, rating: e.r, before: st.fsrs.state, ms: e.ms ?? 0 });
      st.fsrs = f.next(st.fsrs, new Date(e.t), e.r).card;
      st.firstReview ??= e.t;
      st.lastReview = e.t;
    } else if (e.a === "suspend") st.suspended = true;
    else if (e.a === "unsuspend") st.suspended = false;
    else if (e.a === "bury") st.buriedUntil = nextDayKey(dayKey(e.t, s.dayStartHour));
    else if (e.a === "reset") states.set(k, emptyState(e.t));
  }
  return { states, reviews };
}

export interface DayStat {
  count: number;
  ms: number;
}

export function perDay(reviews: ReviewRecord[], dayStartHour: number): Map<string, DayStat> {
  const out = new Map<string, DayStat>();
  for (const r of reviews) {
    const k = dayKey(r.t, dayStartHour);
    const d = out.get(k) ?? { count: 0, ms: 0 };
    d.count++;
    d.ms += r.ms;
    out.set(k, d);
  }
  return out;
}

/** The last `n` study days, oldest first, as day keys with their dates (local midday). */
export function lastDays(now: number, n: number, dayStartHour: number): { key: string; date: Date }[] {
  const out: { key: string; date: Date }[] = [];
  const today = dayKey(now, dayStartHour);
  const [y, m, d] = today.split("-").map(Number);
  for (let i = n - 1; i >= 0; i--) {
    const date = new Date(y, m - 1, d - i, 12);
    out.push({ key: dayKey(date.getTime() + dayStartHour * 3600_000, dayStartHour), date });
  }
  return out;
}

/** Cards coming due per day; index 0 is today and includes anything overdue. */
export function forecast(keys: string[], states: Map<string, CardState>, now: number, days: number, dayStartHour: number): number[] {
  const out = new Array<number>(days).fill(0);
  const todayStart = dayStart(now, dayStartHour);
  for (const k of keys) {
    const st = states.get(k);
    if (!st || st.suspended || st.fsrs.state === State.New) continue;
    const i = Math.max(0, Math.floor((+st.fsrs.due - todayStart) / 86400_000));
    if (i < days) out[i]++;
  }
  return out;
}

function dayStart(t: number, dayStartHour: number): number {
  const d = new Date(t - dayStartHour * 3600_000);
  d.setHours(dayStartHour, 0, 0, 0);
  return d.getTime();
}

/** Share of reviews of mature-ish cards (state Review) that weren't forgotten. */
export function retention(reviews: ReviewRecord[], since: number, keys?: Set<string>): { total: number; passed: number; rate: number | null } {
  let total = 0;
  let passed = 0;
  for (const r of reviews) {
    if (r.t < since || r.before !== State.Review || (keys && !keys.has(r.k))) continue;
    total++;
    if (r.rating > 1) passed++;
  }
  return { total, passed, rate: total ? passed / total : null };
}

export const MATURE_DAYS = 21;

export interface Breakdown {
  new: number;
  learning: number;
  young: number;
  mature: number;
  suspended: number;
}

export function breakdown(keys: string[], states: Map<string, CardState>): Breakdown {
  const b: Breakdown = { new: 0, learning: 0, young: 0, mature: 0, suspended: 0 };
  for (const k of keys) {
    const st = states.get(k);
    if (st?.suspended) b.suspended++;
    else if (!st || st.fsrs.state === State.New) b.new++;
    else if (st.fsrs.state === State.Review) st.fsrs.scheduled_days >= MATURE_DAYS ? b.mature++ : b.young++;
    else b.learning++;
  }
  return b;
}

export const INTERVAL_BUCKETS: [string, number][] = [
  ["1d", 1], ["2–3d", 3], ["4–7d", 7], ["1–2w", 14], ["2w–1mo", 30], ["1–3mo", 91], ["3–6mo", 182], ["6–12mo", 365], ["1y+", Infinity],
];

export function intervalHistogram(keys: string[], states: Map<string, CardState>): number[] {
  const out = new Array<number>(INTERVAL_BUCKETS.length).fill(0);
  for (const k of keys) {
    const st = states.get(k);
    if (!st || st.suspended || st.fsrs.state !== State.Review) continue;
    const days = st.fsrs.scheduled_days;
    out[INTERVAL_BUCKETS.findIndex(([, max]) => days <= max)]++;
  }
  return out;
}

/** FSRS difficulty 1–10, in ten buckets. */
export function difficultyHistogram(keys: string[], states: Map<string, CardState>): number[] {
  const out = new Array<number>(10).fill(0);
  for (const k of keys) {
    const st = states.get(k);
    if (!st || st.suspended || st.fsrs.state === State.New) continue;
    out[Math.min(9, Math.max(0, Math.floor(st.fsrs.difficulty) - 1))]++;
  }
  return out;
}

export function isLeech(st: CardState | undefined, threshold: number): boolean {
  return !!st && threshold > 0 && st.fsrs.lapses >= threshold;
}

export function stateName(st: CardState | undefined): string {
  if (st?.suspended) return "Suspended";
  if (!st || st.fsrs.state === State.New) return "New";
  if (st.fsrs.state === State.Review) return st.fsrs.scheduled_days >= MATURE_DAYS ? "Mature" : "Young";
  return st.fsrs.state === State.Relearning ? "Relearning" : "Learning";
}
