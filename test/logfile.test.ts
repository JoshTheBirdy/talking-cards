import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLogFile, parseLogFile, logFileName, isLogFileName, deviceOf } from "../src/logfile.ts";
import type { LogEntry } from "../src/scheduler.ts";

test("round trip", () => {
  const entries: LogEntry[] = [{ t: 1, k: "abc123", r: 3, ms: 4200 }, { t: 2, k: "abc123#r", a: "suspend" }];
  assert.deepEqual(parseLogFile(formatLogFile("linux-ab12", entries)), entries);
});

test("skips junk lines", () => {
  const text = "```talking-cards\n{\"t\":1,\"k\":\"a\",\"r\":3}\n<<<<<<< conflict\n{\"t\":2}\n\n{\"t\":3,\"k\":\"b\",\"r\":1}\n```\n";
  assert.deepEqual(parseLogFile(text).map((e) => e.t), [1, 3]);
});

test("file names", () => {
  const n = logFileName("android-k3f9", 2026);
  assert.equal(n, "reviews-android-k3f9-2026.md");
  assert.ok(isLogFileName(n));
  assert.equal(deviceOf(n), "android-k3f9");
  assert.ok(!isLogFileName("notes.md"));
});

test("dedupeEntries: a log found in two folders counts once", async () => {
  const { dedupeEntries } = await import("../src/logfile.ts");
  const a = { t: 1, k: "x", r: 3 as const };
  const b = { t: 2, k: "x", r: 4 as const };
  const link = { t: 3, k: "y", a: "link" as const, from: "x" };
  assert.deepEqual(dedupeEntries([a, b, { ...a }, link, { ...link }, { t: 1, k: "x", r: 1 as const }]), [a, b, link, { t: 1, k: "x", r: 1 }]);
});
