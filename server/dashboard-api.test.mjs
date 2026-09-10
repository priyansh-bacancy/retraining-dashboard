import assert from "node:assert/strict";
import test from "node:test";

import {
  completeFrameNumbers,
  decodePageCursor,
  encodePageCursor,
  getHealth,
  resetCachesForTests,
  resultKind,
  selectBatch,
  writeFrameCorrections,
} from "./dashboard-api.mjs";

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
  assert.equal(resultKind("mmc-vehicle-classification"), "vehicle");
  assert.equal(resultKind("videomae-aggression"), "segment");
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
