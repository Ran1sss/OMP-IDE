import type { ModelsState } from "./types";

export interface TelegramModelPair {
  selector: string;
  modelId: string;
  profile: string;
  favorite: boolean;
  label: string;
}

export interface ModelPage {
  items: TelegramModelPair[];
  page: number;
  pages: number;
}

export function buildModelCatalog(state: Pick<ModelsState, "active" | "providers">): TelegramModelPair[] {
  const out: TelegramModelPair[] = [];
  for (const provider of state.providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      out.push({
        selector: `${provider.id}/${model.id}`,
        modelId: model.id,
        profile: provider.id,
        favorite: model.favorite,
        label: `${model.favorite ? "★ " : ""}${model.id} · ${provider.id}`,
      });
    }
  }
  return out;
}

export function buildQuickModels(
  catalog: TelegramModelPair[],
  recents: readonly string[],
  maxRows = 6,
): TelegramModelPair[] {
  const bySelector = new Map(catalog.map((item) => [item.selector, item]));
  const chosen: TelegramModelPair[] = [];
  const seen = new Set<string>();
  const add = (item: TelegramModelPair | undefined) => {
    if (!item || seen.has(item.selector) || chosen.length >= maxRows) return;
    seen.add(item.selector);
    chosen.push(item);
  };
  for (const item of catalog) if (item.favorite) add(item);
  for (const selector of recents) add(bySelector.get(selector));
  const minimumRows = Math.min(4, maxRows);
  if (chosen.length < minimumRows) for (const item of catalog) add(item);
  return chosen;
}

export function filterModelPairs(catalog: TelegramModelPair[], query: string): TelegramModelPair[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return catalog;
  return catalog.filter((item) => {
    const haystack = `${item.modelId} ${item.profile} ${item.selector}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function paginateProfileModels(
  catalog: TelegramModelPair[],
  profile: string,
  page: number,
  pageSize = 8,
): ModelPage {
  const all = catalog.filter((item) => item.profile === profile);
  const effectiveSize = all.length > 10 ? pageSize : Math.max(1, all.length);
  const pages = Math.max(1, Math.ceil(all.length / effectiveSize));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  return { items: all.slice(safePage * effectiveSize, (safePage + 1) * effectiveSize), page: safePage, pages };
}

export function paginateModelMatches(
  matches: TelegramModelPair[],
  page: number,
  pageSize = 8,
): ModelPage {
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  return { items: matches.slice(safePage * pageSize, (safePage + 1) * pageSize), page: safePage, pages };
}

export function recordModelRecent(
  current: readonly string[],
  selector: string,
  maxEntries = 12,
): string[] {
  const unique = new Set<string>([selector]);
  for (const item of current) unique.add(item);
  return [...unique].slice(0, maxEntries);
}

export type ModelActivationResult = { ok: true } | { ok: false; error: string };

/** Keeps the persisted default role transactional with the live activation. */
export async function activateThenCommitModelRole(
  activate: () => Promise<ModelActivationResult>,
  commit: () => void,
): Promise<ModelActivationResult> {
  const result = await activate();
  if (!result.ok) return result;
  commit();
  return result;
}

export type ModelActivationAttempt =
  | { ok: true }
  | { ok: false; error: string; liveMayHaveChanged: boolean };

export type ModelActivationTransactionResult =
  | { ok: true }
  | { ok: false; error: string; degraded: boolean };

/** Restores the prior live selector before exposing an activation failure. */
export async function runModelActivationTransaction(input: {
  activate(): Promise<ModelActivationAttempt>;
  rollback(): Promise<{ ok: true } | { ok: false; error: string }>;
  commit(): void;
  degrade(detail: string): void;
}): Promise<ModelActivationTransactionResult> {
  const activation = await input.activate();
  if (activation.ok) {
    input.commit();
    return { ok: true };
  }
  if (!activation.liveMayHaveChanged) {
    return { ok: false, error: activation.error, degraded: false };
  }
  const rollback = await input.rollback();
  if (rollback.ok) return { ok: false, error: activation.error, degraded: false };
  const error = `${activation.error}; rollback failed: ${rollback.error}`;
  input.degrade(error);
  return { ok: false, error, degraded: true };
}

export function isModelSwitchBusy(
  agentState: string | undefined,
  teamActive: boolean,
): boolean {
  return teamActive || agentState === "thinking" || agentState === "tool" || agentState === "awaiting-input";
}
