import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyImageKey,
  legacyLabelKey,
  legacyMetadataKey,
  migrationTarget,
  modelLabelKey,
  modelManifestKey,
  modelMetadataKey,
  parseLegacyAnnotationKey,
  parseModelAnnotationKey,
  sharedImageKey,
} from "./annotation-storage.mjs";

test("model-first keys keep models before jobs and share frame images", () => {
  assert.equal(
    modelLabelKey("people-count", "job-1", 41),
    "manual-annotations/models/people-count/job-1/labels/frame_000041.txt",
  );
  assert.equal(
    modelMetadataKey("people-count", "job-1", 41),
    "manual-annotations/models/people-count/job-1/metadata/frame_000041.json",
  );
  assert.equal(
    modelManifestKey("people-count", "job-1"),
    "manual-annotations/models/people-count/job-1/manifest.json",
  );
  assert.equal(
    sharedImageKey("job-1", 41),
    "manual-annotations/images/job-1/frame_000041.jpg",
  );
});

test("legacy annotation keys map safely to the model-first structure", () => {
  assert.deepEqual(
    parseLegacyAnnotationKey(legacyLabelKey("job-1", "people-count", 41)),
    {
      jobId: "job-1",
      kind: "labels",
      modelId: "people-count",
      frameNumber: 41,
    },
  );
  assert.equal(
    migrationTarget(legacyImageKey("job-1", 41)),
    sharedImageKey("job-1", 41),
  );
  assert.equal(
    migrationTarget(legacyLabelKey("job-1", "people-count", 41)),
    modelLabelKey("people-count", "job-1", 41),
  );
  assert.equal(
    migrationTarget(legacyMetadataKey("job-1", "people-count", 41)),
    modelMetadataKey("people-count", "job-1", 41),
  );
  assert.equal(
    parseLegacyAnnotationKey(
      "manual-annotations/models/people-count/job-1/labels/frame_000041.txt",
    ),
    null,
  );
});

test("model-first annotation keys identify model, job, kind, and frame", () => {
  assert.deepEqual(
    parseModelAnnotationKey(modelMetadataKey("group-detection", "job-2", 90)),
    {
      modelId: "group-detection",
      jobId: "job-2",
      kind: "metadata",
      frameNumber: 90,
    },
  );
});
