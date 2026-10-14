import { test } from "node:test";
import assert from "node:assert/strict";
import {
  replay, makeFsrs, DEFAULT_SCHEDULER, buildQueue, todayCounts, mixQueue, dayKey, streak, formatInterval,
  type LogEntry, type QueueCard,
} from "../src/scheduler.ts";

const S = DEFAULT_SCHEDULER;
const f = makeFsrs(S);
const H = 3600_000, D = 24 * H;
const T0 = new Date(2026, 9, 14, 12).getTime(); // noon local
const cards = (n: number): QueueCard[] => Array.from({ length: n }, (_, i) => ({ key: `c${i}`, blockId: `c${i}` }));
const limits = { newPerDay: 20, reviewsPerDay: 200, burySiblings: true };

test("replay is deterministic and order-independent across devices", () => {
  const phone: LogEntry[] = [{ t: T0, k: "a", r: 3 }, { t: T0 + 10 * 60_000, k: "a", r: 3 }, { t: T0 + 5 * D, k: "a", r: 3 }];
  const laptop: LogEntry[] = [{ t: T0 + 2 * D, k: "b", r: 1 }];
  const s1 = replay([...phone, ...laptop], f, S);
  const s2 = replay([...laptop, ...phone.slice().reverse()], f, S);
  assert.deepEqual(s1.get("a"), s2.get("a"));
  assert.equal(s1.get("a")!.fsrs.reps, 3);
  assert.ok(+s1.get("a")!.fsrs.due > T0 + 6 * D, "graduated card is due days later");
});

test("suspend, bury and reset", () => {
  const st = replay(
    [{ t: T0, k: "a", r: 3 }, { t: T0 + 1, k: "a", a: "suspend" }, { t: T0, k: "b", a: "bury" }, { t: T0, k: "c", r: 3 }, { t: T0 + 1, k: "c", a: "reset" }],
    f, S,
  );
  assert.equal(st.get("a")!.suspended, true);
  assert.equal(st.get("b")!.buriedUntil, dayKey(T0 + D, S.dayStartHour));
  assert.equal(st.get("c")!.fsrs.reps, 0);
});

test("new card limit counts cards introduced today, across devices", () => {
  const entries: LogEntry[] = [{ t: T0 - H, k: "c0", r: 3 }, { t: T0 - H, k: "c1", r: 3 }];
  const states = replay(entries, f, S);
  const counts = todayCounts(entries, T0, S.dayStartHour);
  assert.equal(counts.newToday, 2);
  const q = buildQueue(cards(10), states, counts, T0, { ...limits, newPerDay: 5 }, S.dayStartHour);
  assert.equal(q.new.length, 3);
  assert.equal(q.learning.length, 2, "both cards are still in learning steps today");
});

test("siblings are buried for the day", () => {
  const cs: QueueCard[] = [{ key: "x", blockId: "x" }, { key: "x#r", blockId: "x" }, { key: "y", blockId: "y" }];
  const q = buildQueue(cs, new Map(), todayCounts([], T0, 4), T0, limits, 4);
  assert.deepEqual(q.new.map((c) => c.key), ["x", "y"]);
  const q2 = buildQueue(cs, new Map(), todayCounts([], T0, 4), T0, { ...limits, burySiblings: false }, 4);
  assert.equal(q2.new.length, 3);
});

test("reviews due today are queued, future ones aren't", () => {
  const entries: LogEntry[] = [];
  for (const k of ["a", "b"]) entries.push({ t: T0 - 30 * D, k, r: 3 }, { t: T0 - 30 * D + 10 * 60_000, k, r: 3 });
  entries.push({ t: T0 - H, k: "b", r: 4 });
  const states = replay(entries, f, S);
  const q = buildQueue([{ key: "a", blockId: "a" }, { key: "b", blockId: "b" }], states, todayCounts(entries, T0, 4), T0, limits, 4);
  assert.deepEqual(q.review.map((c) => c.key), ["a"]);
});

test("day rolls over at the configured hour", () => {
  const twoAm = new Date(2026, 9, 15, 2).getTime();
  assert.equal(dayKey(twoAm, 4), "2026-10-14");
  assert.equal(dayKey(twoAm, 0), "2026-10-15");
});

test("mixQueue interleaves new among reviews", () => {
  const r = cards(6).map((c) => ({ ...c, key: "r" + c.key }));
  const n = cards(2).map((c) => ({ ...c, key: "n" + c.key }));
  assert.deepEqual(mixQueue({ learning: [], review: r, new: n }).map((c) => c.key), ["rc0", "rc1", "rc2", "nc0", "rc3", "rc4", "rc5", "nc1"]);
});

test("streak counts back from today or yesterday", () => {
  const e = (d: number): LogEntry => ({ t: T0 - d * D, k: "a", r: 3 });
  assert.equal(streak([e(0), e(1), e(2), e(4)], T0, 4), 3);
  assert.equal(streak([e(1), e(2)], T0, 4), 2);
  assert.equal(streak([e(3)], T0, 4), 0);
});

test("formatInterval", () => {
  assert.deepEqual([60_000, 10 * 60_000, 3 * H, 4 * D, 65 * D, 400 * D].map(formatInterval), ["1m", "10m", "3h", "4d", "2.2mo", "1.1y"]);
});

test("replayKeys matches a full replay for the cards it touches", async () => {
  const { replayKeys, groupByKey } = await import("../src/scheduler.ts");
  const base: LogEntry[] = [{ t: T0, k: "a", r: 3 }, { t: T0, k: "b", r: 3 }];
  const states = replay(base, f, S);
  const more: LogEntry[] = [...base, { t: T0 + D, k: "a", r: 1 }, { t: T0 + 2 * D, k: "a", a: "suspend" }];
  replayKeys(states, groupByKey(more), ["a"], f, S);
  assert.deepEqual(states, replay(more, f, S));
});
