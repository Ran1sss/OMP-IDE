import assert from "node:assert/strict";
import test from "node:test";
import { SearchResultState } from "../src/renderer/features/search-result-state.ts";

test("presentation-only reads retain stale authority and block replacement", () => {
  const state = new SearchResultState();
  state.complete();
  state.markStale();

  const presentation = { stale: state.stale, canReplace: state.canReplace };

  assert.deepEqual(presentation, { stale: true, canReplace: false });
  assert.equal(state.stale, true);
  assert.equal(state.canReplace, false);
});

test("a completed search error remains non-replaceable during presentation", () => {
  const state = new SearchResultState();
  state.complete(true);

  const presentation = { failed: state.failed, canReplace: state.canReplace };

  assert.deepEqual(presentation, { failed: true, canReplace: false });
});

test("only a new search or reset clears stale authority", () => {
  const state = new SearchResultState();
  state.complete();
  state.markStale();

  state.startSearch();
  assert.equal(state.stale, false);
  assert.equal(state.canReplace, false);

  state.complete();
  state.markStale();
  state.reset();
  assert.equal(state.stale, false);
  assert.equal(state.canReplace, false);
});
