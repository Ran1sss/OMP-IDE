import assert from "node:assert/strict";
import test from "node:test";
import { restoreDialogFocus } from "../src/renderer/core/dialog-focus.ts";

test("dialog close restores a connected invoker by default", () => {
  let focused = 0;
  const invoker = { isConnected: true, focus: () => focused++ };

  restoreDialogFocus(invoker);

  assert.equal(focused, 1);
});

test("dialog close uses an explicit semantic focus target instead of a clicked close button", () => {
  let invokerFocused = 0;
  let editorFocused = 0;
  const invoker = { isConnected: true, focus: () => invokerFocused++ };

  restoreDialogFocus(invoker, () => editorFocused++);

  assert.equal(editorFocused, 1);
  assert.equal(invokerFocused, 0);
});

test("dialog close never focuses a detached invoker", () => {
  restoreDialogFocus({
    isConnected: false,
    focus: () => assert.fail("detached target received focus"),
  });
});
