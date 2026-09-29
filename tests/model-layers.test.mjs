import assert from "node:assert/strict";
import test from "node:test";

import { visibleModelLayers } from "../app/model-layers.mjs";

const layers = [
  { id: "fall-detection", source: "model_output", count: 0 },
  { id: "phone-usage-detection", source: "manual_available", count: 0 },
  { id: "people-count", source: "manual_saved", count: 0 },
];

test("unused manual models remain collapsed until Show all models is selected", () => {
  assert.deepEqual(
    visibleModelLayers(layers, false).map((model) => model.id),
    ["fall-detection", "people-count"],
  );
  assert.deepEqual(
    visibleModelLayers(layers, true).map((model) => model.id),
    ["fall-detection", "phone-usage-detection", "people-count"],
  );
});

test("selected and edited manual models remain visible when unused models collapse", () => {
  assert.ok(
    visibleModelLayers(layers, false, "phone-usage-detection").some(
      (model) => model.id === "phone-usage-detection",
    ),
  );
  assert.ok(
    visibleModelLayers(
      layers,
      false,
      "",
      new Set(["phone-usage-detection"]),
    ).some((model) => model.id === "phone-usage-detection"),
  );
});
