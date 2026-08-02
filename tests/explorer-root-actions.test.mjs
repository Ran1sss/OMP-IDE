import assert from "node:assert/strict";
import test from "node:test";
import { workspaceRootCreateKinds } from "../src/renderer/features/explorer-root-actions.ts";

test("an open workspace exposes file and folder creation even with no tree rows", () => {
  assert.deepEqual(workspaceRootCreateKinds("C:\\tmp\\empty"), ["file", "folder"]);
});

test("no creation actions are exposed before a workspace is open", () => {
  assert.deepEqual(workspaceRootCreateKinds(null), []);
});
