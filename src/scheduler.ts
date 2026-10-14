// Turns review logs into card state with FSRS, and builds study queues. Pure: no Obsidian imports.
import { fsrs, createEmptyCard, generatorParameters, State, type Card as FsrsCard, type FSRS } from "ts-fsrs";

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export const RATING_NAMES = ["Again", "Hard", "Good", "Easy"] as const;

/** One line of a review log. Either a review (`r`) or a card action (`a`). */
export interface LogEntry {
  /** Unix ms. Also the replay order across devices. */
  t: number;
  /** Card key, e.g. `a1b2c3`, `a1b2c3#r`, `a1b2c3#c2`. */
  k: string;
  r?: Rating;
  /** `link`: `k` is the same card as block `from` after an edit (both are block IDs). */
  a?: "suspend" | "unsuspend" | "bury" | "reset" | "link";
  from?: string;
  /** Time spent on the card, ms. */
  ms?: number;
}

export interface CardState {
  fsrs: FsrsCard;
  suspended: boolean;
  /** Buried until this day key (YYYY-MM-DD in study-day terms). */
  buriedUntil: string | null;
  firstReview: number | null;
  lastReview: number | null;
}

export interface SchedulerSettings {
  retention: number;
  maxInterval: number;
  learningSteps: string[];
  relearningSteps: string[];
  /** Hour the study day rolls over, like Anki's "next day starts at". */
  dayStartHour: number;
}

export const DEFAULT_SCHEDULER: SchedulerSettings = {
  retention: 0.9,
  maxInterval: 36500,
  learningSteps: ["1m", "10m"],
  relearningSteps: ["10m"],
  dayStartHour: 4,
};

export function makeFsrs(s: SchedulerSettings): FSRS {
  return fsrs(
    generatorParameters({
      request_retention: s.retention,
      maximum_interval: s.maxInterval,
      enable_fuzz: true,
      enable_short_term: true,
      learning_steps: s.learningSteps as never,
      relearning_steps: s.relearningSteps as never,
    }),
  );
}

/** Study-day key for a timestamp: the day rolls over at `dayStartHour` local time. */
export function dayKey(t: number, dayStartHour: number): string {
  const d = new Date(t - dayStartHour * 3600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Timestamp at which the study day containing `t` ends. */
export function endOfDay(t: number, dayStartHour: number): number {
  const d = new Date(t - dayStartHour * 3600_000);
  d.setHours(24 + dayStartHour, 0, 0, 0);
  return d.getTime();
}

export function nextDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const n = new Date(y, m - 1, d + 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export function emptyState(t = 0): CardState {
  return { fsrs: createEmptyCard<FsrsCard>(new Date(t)), suspended: false, buriedUntil: null, firstReview: null, lastReview: null };
}

/** Applies one entry to a card's state (or creates it). Shared by every replay path. */
export function applyEntry(states: Map<string, CardState>, e: LogEntry, f: FSRS, s: SchedulerSettings, key = e.k) {
  if (e.a === "link") return;
  let st = states.get(key);
  if (!st) states.set(key, (st = emptyState(e.t)));
  if (e.r) {
    st.fsrs = f.next(st.fsrs, new Date(e.t), e.r).card;
    st.firstReview ??= e.t;
    st.lastReview = e.t;
  } else if (e.a === "suspend") st.suspended = true;
  else if (e.a === "unsuspend") st.suspended = false;
  else if (e.a === "bury") st.buriedUntil = nextDayKey(dayKey(e.t, s.dayStartHour));
  else if (e.a === "reset") states.set(key, emptyState(e.t));
}

const byTime = (a: LogEntry, b: LogEntry) => a.t - b.t || a.k.localeCompare(b.k);

/** Replays every device's log in time order. Same input → same state, on every device. */
export function replay(entries: LogEntry[], f: FSRS, s: SchedulerSettings): Map<string, CardState> {
  const states = new Map<string, CardState>();
  for (const e of [...entries].sort(byTime)) applyEntry(states, e, f, s);
  return states;
}

/** Entries grouped by card, each group in time order. A card's state depends only on its own group. */
export function groupByKey(entries: LogEntry[], keyOf: (k: string) => string = (k) => k): Map<string, LogEntry[]> {
  const g = new Map<string, LogEntry[]>();
  for (const e of entries) {
    if (e.a === "link") continue;
    const k = keyOf(e.k);
    const list = g.get(k);
    if (list) list.push(e);
    else g.set(k, [e]);
  }
  for (const list of g.values()) list.sort(byTime);
  return g;
}

/** Recomputes only `keys` (e.g. the cards another device just reviewed), in place. */
export function replayKeys(states: Map<string, CardState>, groups: Map<string, LogEntry[]>, keys: Iterable<string>, f: FSRS, s: SchedulerSettings) {
  for (const k of keys) {
    states.delete(k);
    for (const e of groups.get(k) ?? []) applyEntry(states, e, f, s, k);
  }
}

export function isNew(st: CardState | undefined): boolean {
  return !st || st.fsrs.state === State.New;
}

export function isLearning(st: CardState | undefined): boolean {
  return !!st && (st.fsrs.state === State.Learning || st.fsrs.state === State.Relearning);
}

/** Predicted next due date for each rating, for the grade buttons. */
export function preview(st: CardState | undefined, now: number, f: FSRS): Record<Rating, number> {
  const card: FsrsCard = st?.fsrs ?? createEmptyCard<FsrsCard>(new Date(now));
  const p = f.repeat(card, new Date(now));
  return { 1: +p[1].card.due, 2: +p[2].card.due, 3: +p[3].card.due, 4: +p[4].card.due };
}

/** "45s", "10m", "3h", "4d", "2.1mo", "1.3y" */
export function formatInterval(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  const d = s / 86400;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${(d / 30).toFixed(1).replace(/\.0$/, "")}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

export interface QueueCard {
  key: string;
  blockId: string;
}

export interface QueueLimits {
  newPerDay: number;
  reviewsPerDay: number;
  burySiblings: boolean;
}

export interface DayCounts {
  newToday: number;
  reviewsToday: number;
  /** Block IDs with a card reviewed today — their siblings wait until tomorrow. */
  blocksToday: Set<string>;
}

export function todayCounts(entries: LogEntry[], now: number, dayStartHour: number, keyOf: (k: string) => string = (k) => k): DayCounts {
  const today = dayKey(now, dayStartHour);
  const first = new Map<string, number>();
  for (const e of entries) if (e.r && !(first.get(keyOf(e.k))! <= e.t)) first.set(keyOf(e.k), e.t);
  let newToday = 0;
  let reviewsToday = 0;
  const blocksToday = new Set<string>();
  for (const e of entries) {
    if (!e.r || dayKey(e.t, dayStartHour) !== today) continue;
    blocksToday.add(e.k.split("#")[0]);
    if (first.get(keyOf(e.k)) === e.t) newToday++;
    else reviewsToday++;
  }
  return { newToday, reviewsToday, blocksToday };
}

export interface Queue {
  learning: QueueCard[];
  review: QueueCard[];
  new: QueueCard[];
}

/**
 * Cards to study now from `cards` (already filtered to a deck or note, in note order).
 * Learning cards due now come first; reviews due today; then new cards up to the daily limit.
 */
export function buildQueue(
  cards: QueueCard[],
  states: Map<string, CardState>,
  counts: DayCounts,
  now: number,
  limits: QueueLimits,
  dayStartHour: number,
): Queue {
  const today = dayKey(now, dayStartHour);
  const eod = endOfDay(now, dayStartHour);
  const q: Queue = { learning: [], review: [], new: [] };
  const usedBlocks = new Set(limits.burySiblings ? counts.blocksToday : []);
  const due = (c: QueueCard) => +states.get(c.key)!.fsrs.due;

  const live = cards.filter((c) => {
    const st = states.get(c.key);
    return !(st?.suspended || (st?.buriedUntil && st.buriedUntil > today));
  });

  // Learning cards ignore sibling burying: they're mid-step today.
  for (const c of live) if (isLearning(states.get(c.key)) && due(c) <= eod) q.learning.push(c);
  q.learning.sort((a, b) => due(a) - due(b));
  for (const c of q.learning) usedBlocks.add(c.blockId);

  const reviewRoom = Math.max(0, limits.reviewsPerDay - counts.reviewsToday);
  const reviews = live
    .filter((c) => {
      const st = states.get(c.key);
      return st && st.fsrs.state === State.Review && due(c) <= eod;
    })
    .sort((a, b) => due(a) - due(b));
  for (const c of reviews) {
    if (q.review.length >= reviewRoom) break;
    if (limits.burySiblings && usedBlocks.has(c.blockId)) continue;
    usedBlocks.add(c.blockId);
    q.review.push(c);
  }

  const newRoom = Math.max(0, limits.newPerDay - counts.newToday);
  for (const c of live) {
    if (q.new.length >= newRoom) break;
    if (!isNew(states.get(c.key))) continue;
    if (limits.burySiblings && usedBlocks.has(c.blockId)) continue;
    usedBlocks.add(c.blockId);
    q.new.push(c);
  }
  return q;
}

/** Interleaves new cards evenly among reviews, Anki-style. */
export function mixQueue(q: Queue): QueueCard[] {
  const out: QueueCard[] = [];
  const { review, new: fresh } = q;
  if (!fresh.length) return [...review];
  if (!review.length) return [...fresh];
  const every = Math.max(1, Math.floor(review.length / fresh.length));
  let n = 0;
  review.forEach((c, i) => {
    out.push(c);
    if ((i + 1) % every === 0 && n < fresh.length) out.push(fresh[n++]);
  });
  while (n < fresh.length) out.push(fresh[n++]);
  return out;
}

export function streak(entries: LogEntry[], now: number, dayStartHour: number): number {
  const days = new Set(entries.filter((e) => e.r).map((e) => dayKey(e.t, dayStartHour)));
  let key = dayKey(now, dayStartHour);
  let t = now;
  if (!days.has(key)) {
    t -= 86400_000;
    key = dayKey(t, dayStartHour);
  }
  let n = 0;
  while (days.has(key)) {
    n++;
    t -= 86400_000;
    key = dayKey(t, dayStartHour);
  }
  return n;
}
