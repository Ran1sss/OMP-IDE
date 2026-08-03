import assert from "node:assert/strict";
import test from "node:test";
import { tg } from "../src/main/remote/tg-i18n.ts";
import {
  MaxEnhancedPromptChars,
  MaxOriginalQuoteChars,
  MaxRegenerationRounds,
  canRegenerateEnhancement,
  limitEnhancedPrompt,
  quoteOriginalPrompt,
  resolveEnhanceLaunch,
  timeoutEnhanceLaunch,
} from "../src/shared/telegram-enhance.ts";

test("the four launch buttons resolve the exact version and mode", () => {
  const original = "сделай прогу для погоды";
  const improved = "Создай CLI прогноза погоды с явной проверкой результата.";

  assert.deepEqual(resolveEnhanceLaunch("improved-solo", original, improved), {
    text: improved,
    mode: "solo",
    enhanced: true,
    originalText: original,
  });
  assert.deepEqual(resolveEnhanceLaunch("improved-team", original, improved), {
    text: improved,
    mode: "team",
    enhanced: true,
    originalText: original,
  });
  assert.deepEqual(resolveEnhanceLaunch("original-solo", original, improved), {
    text: original,
    mode: "solo",
    enhanced: false,
  });
  assert.deepEqual(resolveEnhanceLaunch("original-team", original, improved), {
    text: original,
    mode: "team",
    enhanced: false,
  });
});

test("the improvement view bounds original quotes and enhanced tasks", () => {
  const quoted = quoteOriginalPrompt("я".repeat(400));
  const enhanced = limitEnhancedPrompt("а".repeat(1400));

  assert.equal([...quoted].length, MaxOriginalQuoteChars);
  assert.equal(quoted.endsWith("…"), true);
  assert.equal([...enhanced].length, MaxEnhancedPromptChars);
  assert.equal(enhanced.endsWith("…"), true);
});

test("regeneration stops after three total enhancement rounds", () => {
  assert.equal(MaxRegenerationRounds, 3);
  assert.equal(canRegenerateEnhancement(1), true);
  assert.equal(canRegenerateEnhancement(2), true);
  assert.equal(canRegenerateEnhancement(3), false);
});

test("every unattended picker or improvement view falls back to original Solo", () => {
  assert.deepEqual(timeoutEnhanceLaunch("исходный запрос"), {
    text: "исходный запрос",
    mode: "solo",
    enhanced: false,
  });
});

test("Telegram enhancement copy is complete in Russian and English", () => {
  assert.equal(tg("ru").pickerEnhance, "✦ Улучшить");
  assert.equal(tg("ru").enhancedTeam, "✦⚑ Улучшенный командой");
  assert.match(tg("ru").enhanceTimeout, /как есть соло/i);
  assert.equal(tg("en").pickerEnhance, "✦ Improve");
  assert.equal(tg("en").originalSolo, "⚡ Original solo");
  assert.match(tg("en").enhanceTimeout, /original.*solo/i);
});

test("enhancement output discloses timeout without leaking backend errors", () => {
  assert.match(tg("ru").enhanceTimeoutDisclosure, /исходн.*соло/i);
  assert.match(tg("en").enhanceTimeoutDisclosure, /original.*solo/i);
  assert.doesNotMatch(tg("ru").enhanceFailed, /C:\\\\Users|stderr|secret/i);
  assert.doesNotMatch(tg("en").enhanceFailed, /C:\\\\Users|stderr|secret/i);
});
