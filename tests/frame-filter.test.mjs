import assert from "node:assert/strict";
import test from "node:test";

import {
  adjacentFrame,
  frameWindow,
  mergeFrameNumbers,
} from "../app/frame-filter.mjs";

test("frame lists combine, deduplicate, and sort frame numbers", () => {
  assert.deepEqual(
    mergeFrameNumbers([60, 15, 60], new Set([30, 15, 45])),
    [15, 30, 45, 60],
  );
});

test("corrected frame windows follow the active frame", () => {
  const frames = [0, 15, 30, 45, 60, 75, 90, 105];
  assert.deepEqual(frameWindow(frames, 75, 3), [45, 60, 75]);
  assert.deepEqual(frameWindow(frames, 999, 3), [0, 15, 30]);
});

test("corrected-frame navigation stops at the first and last frame", () => {
  const frames = [15, 45, 90];
  assert.equal(adjacentFrame(frames, 45, 1), 90);
  assert.equal(adjacentFrame(frames, 45, -1), 15);
  assert.equal(adjacentFrame(frames, 90, 1), null);
  assert.equal(adjacentFrame(frames, 15, -1), null);
});
