import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  registerSearchHandlers,
  SearchMatchCap,
  utf8SpanToUtf16,
} from "../src/main/search-service.ts";

class FakeIpc {
  handlers = new Map();
  handle(channel, handler) {
    this.handlers.set(channel, handler);
  }
}

test("ripgrep UTF-8 byte spans become JavaScript UTF-16 spans", () => {
  const prefix = "Привет — 😀 ";
  const hit = "formatForecast";
  const line = `${prefix}${hit} tail`;
  const start = Buffer.byteLength(prefix, "utf8");
  const end = start + Buffer.byteLength(hit, "utf8");

  assert.deepEqual(utf8SpanToUtf16(line, start, end), {
    column: prefix.length,
    length: hit.length,
  });
});

test("converted spans replace Unicode-prefixed and ASCII matches without collateral edits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omp-search-"));
  const unicodeFile = path.join(dir, "unicode.txt");
  const asciiFile = path.join(dir, "ascii.txt");
  const unicodeLine = "Привет — presentation helpers 😀";
  const asciiLine = "presentation helpers";
  await writeFile(unicodeFile, `${unicodeLine}\n`, "utf8");
  await writeFile(asciiFile, `${asciiLine}\n`, "utf8");

  try {
    const ipc = new FakeIpc();
    registerSearchHandlers(ipc);
    const replace = ipc.handlers.get("search:replace");
    const makeEdit = (file, line) => {
      const prefix = line.slice(0, line.indexOf("presentation"));
      const byteStart = Buffer.byteLength(prefix, "utf8");
      const span = utf8SpanToUtf16(
        line,
        byteStart,
        byteStart + Buffer.byteLength("presentation", "utf8"),
      );
      return {
        file,
        line: 1,
        column: span.column,
        matchText: "presentation",
        replaceText: "display",
      };
    };

    const result = await replace({}, [
      makeEdit(unicodeFile, unicodeLine),
      makeEdit(asciiFile, asciiLine),
    ]);

    assert.deepEqual(result, { applied: 2, failed: [] });
    assert.equal(await readFile(unicodeFile, "utf8"), "Привет — display helpers 😀\n");
    assert.equal(await readFile(asciiFile, "utf8"), "display helpers\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search cap probes match 501 while exposing only the first 500", () => {
  const cap = new SearchMatchCap(500);
  for (let i = 0; i < 500; i++) assert.equal(cap.accept(), true);
  assert.equal(cap.kept, 500);
  assert.equal(cap.hitLimit, false, "exactly 500 matches is not truncated");

  assert.equal(cap.accept(), false, "the probe match is not exposed");
  assert.equal(cap.kept, 500);
  assert.equal(cap.hitLimit, true);
});
