import assert from "node:assert/strict";
import test from "node:test";
import { classifyAgentEnd, classifyTeamAgentEnd, shouldStallTeamLeadEnd } from "../src/shared/agent-end.ts";

test("only the final stop reason classifies an agent failure", () => {
  assert.deepEqual(classifyAgentEnd("error", false), { aborted: false, failed: true });
  assert.deepEqual(classifyAgentEnd("stop", false), { aborted: false, failed: false });
  assert.deepEqual(classifyAgentEnd("toolUse", false), { aborted: false, failed: false });
});

test("a local abort request is only the fallback without a final stop reason", () => {
  assert.deepEqual(classifyAgentEnd("aborted", false), { aborted: true, failed: false });
  assert.deepEqual(classifyAgentEnd(undefined, true), { aborted: true, failed: false });
  assert.deepEqual(classifyAgentEnd("stop", true), { aborted: false, failed: false });
});

test("Team retries do not emit a premature terminal error", () => {
  assert.equal(classifyTeamAgentEnd("route"), "continue");
  assert.equal(classifyTeamAgentEnd("execute"), "continue");
  assert.equal(classifyTeamAgentEnd("gate"), "continue");
  assert.equal(classifyTeamAgentEnd("verify"), "continue");
});

test("only a stalled Team run emits a terminal error", () => {
  assert.equal(classifyTeamAgentEnd("stalled"), "error");
  assert.equal(classifyTeamAgentEnd("stopped"), "none");
  assert.equal(classifyTeamAgentEnd("done"), "none");
  assert.equal(classifyTeamAgentEnd(null), "none");
  assert.equal(classifyTeamAgentEnd("unknown"), "none");
});

test("an immediate Team execution bootstrap does not stall on the lead agent end", () => {
  assert.equal(shouldStallTeamLeadEnd("execute", false, true, false), false);
  assert.equal(shouldStallTeamLeadEnd("execute", false, false, false), true);
  assert.equal(shouldStallTeamLeadEnd("verify", true, false, false), false);
  assert.equal(shouldStallTeamLeadEnd("execute", false, false, true), false);
});
