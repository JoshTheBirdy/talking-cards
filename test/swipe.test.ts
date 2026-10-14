import { test } from "node:test";
import assert from "node:assert/strict";
import { swipeDirection, swipeProgress, flingTo } from "../src/swipe.ts";

test("direction needs the threshold on the dominant axis", () => {
  assert.equal(swipeDirection(50, 0, 72), null);
  assert.equal(swipeDirection(80, 10, 72), "right");
  assert.equal(swipeDirection(-80, 10, 72), "left");
  assert.equal(swipeDirection(5, -90, 72), "up"); // screen y grows downward
  assert.equal(swipeDirection(5, 90, 72), "down");
});

test("diagonals resolve to one direction; ties go horizontal", () => {
  assert.equal(swipeDirection(100, 100, 72), "right");
  assert.equal(swipeDirection(-100, -101, 72), "up");
});

test("progress shows intent early and arms at the threshold", () => {
  assert.deepEqual(swipeProgress(3, 4, 72), { dir: null, t: 0, armed: false });
  const p = swipeProgress(0, -36, 72);
  assert.equal(p.dir, "up");
  assert.equal(p.t, 0.5);
  assert.equal(p.armed, false);
  assert.equal(swipeProgress(0, -200, 72).armed, true);
  assert.equal(swipeProgress(0, -200, 72).t, 1);
});

test("fling targets leave the screen", () => {
  assert.ok(flingTo("right", 400, 800).x > 400);
  assert.ok(flingTo("up", 400, 800).y < -800);
  assert.equal(flingTo("up", 400, 800).rot, 0);
});
