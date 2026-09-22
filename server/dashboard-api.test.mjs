import assert from "node:assert/strict";
import test from "node:test";

import {
  completeFrameNumbers,
  decodePageCursor,
  encodePageCursor,
  getHealth,
  frameReview,
  resetCachesForTests,
  resolveSourceKey,
  resultKind,
  selectBatch,
  writeFrameCorrections,
} from "./dashboard-api.mjs";

function missingError() {
  const error = new Error("missing");
  error.name = "NotFound";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

test("cursor and frame batching remain compatible with the dashboard", () => {
  const cursor = encodePageCursor(25);
  assert.equal(decodePageCursor(cursor), 25);
  assert.throws(() => decodePageCursor("invalid"), /Invalid continuation token/);

  const frames = completeFrameNumbers({}, new Map(), 108);
  assert.deepEqual(frames, [0, 15, 30, 45, 60, 75, 90, 105]);
  assert.deepEqual(selectBatch(frames, 1, 5), {
    selected: [75, 90, 105],
    totalBatches: 2,
  });
});

test("model workflow kinds preserve MMC and aggression handling", () => {
  assert.equal(resultKind("ppe-compliance"), "box");
  assert.equal(resultKind("people-count"), "people");
  assert.equal(resultKind("group-detection"), "group");
  assert.equal(resultKind("mmc-vehicle-classification"), "vehicle");
  assert.equal(resultKind("videomae-aggression"), "segment");
});

test("people and group results use best-frame fallback and preserve semantic counts", async () => {
  const response = {
    job_id: "job-counts",
    results: [
      {
        model_id: "people-count",
        status: "SUCCESS",
        detections: [
          {
            label: "person",
            count: 2,
            best_frame_number: 28,
            instances: [
              { confidence: 0.8, bbox: { x: 10, y: 20, w: 30, h: 40 }, attributes: {} },
              { confidence: 0.7, bbox: { x: 50, y: 60, w: 20, h: 30 }, attributes: {} },
            ],
          },
        ],
      },
      {
        model_id: "group-detection",
        status: "SUCCESS",
        detections: [
          {
            label: "group",
            count: 1,
            best_frame_number: 28,
            instances: [
              {
                confidence: 0.9,
                bbox: { x: 5, y: 10, w: 80, h: 70 },
                attributes: { people_count: 2, person_boxes: [{}, {}] },
              },
            ],
          },
        ],
      },
    ],
  };
  const review = await frameReview(
    { async send() { throw new Error("S3 should not be read"); } },
    28,
    response,
    { fps: 25, width: 100, height: 100 },
    new Map(),
  );
  const people = review.models.find((model) => model.id === "people-count");
  const group = review.models.find((model) => model.id === "group-detection");
  assert.equal(people.kind, "people");
  assert.equal(people.annotations.length, 2);
  assert.equal(people.people_count, 2);
  assert.equal(group.kind, "group");
  assert.equal(group.annotations.length, 1);
  assert.equal(group.group_count, 1);
  assert.equal(group.grouped_people_count, 2);
  assert.equal(group.annotations[0].attributes.person_boxes.length, 2);
});

test("source resolution supports the real UNASSIGNED upload layout", async () => {
  const expected = "storage/uploads/UNASSIGNED_job-1.mp4";
  const checked = [];
  const s3 = {
    async send(command) {
      if (command.constructor.name === "HeadObjectCommand") {
        checked.push(command.input.Key);
        if (command.input.Key === expected) return { ETag: '"source"' };
        throw missingError();
      }
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [], IsTruncated: false };
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    },
  };
  assert.equal(await resolveSourceKey(s3, "job-1", {}), expected);
  assert.ok(checked.includes(expected));
});

test("failed model results remain empty editable manual layers", async () => {
  const response = {
    job_id: "job-1",
    results: [
      {
        model_id: "phone-usage-detection",
        status: "FAILED",
        detections: [],
      },
      {
        model_id: "videomae-aggression",
        status: "FAILED",
        detections: [],
      },
    ],
  };
  const review = await frameReview(
    { async send() { throw new Error("S3 should not be read"); } },
    30,
    response,
    { fps: 25, width: 1280, height: 720 },
    new Map(),
  );
  assert.equal(review.models.length, 2);
  assert.deepEqual(review.models[0].classes, ["in_hand", "on_ear"]);
  assert.equal(review.models[0].status, "FAILED");
  assert.deepEqual(review.models[0].annotations, []);
  assert.equal(review.models[1].kind, "segment");
  assert.deepEqual(review.models[1].segments, []);
});

test("manual correction writes preserve MMC metadata and multiple aggression segments", async () => {
  const commands = [];
  const s3 = {
    async send(command) {
      commands.push(command);
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: {
            async transformToByteArray() {
              return Uint8Array.from([1, 2, 3]);
            },
          },
        };
      }
      return {};
    },
  };

  const written = await writeFrameCorrections(s3, "job-1", 30, [
    {
      model_id: "mmc-vehicle-classification",
      annotations: [
        {
          id: "vehicle-1",
          class_id: 1,
          label: "car",
          confidence: 0.9,
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          track_id: 42,
          attributes: { color: { label: "blue" } },
        },
      ],
    },
    {
      model_id: "videomae-aggression",
      annotations: [],
      segments: [
        { label: "aggression", start_ms: 1000, end_ms: 2500, confidence: 0.8 },
        { label: "aggression", start_ms: 6000, end_ms: 9000, confidence: 1 },
      ],
    },
  ]);

  assert.equal(written.length, 5);
  const metadataWrites = commands.filter(
    (command) =>
      command.constructor.name === "PutObjectCommand" &&
      command.input.Key.includes("/metadata/"),
  );
  const mmc = JSON.parse(metadataWrites[0].input.Body);
  const aggression = JSON.parse(metadataWrites[1].input.Body);
  assert.equal(mmc.annotations[0].track_id, 42);
  assert.equal(mmc.annotations[0].attributes.color.label, "blue");
  assert.equal(aggression.segments.length, 2);
  assert.deepEqual(aggression.segment, aggression.segments[0]);
});

test("manual group corrections preserve people count metadata", async () => {
  const commands = [];
  const s3 = {
    async send(command) {
      commands.push(command);
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: {
            async transformToByteArray() {
              return Uint8Array.from([1, 2, 3]);
            },
          },
        };
      }
      return {};
    },
  };
  await writeFrameCorrections(s3, "job-groups", 15, [
    {
      model_id: "group-detection",
      annotations: [
        {
          id: "group-1",
          class_id: 0,
          label: "group",
          confidence: 1,
          x: 10,
          y: 20,
          width: 40,
          height: 50,
          attributes: { people_count: 4, person_boxes: [] },
        },
      ],
    },
  ]);
  const metadataWrite = commands.find(
    (command) =>
      command.constructor.name === "PutObjectCommand" &&
      command.input.Key.includes("/metadata/group-detection/"),
  );
  const metadata = JSON.parse(metadataWrite.input.Body);
  assert.equal(metadata.kind, "group");
  assert.equal(metadata.annotations[0].attributes.people_count, 4);
});

test("manual people count is stored even when no person boxes are drawn", async () => {
  const commands = [];
  const s3 = {
    async send(command) {
      commands.push(command);
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: {
            async transformToByteArray() {
              return Uint8Array.from([1, 2, 3]);
            },
          },
        };
      }
      return {};
    },
  };
  await writeFrameCorrections(s3, "job-people", 30, [
    {
      model_id: "people-count",
      people_count: 7,
      annotations: [],
    },
  ]);
  const metadataWrite = commands.find(
    (command) =>
      command.constructor.name === "PutObjectCommand" &&
      command.input.Key.includes("/metadata/people-count/"),
  );
  const metadata = JSON.parse(metadataWrite.input.Body);
  assert.equal(metadata.kind, "people");
  assert.equal(metadata.people_count, 7);
  assert.deepEqual(metadata.annotations, []);
});

test("manual people count is restored independently from person boxes", async () => {
  const metadata = JSON.stringify({
    model_id: "people-count",
    frame_number: 30,
    people_count: 7,
    annotations: [],
  });
  const s3 = {
    async send(command) {
      const bytes = command.input.Key.includes("/metadata/")
        ? Buffer.from(metadata)
        : Buffer.alloc(0);
      return {
        Body: {
          async transformToByteArray() {
            return bytes;
          },
        },
      };
    },
  };
  const review = await frameReview(
    s3,
    30,
    {
      job_id: "job-people",
      results: [{ model_id: "people-count", status: "FAILED" }],
    },
    { fps: 25, width: 100, height: 100 },
    new Map([
      [
        "people-count\u000030",
        {
          modelId: "people-count",
          frame: 30,
          manual: true,
          key: "manual-annotations/job-people/labels/people-count/frame_000030.txt",
        },
      ],
    ]),
  );
  assert.equal(review.models[0].people_count, 7);
  assert.deepEqual(review.models[0].annotations, []);
});

test("health service uses injected Node AWS clients", async () => {
  resetCachesForTests();
  const s3 = { async send() { return {}; } };
  const sts = { async send() { return { Account: "126378326989" }; } };
  const response = await getHealth({ s3, sts });
  assert.deepEqual(response, {
    status: "ok",
    bucket: "icu-solarcam-storage-bacancy-ap-southeast-2",
    region: "ap-southeast-2",
    account: "126378326989",
  });
});
