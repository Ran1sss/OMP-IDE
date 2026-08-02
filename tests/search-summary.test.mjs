import assert from "node:assert/strict";
import test from "node:test";
import { formatSearchSummary } from "../src/renderer/features/search-summary.ts";

const ru = {
  noResults: "Ничего не найдено",
  searching: "Идёт поиск…",
  summary: (matches, files) => `${matches} ${matches === 1 ? "совпадение" : "совпадений"} в ${files} ${files === 1 ? "файле" : "файлах"}`,
  truncated: (matches, files) => `Показаны первые ${matches} совпадений в ${files} ${files === 1 ? "файле" : "файлах"}`,
};
const en = {
  noResults: "No results",
  searching: "Searching…",
  summary: (matches, files) => `${matches} ${matches === 1 ? "match" : "matches"} in ${files} ${files === 1 ? "file" : "files"}`,
  truncated: (matches, files) => `Showing the first ${matches} matches in ${files} ${files === 1 ? "file" : "files"}`,
};

test("a retained completed summary re-localizes without a new search", () => {
  const state = { matches: 1, files: 1, done: true, hitLimit: false };

  assert.equal(formatSearchSummary(state, ru).text, "1 совпадение в 1 файле");
  assert.equal(formatSearchSummary(state, en).text, "1 match in 1 file");
});

test("a retained capped summary stays explicitly truncated in both locales", () => {
  const state = { matches: 500, files: 3, done: true, hitLimit: true };

  assert.deepEqual(formatSearchSummary(state, ru), {
    text: "Показаны первые 500 совпадений в 3 файлах",
    warning: true,
  });
  assert.deepEqual(formatSearchSummary(state, en), {
    text: "Showing the first 500 matches in 3 files",
    warning: true,
  });
});
