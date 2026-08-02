import assert from "node:assert/strict";
import test from "node:test";
import { TourRenderGate } from "../src/renderer/features/tour-render-gate.ts";

test("tour navigation cannot advance a hidden step while its delayed render settles", () => {
  const gate = new TourRenderGate();
  let index = 2;

  assert.equal(gate.tryNavigate(() => index++), true);
  assert.equal(index, 3);
  assert.equal(gate.tryNavigate(() => index++), false);
  assert.equal(index, 3, "a second click must not invalidate the intermediate frame");

  gate.settle();
  assert.equal(gate.tryNavigate(() => index++), true);
  assert.equal(index, 4);
});
