export const MaxOriginalQuoteChars = 200;
export const MaxEnhancedPromptChars = 1000;
export const MaxRegenerationRounds = 3;

export type EnhanceLaunchChoice =
  | "improved-solo"
  | "improved-team"
  | "original-solo"
  | "original-team";

export type EnhanceLaunch =
  | { text: string; mode: "solo" | "team"; enhanced: false }
  | { text: string; mode: "solo" | "team"; enhanced: true; originalText: string };

function limitWithEllipsis(text: string, maxChars: number): string {
  const chars = [...text.trim()];
  if (chars.length <= maxChars) return chars.join("");
  return chars.slice(0, maxChars - 1).join("").trimEnd() + "…";
}

export function quoteOriginalPrompt(text: string): string {
  return limitWithEllipsis(text, MaxOriginalQuoteChars);
}

export function limitEnhancedPrompt(text: string): string {
  return limitWithEllipsis(text, MaxEnhancedPromptChars);
}

export function canRegenerateEnhancement(round: number): boolean {
  return round < MaxRegenerationRounds;
}

export function resolveEnhanceLaunch(
  choice: EnhanceLaunchChoice,
  originalText: string,
  improvedText: string,
): EnhanceLaunch {
  const improved = choice.startsWith("improved-");
  const mode = choice.endsWith("-team") ? "team" : "solo";
  return improved
    ? { text: improvedText, mode, enhanced: true, originalText }
    : { text: originalText, mode, enhanced: false };
}

export function timeoutEnhanceLaunch(originalText: string): EnhanceLaunch {
  return { text: originalText, mode: "solo", enhanced: false };
}
