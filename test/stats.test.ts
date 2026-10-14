import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFsrs, DEFAULT_SCHEDULER, replay, type LogEntry } from "../src/scheduler.ts";
import {
  replayWithReviews, perDay, lastDays, forecast, retention, breakdown, intervalHistogram, difficultyHistogram, isLeech, stateName,
} from "../src/stats.ts";

const S = DEFAULT_SCHEDULER;
const f = makeFsrs(S);
const H = 3600_000, D = 24 * H;
const T0 = new Date(2026, 9, 14, 12).getTime();

// a: learned 40 days ago and reviewed since (Review); b: forgotten once; c: new reviewed today; d: suspended
const log: LogEntry[] = [
  { t: T0 - 40 * D, k: "a", r: 3, ms: 3000 }, { t: T0 - 40 * D + 600_000, k: "a", r: 3, ms: 2000 }, { t: T0 - 30 * D, k: "a", r: 3, ms: 2000 },
  { t: T0 - 10 * D, k: "b", r: 3 }, { t: T0 - 10 * D + 600_000, k: "b", r: 3 }, { t: T0 - 5 * D, k: "b", r: 1 },
  { t: T0 - H, k: "c", r: 3, ms: 5000 },
  { t: T0 - 2 * D, k: "d", r: 3 }, { t: T0 - 2 * D + 1, k: "d", a: "suspend" },
];

test("replayWithReviews matches replay and records prior state", () => {
  const { states, reviews } = replayWithReviews(log, f, S);
  assert.deepEqual(states, replay(log, f, S));
  assert.equal(reviews.length, 8);
  assert.equal(reviews[0].before, 0); // New
  assert.equal(reviews.find((r) => r.k === "a" && r.t === T0 - 30 * D)!.before, 2); // Review
});

test("retention counts only reviews of cards in Review state", () => {
  const { reviews } = replayWithReviews(log, f, S);
  const r = retention(reviews, T0 - 60 * D);
  assert.equal(r.total, 2); // a's third review, b's lapse
  assert.equal(r.passed, 1);
  assert.equal(retention(reviews, T0).rate, null);
});

test("per-day counts and the last N days", () => {
  const { reviews } = replayWithReviews(log, f, S);
  const days = perDay(reviews, 4);
  const today = lastDays(T0, 1, 4)[0].key;
  assert.deepEqual(days.get(today), { count: 1, ms: 5000 });
  const last = lastDays(T0, 7, 4);
  assert.equal(last.length, 7);
  assert.equal(last[6].key, today);
  assert.equal(new Set(last.map((d) => d.key)).size, 7);
});

test("forecast, breakdown, histograms, leeches", () => {
  const { states } = replayWithReviews(log, f, S);
  const keys = ["a", "b", "c", "d", "e"];
  const fc = forecast(keys, states, T0, 30, 4);
  assert.equal(fc.reduce((n, x) => n + x, 0) <= 3, true);
  const b = breakdown(keys, states);
  assert.equal(b.new, 1); // e never seen
  assert.equal(b.suspended, 1);
  assert.equal(b.new + b.learning + b.young + b.mature + b.suspended, 5);
  assert.equal(intervalHistogram(keys, states).reduce((n, x) => n + x, 0), b.young + b.mature);
  assert.equal(difficultyHistogram(keys, states).reduce((n, x) => n + x, 0), 3);
  assert.equal(isLeech(states.get("b"), 1), true);
  assert.equal(isLeech(states.get("a"), 1), false);
  assert.equal(stateName(states.get("d")), "Suspended");
  assert.equal(stateName(undefined), "New");
});
