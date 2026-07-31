/**
 * Model Control renderer: status-bar chip (+crossfade, popover), models
 * settings dialog (role rail, provider cards, add-provider, event log),
 * quick-switch dialog for the palette, usage strip and failure banner
 * mounted into the agent panel.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { toast, confirmDialog, inputDialog } from "../core/ui";
import { fuzzyMatch, fuzzyMatchMulti, highlight } from "../core/fuzzy";
import type {
  ModelsState,
  ModelsUsage,
  ModelRole,
  ProviderInfo,
  ModelEntry,
  ProviderTemplateId,
  ThinkingLevel,
} from "../../shared/types";
import { MODEL_ROLES, THINKING_LEVELS } from "../../shared/types";
import { openApiTester, deepTestProfile, runTestAll } from "./tester";

const PROVIDER_GLYPHS: Record<ProviderTemplateId, string> = {
  anthropic: `<path d="M6.2 3h3.6L14 13h-2.4l-.9-2.3H5.3L4.4 13H2L6.2 3zm.1 5.8h3.4L8 4.5 6.3 8.8z"/>`,
  openai: `<circle cx="8" cy="8" r="5.2"/><path d="M8 2.8v2.4M8 10.8v2.4M2.8 8h2.4M10.8 8h2.4M4.3 4.3l1.7 1.7M10 10l1.7 1.7M4.3 11.7L6 10M10 6l1.7-1.7"/>`,
  google: `<circle cx="8" cy="8" r="5.2"/><path d="M8 5.5V8h4.6"/>`,
  openrouter: `<path d="M2.5 8h4l2-3 2 6 1.5-3h1.5"/>`,
  custom: `<rect x="3" y="3" width="10" height="10" rx="2"/><path d="M6 8h4M8 6v4"/>`,
};

let state: ModelsState = {
  providers: [],
  roles: { default: { selector: null }, smol: { selector: null }, slow: { selector: null } },
  active: null,
  pending: null,
  thinking: {
    roles: { default: "med", smol: "off", slow: "high" },
    sessionOverride: null,
    effective: "med",
    capability: "unknown",
    pending: null,
    boost: null,
  },
  autoSwap: { enabled: true, roleOptOut: { default: false, smol: false, slow: false } },
  balancePollMinutes: 10,
};
let usage: ModelsUsage = { requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, hasTokenData: false };

// chip
let chipEl: HTMLElement | null = null;
let chipName: HTMLElement | null = null;
let chipPendingEl: HTMLElement | null = null;
let lastChipText = "";

// agent panel mounts
let usageEl: HTMLElement | null = null;
let warnHost: HTMLElement | null = null;
let boostBtn: HTMLElement | null = null;

// ---------------------------------------------------------------- helpers

function shortName(id: string): string {
  return id.length > 26 ? id.slice(0, 24) + "…" : id;
}

function ctxClass(ctx: number | null): string {
  if (!ctx) return "38%";
  if (ctx >= 400_000) return "100%";
  if (ctx >= 150_000) return "72%";
  return "38%";
}

function providerOf(selector: string | null): ProviderInfo | null {
  if (!selector) return null;
  const provId = selector.split("/")[0];
  return state.providers.find((p) => p.id === provId) ?? null;
}

/** human label for a role selector: registry, omp-native, or @alias forms */
function selectorLabel(sel: string | null): { model: string; provider: string } {
  if (!sel) return { model: "unassigned", provider: "" };
  if (sel.startsWith("@")) return { model: sel, provider: "role alias" };
  const slash = sel.indexOf("/");
  if (slash < 0) return { model: sel, provider: "" };
  const prov = providerOf(sel);
  return {
    model: shortName(sel.slice(slash + 1)),
    provider: prov?.displayName ?? sel.slice(0, slash),
  };
}

interface Choice {
  /** fully-qualified "<profile>/<model>" */
  selector: string;
  /** qualified display/filter string */
  label: string;
  provider: ProviderInfo;
  model: ModelEntry;
}

function allChoices(onlyFavorites = false): Choice[] {
  const out: Choice[] = [];
  for (const p of state.providers) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      if (onlyFavorites && !m.favorite) continue;
      out.push({ selector: `${p.id}/${m.id}`, label: `${p.id}/${m.id}`, provider: p, model: m });
    }
  }
  return out;
}

/** model ids exposed by 2+ enabled profiles — the chip shows qualifiers for these */
function ambiguousModelIds(): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const p of state.providers) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      if (seen.has(m.id)) dup.add(m.id);
      seen.add(m.id);
    }
  }
  return dup;
}

function anyRoleProviderBroken(): ProviderInfo | null {
  for (const role of MODEL_ROLES) {
    const p = providerOf(state.roles[role].selector);
    if (p && p.enabled && (p.health === "auth-error" || p.health === "network-error" || p.health === "rate-limited"))
      return p;
  }
  return null;
}

// ---------------------------------------------------------------- chip

let chipThinkEl: HTMLElement | null = null;
let chipQual: HTMLElement | null = null;

export function createModelChip(): HTMLElement {
  chipQual = el("span", { class: "mc-qual", style: { display: "none" } });
  chipName = el("span", { class: "mc-name", text: "no model" });
  chipPendingEl = el("span", { class: "mc-pending", style: { display: "none" }, text: "PENDING" });
  const bar = el("span", { class: "mc-bar" });
  chipThinkEl = el("span", { class: "mc-think", title: "Thinking level" });
  for (let i = 0; i < 5; i++) chipThinkEl.append(el("span", { class: "mct-bar" }));
  chipEl = el(
    "span",
    { class: "sb-item model-chip", title: "Active model — click to switch", onClick: () => showSwitchPopover(chipEl!) },
    bar,
    chipQual,
    chipName,
    chipThinkEl,
    chipPendingEl,
  );
  return chipEl;
}

const LEVEL_BARS: Record<ThinkingLevel, number> = { off: 0, low: 1, med: 2, high: 3, xhigh: 4, max: 5 };

function renderChip(): void {
  if (!chipEl || !chipName || !chipPendingEl) return;
  const active = state.active;
  const text = active ? shortName(active.id) : "no model";
  const broken = anyRoleProviderBroken();
  chipEl.classList.toggle("crit", !!broken);
  const activeProfile = active ? state.providers.find((p) => p.id === active.provider) : null;
  const activeModel = activeProfile?.models.find((m) => m.id === active?.id) ?? null;
  chipEl.style.setProperty("--mc-fill", ctxClass(activeModel?.contextWindow ?? null));
  chipPendingEl.textContent = switchInFlight ? "SWITCHING" : "PENDING";
  chipPendingEl.style.display = switchInFlight || state.pending || state.thinking.pending ? "" : "none";
  // qualifier: shown exactly while another enabled profile exposes the same id
  if (chipQual) {
    const ambiguous = active !== null && ambiguousModelIds().has(active.id);
    chipQual.style.display = ambiguous ? "" : "none";
    if (active && ambiguous) chipQual.textContent = `${active.provider}·`;
  }
  // Balance rides on the tooltip when the profile has a probed wallet —
  // spot-checking funds shouldn't require opening the Models dialog.
  // Spec rule: a balance is never shown without its age.
  const bal = activeProfile?.balance;
  const balAge = bal ? Math.max(0, Math.round((Date.now() - bal.checkedAt) / 60_000)) : 0;
  const balText = bal && bal.value !== null
    ? ` — balance ${bal.value.toFixed(2)}${bal.currency ? " " + bal.currency : ""} · ${balAge < 1 ? "now" : `${balAge}m`}`
    : "";
  chipEl.title = active
    ? `${active.provider}/${active.id}${balText} — click to switch`
    : "Active model — click to switch";
  // thinking glyph: hidden entirely for no-thinking models
  if (chipThinkEl) {
    chipThinkEl.style.display = state.thinking.capability === "no-thinking" ? "none" : "";
    const lit = LEVEL_BARS[state.thinking.effective];
    const bars = chipThinkEl.children;
    for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("lit", i < lit);
    chipThinkEl.title = `Thinking: ${state.thinking.effective}${state.thinking.sessionOverride ? " (session override)" : ""}${state.thinking.capability === "unknown" ? " · unverified" : ""}`;
  }

  if (text !== lastChipText) {
    // 240ms crossfade: out then in
    const nameEl = chipName;
    if (lastChipText) {
      nameEl.classList.add("switch-out");
      setTimeout(() => {
        nameEl.textContent = text;
        nameEl.classList.remove("switch-out");
        nameEl.classList.add("switch-in");
        setTimeout(() => nameEl.classList.remove("switch-in"), 140);
      }, 120);
    } else {
      nameEl.textContent = text;
    }
    lastChipText = text;
  }
}

// ---------------------------------------------------------------- switch popover

let openPop: HTMLElement | null = null;

function closePop(): void {
  openPop?.remove();
  openPop = null;
}

function showSwitchPopover(anchor: HTMLElement): void {
  closePop();
  const pop = el("div", { class: "model-pop" });

  pop.append(el("div", { class: "mp-section", text: "Roles" }));
  for (const role of MODEL_ROLES) {
    const sel = state.roles[role].selector;
    pop.append(
      el(
        "div",
        {
          class: "mp-row",
          onClick: () => {
            closePop();
            void pickModel(`Assign ${role} model`).then((choice) => {
              if (choice) void assignRoleAction(role, choice.selector, "chip");
            });
          },
        },
        el("span", { class: "mp-role", text: role }),
        el("span", { class: "mono", text: selectorLabel(sel).model }),
        el("span", { class: "mp-prov", text: selectorLabel(sel).provider }),
      ),
    );
  }

  const favs = allChoices(true);
  pop.append(el("div", { class: "mp-section", text: "Favorites" }));
  if (!favs.length) {
    pop.append(el("div", { class: "mp-empty", text: "No favorites yet — star models in Model Settings." }));
  }
  // type-to-filter over favorites (falls back to all models when filtering);
  // rows grouped under sticky per-profile headers, fuzzy over the QUALIFIED id
  const favList = el("div", { class: "mp-groups" });
  let popTop: Choice | null = null;
  const renderFavs = (query: string) => {
    clear(favList);
    const pool = query ? allChoices(false) : favs;
    const matched = query
      ? pool
          .map((c) => ({ c, hit: fuzzyMatchMulti(query, c.label) }))
          .filter((x): x is { c: Choice; hit: { score: number; indices: number[] } } => x.hit !== null)
          .sort((a, b) => b.hit.score - a.hit.score)
          .slice(0, 16)
      : pool.map((c) => ({ c, hit: { score: 0, indices: [] as number[] } }));
    popTop = matched[0]?.c ?? null;
    // group rows by profile, preserving match order inside each group
    const groups = new Map<string, { c: Choice; hit: { score: number; indices: number[] } }[]>();
    for (const m of matched) {
      const g = groups.get(m.c.provider.id);
      if (g) g.push(m);
      else groups.set(m.c.provider.id, [m]);
    }
    for (const [profileId, rows] of groups) {
      const prof = rows[0].c.provider;
      const head = el("div", { class: "mp-group-head" });
      head.append(
        el("span", { class: `pc-dot ${prof.health}` }),
        el("span", { text: profileId }),
        el("span", { class: "mp-count", text: `· ${rows.length}` }),
      );
      favList.append(head);
      for (const { c, hit } of rows) {
        const isActive = state.active?.id === c.model.id && state.active?.provider === c.provider.id;
        const idSpan = el("span", { class: "mono" });
        // hit indices are over "profile/model"; shift into the model part
        const offset = c.provider.id.length + 1;
        idSpan.append(
          highlight(
            shortName(c.model.id),
            hit.indices.map((i) => i - offset).filter((i) => i >= 0),
            "mm-hl",
          ),
        );
        favList.append(
          el(
            "div",
            {
              class: isActive ? "mp-row active" : "mp-row",
              title: c.selector,
              onClick: () => {
                closePop();
                void switchAction(c.selector, "chip");
              },
            },
            idSpan,
          ),
        );
      }
    }
  };
  const popFilter = el("input", {
    class: "input",
    placeholder: "Filter models… (profile/model)",
    onInput: () => renderFavs(popFilter.value.trim()),
    onKeyDown: (e) => {
      if (e.key === "Enter" && popTop) {
        const pick = popTop;
        closePop();
        void switchAction(pick.selector, "chip");
      } else if (e.key === "Escape") {
        if (popFilter.value) {
          popFilter.value = "";
          renderFavs("");
          e.stopPropagation();
        } else closePop();
      }
    },
  }) as HTMLInputElement;
  pop.append(el("div", { class: "model-filter", style: { background: "transparent" } }, popFilter), favList);
  renderFavs("");

  pop.append(
    el(
      "div",
      { class: "mp-foot" },
      el("button", { class: "btn", text: "Model Settings…", onClick: () => { closePop(); openModelsDialog(); } }),
    ),
  );

  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - pr.width - 8)}px`;
  pop.style.top = `${r.top - pr.height - 8}px`;
  openPop = pop;
  popFilter.focus(); // type-to-filter: focused by default
  setTimeout(() => {
    const onDown = (e: MouseEvent) => {
      if (openPop && !openPop.contains(e.target as Node)) {
        closePop();
        window.removeEventListener("mousedown", onDown, { capture: true });
      }
    };
    window.addEventListener("mousedown", onDown, { capture: true });
  });
}

// ---------------------------------------------------------------- shared actions

/** a switch invoke is in flight — early state pushes must not hide the badge */
let switchInFlight = false;

async function switchAction(selector: string, origin: string): Promise<void> {
  // The omp RPC takes 1–4 s on a live session; without this the popover closes
  // and NOTHING moves until the state push. Honest feedback: it IS switching.
  switchInFlight = true;
  renderChip();
  const res = await window.ide.models.switchModel(selector, origin);
  switchInFlight = false;
  renderChip();
  if (!res.ok) {
    const hint = res.error?.includes("Model not found")
      ? " — the agent session predates this provider; restart the session and retry"
      : "";
    toast(`Switch failed: ${res.error ?? "unknown error"}${hint}`, { crit: true });
  } else if (res.pending) toast("Model switch queued — applies when the agent finishes this run");
  else toast(`Switched to ${selector.split("/")[1]}`);
}

async function assignRoleAction(role: ModelRole, selector: string, origin: string): Promise<void> {
  const res = await window.ide.models.assignRole(role, selector, origin);
  if (!res.ok) toast(`Assign failed: ${res.error ?? "unknown error"}`, { crit: true });
  else toast(`${role} → ${selector.split("/")[1]}`);
}

/** roles waiting for forced reassignment (external models.yml edits) */
const orphanQueue = new Set<ModelRole>();
/** singleton pump: at most one forced-reassignment picker chain at a time */
let orphanPumpRunning = false;

/** a role selector that no enabled/known provider+model can back anymore */
function roleIsOrphaned(role: ModelRole): boolean {
  const sel = state.roles[role].selector;
  if (!sel) return false;
  const slash = sel.indexOf("/");
  if (slash < 0) return false;
  const prov = providerOf(sel);
  return !prov || !prov.models.some((m) => m.id === sel.slice(slash + 1));
}

/** forced reassignment after an external edit removed an assigned profile/model.
 * Serialized: one picker at a time; roles arriving mid-chain join the queue
 * (mirrors the singleton pattern of the Models dialog). Cancel re-opens —
 * the role must be repointed — unless no models are left to pick from. */
function forceReassignRoles(roles: ModelRole[]): void {
  for (const r of roles) orphanQueue.add(r);
  if (orphanPumpRunning) return;
  orphanPumpRunning = true;
  void (async () => {
    try {
      while (orphanQueue.size) {
        const role = orphanQueue.values().next().value as ModelRole;
        orphanQueue.delete(role);
        // state may have moved on (user reassigned meanwhile) — re-check
        if (!roleIsOrphaned(role)) continue;
        toast(`The ${role} model was removed from models.yml — pick a replacement`, { crit: true });
        let picked = false;
        while (!picked) {
          if (!allChoices().length) return; // pickModel would toast + resolve null forever
          const c = await pickModel(`Reassign ${role} model (profile removed)`);
          if (c) {
            await assignRoleAction(role, c.selector, "external");
            picked = true;
          } else if (!roleIsOrphaned(role)) {
            picked = true; // repointed elsewhere while the picker was up
          } else {
            toast(`${role} still points at a removed model — reassignment required`, { crit: true });
          }
        }
      }
    } finally {
      orphanPumpRunning = false;
    }
  })();
}

/** fuzzy model picker dialog; resolves with the chosen model or null.
 * opts.prefilter seeds the query (recovery: same model id elsewhere);
 * opts.excludeProfile hides the failing profile's own entries. */
export function pickModel(
  title: string,
  opts?: { prefilter?: string; excludeProfile?: string },
): Promise<Choice | null> {
  const { promise, resolve } = Promise.withResolvers<Choice | null>();
  let choices = allChoices();
  if (opts?.excludeProfile) choices = choices.filter((c) => c.provider.id !== opts.excludeProfile);
  if (!choices.length) {
    toast("No models available — add a profile in Model Settings", { crit: true });
    resolve(null);
    return promise;
  }
  const overlay = el("div", { class: "overlay" });
  const done = (v: Choice | null) => {
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
    resolve(v);
  };
  let filtered = choices.map((c) => ({ c, indices: [] as number[] }));
  let selected = 0;
  const list = el("div", { class: "pal-list" });

  const render = () => {
    clear(list);
    if (!filtered.length) list.append(el("div", { class: "pal-none", text: "No matching models" }));
    filtered.forEach(({ c, indices }, i) => {
      const row = el("div", {
        class: i === selected ? "pal-row selected" : "pal-row",
        onClick: () => done(c),
      });
      // label IS the qualified id — profile part in UI font, model part mono
      const label = el("span", { class: "mono", style: { overflow: "hidden", textOverflow: "ellipsis" } });
      label.append(highlight(c.label, indices, "pal-hl"));
      const dot = el("span", { class: `pc-dot ${c.provider.health}` });
      row.append(label, el("span", { class: "pal-detail" }, dot));
      list.append(row);
    });
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  };

  const input = el("input", {
    class: "pal-input",
    placeholder: title,
    onInput: () => {
      const q = input.value.trim();
      if (!q) filtered = choices.map((c) => ({ c, indices: [] }));
      else {
        // fuzzy across the QUALIFIED string: "ranis fable" or "b/claude" both narrow
        filtered = choices
          .map((c) => ({ c, m: fuzzyMatchMulti(q, c.label) }))
          .filter((x): x is { c: Choice; m: { score: number; indices: number[] } } => x.m !== null)
          .sort((a, b) => b.m.score - a.m.score)
          .map((x) => ({ c: x.c, indices: x.m.indices }));
      }
      selected = 0;
      render();
    },
    onKeyDown: (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); selected = Math.min(selected + 1, filtered.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
      else if (e.key === "Enter") { e.preventDefault(); done(filtered[selected]?.c ?? null); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    },
  }) as HTMLInputElement;

  overlay.append(el("div", { class: "palette" }, input, list));
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) done(null);
  });
  document.body.append(overlay);
  input.focus();
  if (opts?.prefilter) {
    input.value = opts.prefilter;
    input.dispatchEvent(new Event("input"));
  }
  requestAnimationFrame(() => overlay.classList.add("visible"));
  render();
  return promise;
}
/** session-override picker (palette + agent header share it) */
export function setSessionThinkingViaPicker(origin: string): void {
  const overlay = el("div", { class: "overlay centered" });
  const close = () => {
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
  };
  const list = el("div", { class: "pal-list" });
  const options: { label: string; level: ThinkingLevel | null }[] = [
    ...THINKING_LEVELS.map((l) => ({ label: l, level: l as ThinkingLevel | null })),
    { label: "clear override (use role default)", level: null },
  ];
  for (const opt of options) {
    const isActive = opt.level !== null && state.thinking.sessionOverride === opt.level;
    list.append(
      el("div", {
        class: isActive ? "pal-row selected" : "pal-row",
        onClick: () => {
          close();
          void window.ide.models.setSessionThinking(opt.level, origin).then((r) => {
            toast(
              r.pending
                ? "Thinking level queued — applies when the agent finishes this run"
                : opt.level
                  ? `Thinking: ${opt.level} (this session)`
                  : "Thinking override cleared",
            );
          });
        },
      }, el("span", { class: "mono", text: opt.label })),
    );
  }
  const dialog = el(
    "div",
    { class: "dialog", style: { padding: "16px" } },
    el("h2", { text: "Thinking level — this session" }),
    list,
    el("div", { class: "dialog-actions" }, el("button", { class: "btn", text: "Cancel", onClick: close })),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add("visible"));
}

export function switchModelViaPicker(origin: string): void {
  void pickModel("Switch default model…").then((c) => {
    if (c) void switchAction(c.selector, origin);
  });
}

export function assignRoleViaPicker(origin: string): void {
  const roleOverlay = el("div", { class: "overlay centered" });
  const closeRole = () => {
    roleOverlay.classList.remove("visible");
    setTimeout(() => roleOverlay.remove(), 170);
  };
  const listEl = el("div", { class: "pal-list" });
  for (const role of MODEL_ROLES) {
    listEl.append(
      el("div", {
        class: "pal-row",
        onClick: () => {
          closeRole();
          void pickModel(`Assign ${role} model`).then((c) => {
            if (c) void assignRoleAction(role, c.selector, origin);
          });
        },
      }, el("span", { class: "mp-role", text: role }), el("span", { class: "mono", text: state.roles[role].selector ?? "unassigned" })),
    );
  }
  roleOverlay.append(
    el("div", { class: "dialog", style: { padding: "16px" } },
      el("h2", { text: "Assign role" }),
      listEl,
      el("div", { class: "dialog-actions" }, el("button", { class: "btn", text: "Cancel", onClick: closeRole })),
    ),
  );
  document.body.append(roleOverlay);
  requestAnimationFrame(() => roleOverlay.classList.add("visible"));
}

// ---------------------------------------------------------------- settings dialog

/** pinned header host (title + role rail) — re-rendered on state pushes */
let dialogHead: HTMLElement | null = null;
/** scrolling middle region (provider cards, add form, events) */
let dialogBody: HTMLElement | null = null;
/** singleton: at most one Models dialog */
let dialogClose: (() => void) | null = null;

export function openModelsDialog(): void {
  dialogClose?.();
  const overlay = el("div", { class: "overlay centered" });
  const close = () => {
    if (dialogClose === close) dialogClose = null;
    dialogHead = null;
    dialogBody = null;
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
  };
  dialogClose = close;
  dialogHead = el("div", { class: "md-head" });
  dialogBody = el("div", { class: "md-scroll" });
  const dialog = el(
    "div",
    { class: "dialog models-dialog" },
    dialogHead,
    dialogBody,
    el("div", { class: "dialog-actions" }, el("button", { class: "btn", text: "Close", onClick: close })),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add("visible"));
  renderDialog();
}

/** 6-position segmented thinking dial (off/low/med/high/xhigh/max); disabled state keeps the affordance */
function thinkDial(
  current: ThinkingLevel,
  opts: { disabled?: boolean; disabledTip?: string; overridden?: boolean },
  onPick: (level: ThinkingLevel) => void,
): HTMLElement {
  const dial = el("span", {
    class: `think-dial${opts.disabled ? " disabled" : ""}`,
    title: opts.disabled ? opts.disabledTip ?? "" : "Thinking level",
  });
  for (const level of THINKING_LEVELS) {
    dial.append(
      el("button", {
        class: `td-seg${level === current ? " active" : ""}`,
        text: level,
        onClick: (e) => {
          e.stopPropagation();
          if (!opts.disabled) onPick(level);
        },
      }),
    );
  }
  if (opts.overridden) dial.append(el("span", { class: "td-note", text: "overridden this session" }));
  return dial;
}

/** capability of a ROLE's assigned model (static-catalog unknown → enabled+unverified) */
function roleModelNoThinking(role: ModelRole): boolean {
  // only the active model's capability is authoritative; for role slots we
  // grey the dial when the role holds the active model and it is no-thinking
  const sel = state.roles[role].selector;
  if (!sel || !state.active) return false;
  return sel.endsWith(`/${state.active.id}`) && state.thinking.capability === "no-thinking";
}

function roleSlot(role: ModelRole): HTMLElement {
  const sel = state.roles[role].selector;
  const label = selectorLabel(sel);
  const slot = el(
    "div",
    {
      class: "role-slot",
      title: "Click to assign",
      onClick: () => void pickModel(`Assign ${role} model`).then((c) => {
        if (c) void assignRoleAction(role, c.selector, "settings");
      }),
    },
    el("div", { class: "rs-role", text: role }),
  );
  if (sel) {
    // two-line layout: provider (may abbreviate) on top, model id below (never clipped)
    if (label.provider) slot.append(el("div", { class: "rs-prov", text: label.provider }));
    slot.append(el("div", { class: "rs-model", text: label.model }));
  } else {
    slot.append(el("div", { class: "rs-model unset", text: "click to assign" }));
  }
  const noThink = roleModelNoThinking(role);
  slot.append(
    thinkDial(
      state.thinking.roles[role],
      {
        disabled: noThink,
        disabledTip: "not supported by this model",
        overridden: role === "default" && state.thinking.sessionOverride !== null,
      },
      (level) => void window.ide.models.setRoleThinking(role, level, "role-rail"),
    ),
  );
  return slot;
}

function renderDialog(): void {
  if (!dialogHead || !dialogBody) return;
  clear(dialogHead);
  clear(dialogBody);

  // global "Check balance" (top-right, quiet; in-flight shows n/total inline)
  const probeTargets = state.providers.filter((p) => p.enabled && p.balanceEndpoint).length;
  const checkBtn = el("button", { class: "btn mh-checkbal", text: "Check balance" }) as HTMLButtonElement;
  checkBtn.disabled = probeTargets === 0;
  if (probeTargets === 0) checkBtn.title = "No profile has a balance endpoint configured";
  checkBtn.addEventListener("click", () => {
    checkBtn.disabled = true;
    let done = 0;
    checkBtn.textContent = `0/${probeTargets}`;
    // state pushes arrive per probe; count them via a temporary listener window
    const tick = () => {
      done++;
      checkBtn.textContent = `${done}/${probeTargets}`;
    };
    const targets = state.providers.filter((p) => p.enabled && p.balanceEndpoint);
    void Promise.allSettled(targets.map((p) => window.ide.models.checkBalance(p.id).then(tick))).then(() => {
      checkBtn.textContent = "Check balance";
      checkBtn.disabled = false;
    });
  });
  const testerBtn = el("button", { class: "btn mh-checkbal", text: "API Tester", title: "Test any base URL + key with a real completion (free-form)", onClick: () => openApiTester() });
  const testAllBtn = el("button", { class: "btn mh-checkbal", text: "Test all", title: "Deep-test every enabled profile (one minimal completion each)" }) as HTMLButtonElement;
  dialogHead.append(
    el(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "10px" } },
      el("h2", { text: "Models", style: { margin: "0", flex: "1" } }),
      testerBtn,
      testAllBtn,
      checkBtn,
    ),
  );
  const rail = el("div", { class: "role-rail" });
  for (const role of MODEL_ROLES) rail.append(roleSlot(role));
  dialogHead.append(rail);

  // auto-swap + poll settings (spec §3: master toggle, per-role opt-out)
  const swapRow = el("div", { class: "mh-swap-row" });
  const swapSw = el("div", {
    class: state.autoSwap.enabled ? "switch on" : "switch",
    title: "Auto-swap: on quota exhaustion re-point the role to another profile with the same model",
    onClick: () => void window.ide.models.setAutoSwap(!state.autoSwap.enabled),
  });
  swapRow.append(swapSw, el("span", { class: "mh-swap-label", text: "auto-swap on quota" }));
  for (const role of MODEL_ROLES) {
    const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
    cb.checked = !state.autoSwap.roleOptOut[role];
    cb.disabled = !state.autoSwap.enabled;
    cb.title = `Allow auto-swap for ${role}`;
    cb.addEventListener("change", () => void window.ide.models.setRoleSwapOptOut(role, !cb.checked));
    swapRow.append(el("label", { class: "mh-role-opt" }, cb, el("span", { text: role })));
  }
  const pollInput = el("input", {
    class: "input mono",
    type: "number",
    value: String(state.balancePollMinutes),
    title: "Balance poll interval, minutes (0 = off)",
    style: { width: "52px" },
  }) as HTMLInputElement;
  pollInput.addEventListener("change", () => {
    const v = parseInt(pollInput.value, 10);
    if (v >= 0 && v <= 120) void window.ide.models.setBalancePollMinutes(v);
  });
  swapRow.append(
    el("span", { style: { flex: "1" } }),
    el("span", { class: "mh-swap-label", text: "poll" }),
    pollInput,
    el("span", { class: "mh-swap-label", text: "m" }),
  );
  dialogBody.append(swapRow);

  // "Test all" results host — rows land individually as verdicts arrive
  const testAllHost = el("div", { class: "ta-host", style: { display: "none" } });
  dialogBody.append(testAllHost);
  testAllBtn.addEventListener("click", () => runTestAll(testAllHost));

  for (const p of state.providers) dialogBody.append(providerCard(p));
  dialogBody.append(addProviderCard());
  void renderEventLog(dialogBody);
}

function providerCard(p: ProviderInfo): HTMLElement {
  const glyph = el("span", { class: "pc-glyph" });
  glyph.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${PROVIDER_GLYPHS[p.template]}</svg>`;

  const readonly = p.origin === "readonly";
  const isActiveProv = state.roles.default.selector?.startsWith(`${p.id}/`) ?? false;
  const card = el("div", {
    class: `mprov-card${p.health === "auth-error" || p.health === "network-error" ? " crit" : ""}${p.health === "depleted" ? " depleted" : ""}${isActiveProv ? " active-prov" : ""}${readonly ? " readonly" : ""}`,
  });

  const enableSw = el("div", {
    class: p.enabled ? "switch on" : "switch",
    title: readonly ? "Managed outside IDE" : p.enabled ? "Disable profile" : "Enable profile",
    onClick: () => {
      if (!readonly) void window.ide.models.setProviderEnabled(p.id, !p.enabled);
    },
  });

  // profile name: inline-editable for parseable profiles (rename propagates atomically)
  const nameEl = el("div", { class: "pc-name", text: p.displayName });
  if (!readonly && p.template === "custom") {
    nameEl.title = "Click to rename profile";
    nameEl.classList.add("editable");
    nameEl.addEventListener("click", () => {
      const input = el("input", { class: "input mono pc-rename" }) as HTMLInputElement;
      input.value = p.id;
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const commit = () => {
        const next = input.value.trim();
        input.replaceWith(nameEl);
        if (!next || next === p.id) return;
        void window.ide.models.renameProfile(p.id, next).then((r) => {
          if (!r.ok) toast(`Rename failed: ${r.error ?? "?"}`, { crit: true });
          else toast(`Profile ${p.id} → ${next}`);
        });
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") input.replaceWith(nameEl);
      });
      input.addEventListener("blur", commit);
    });
  }

  const badges = el("span", { class: "pc-badges" });
  if (p.origin === "imported") badges.append(el("span", { class: "pc-badge", text: "imported" }));
  if (readonly) badges.append(el("span", { class: "pc-badge ro", text: "managed outside IDE" }));
  if (p.health === "depleted") badges.append(el("span", { class: "pc-badge depleted", text: "depleted" }));
  // inline balance readout: value is data (mono), age is context (ui/low).
  // No configured endpoint ⇒ no balance UI at all — never a fake "—".
  if (p.balanceEndpoint && p.balance) {
    const age = Math.max(0, Math.round((Date.now() - p.balance.checkedAt) / 60_000));
    const bal = el("span", {
      class:
        "pc-balance" +
        (p.health === "depleted" || (p.balance.value !== null && p.balance.value <= 0)
          ? " crit"
          : p.lowThreshold !== null && p.balance.value !== null && p.balance.value < p.lowThreshold
            ? " low"
            : ""),
      title: p.balance.value === null ? `unparseable response: ${p.balance.raw ?? ""}` : "Click to re-check balance",
      onClick: () => void window.ide.models.checkBalance(p.id),
    });
    if (p.balance.value === null) {
      bal.append(el("span", { class: "pcb-unparseable", text: "unparseable response" }));
    } else {
      bal.append(
        el("span", { class: "pcb-value mono", text: `${p.balance.value.toFixed(2)}` }),
        p.balance.currency ? el("span", { class: "pcb-unit", text: ` ${p.balance.currency}` }) : "",
      );
    }
    bal.append(el("span", { class: "pcb-age", text: ` · ${age < 1 ? "now" : `${age}m`}` }));
    badges.append(bal);
  }

  card.append(
    el(
      "div",
      { class: "pc-head" },
      glyph,
      el("div", { style: { flex: "1", minWidth: "0" } },
        el("div", { style: { display: "flex", alignItems: "center", gap: "6px" } }, nameEl, badges),
        el("div", { class: "pc-url", text: p.baseUrl || "—" }),
      ),
      el("span", { class: `pc-health ${p.health}`, text: readonly ? "" : p.health }),
      enableSw,
    ),
  );
  if (p.note) card.append(el("div", { class: "pc-detail", text: p.note }));
  if (p.healthDetail) card.append(el("div", { class: "pc-detail", text: p.healthDetail.slice(0, 200) }));
  if (readonly) return card; // no model table, no actions — preserved verbatim
  // model table with pinned type-to-filter (shown for >8 models)
  const table = el("div", { class: "pc-models" });
  const renderRows = (query: string) => {
    for (const row of [...table.children]) if (!row.classList.contains("model-filter")) row.remove();
    const matched = query
      ? p.models
          .map((m) => ({ m, hit: fuzzyMatch(query, m.id) }))
          .filter((x): x is { m: ModelEntry; hit: { score: number; indices: number[] } } => x.hit !== null)
          .sort((a, b) => b.hit.score - a.hit.score)
      : p.models.map((m) => ({ m, hit: { score: 0, indices: [] as number[] } }));
    for (const { m, hit } of matched) {
      const star = el("span", {
        class: m.favorite ? "mm-star on" : "mm-star",
        text: "★",
        title: m.favorite ? "Unfavorite" : "Favorite (shows in quick switcher)",
        onClick: () => void window.ide.models.setFavorite(p.id, m.id, !m.favorite),
      });
      const idSpan = el("span", { class: "mm-id", title: m.name });
      idSpan.append(highlight(m.id, hit.indices, "mm-hl"));
      table.append(
        el(
          "div",
          { class: "mmodel-row" },
          star,
          idSpan,
          el("span", { class: "mm-ctx", text: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "" }),
          el("button", {
            class: "btn mm-use",
            text: "Use",
            title: "Switch default role to this model",
            onClick: () => void switchAction(`${p.id}/${m.id}`, "settings"),
          }),
        ),
      );
    }
    return matched;
  };
  if (p.models.length > 8) {
    let top: ModelEntry | null = null;
    const filterInput = el("input", {
      class: "input",
      placeholder: `Filter ${p.models.length} models…`,
      onInput: () => {
        const res = renderRows(filterInput.value.trim());
        top = res[0]?.m ?? null;
      },
      onKeyDown: (e) => {
        if (e.key === "Enter" && top && filterInput.value.trim()) {
          void switchAction(`${p.id}/${top.id}`, "settings");
        } else if (e.key === "Escape") {
          filterInput.value = "";
          renderRows("");
          e.stopPropagation();
        }
      },
    }) as HTMLInputElement;
    table.append(el("div", { class: "model-filter" }, filterInput));
  }
  renderRows("");
  card.append(table);

  // actions
  const valBtn = el("button", { class: "btn", text: "Test" }) as HTMLButtonElement;
  const deepBtn = el("button", {
    class: "btn",
    text: "Deep test",
    title: "Real completion probe: status, latency, token usage, model echo",
    onClick: () => deepTestProfile(p),
  });
  const valMsg = el("span", { class: "pc-valmsg" });
  valBtn.addEventListener("click", () => {
    valBtn.disabled = true;
    valBtn.textContent = "Testing…";
    void window.ide.models.validateProvider(p.id).then((res) => {
      valBtn.disabled = false;
      valBtn.textContent = "Test";
      valMsg.textContent = res.message;
      valMsg.style.color = res.ok ? "var(--power)" : "var(--crit)";
    });
  });

  const keyBtn = el("button", {
    class: "btn",
    text: p.hasKey ? "Change key…" : "Set key…",
    onClick: () => {
      void inputDialog({ title: `API key for ${p.displayName}`, placeholder: "sk-…", message: "Stored encrypted via OS keychain. Restart the agent session to apply." }).then((key) => {
        if (key) void window.ide.models.setProviderKey(p.id, key);
      });
    },
  });

  const addModelBtn = el("button", {
    class: "btn",
    text: "Add model id…",
    onClick: () => {
      void inputDialog({ title: "Add model id", placeholder: "model-id-as-the-api-expects-it" }).then((id) => {
        if (id) void window.ide.models.addCustomModel(p.id, id);
      });
    },
  });

  const delBtn = el("button", {
    class: "btn btn-danger",
    text: "Remove",
    onClick: () => {
      const file = p.template === "custom" ? "~/.omp/agent/models.yml" : "the IDE registry";
      void confirmDialog({
        title: "Remove profile",
        message: `Remove profile "${p.displayName}"? Its entry is deleted from ${file} and its key is wiped from secure storage.`,
        confirmLabel: "Remove",
        danger: true,
      }).then(async (ok) => {
        if (!ok) return;
        const res = await window.ide.models.removeProvider(p.id);
        if (res && res.needsReassign.length) {
          toast(`Reassign ${res.needsReassign.join(", ")} first — a role points at this profile`, { crit: true });
          void pickModel(`Reassign ${res.needsReassign[0]} model`).then((c) => {
            if (c) void assignRoleAction(res.needsReassign[0], c.selector, "settings");
          });
        }
      });
    },
  });

  const dupBtn = p.template === "custom"
    ? el("button", {
        class: "btn",
        text: "Duplicate…",
        title: "New profile with the same base URL — the fast path for a second endpoint",
        onClick: () => {
          void inputDialog({ title: `Duplicate ${p.displayName}`, placeholder: "new-profile-name", message: `Same template + base URL (${p.baseUrl}); you provide the name and a key.` }).then((name) => {
            if (!name) return;
            void inputDialog({ title: `API key for ${name}`, placeholder: "sk-… (empty = no auth)" }).then((key) => {
              void window.ide.models
                .addProvider({ template: "custom", name, apiKey: key ?? "", baseUrl: p.baseUrl })
                .then((res) => {
                  if (res.ok) toast(`Profile ${res.provider.id} created — ${res.provider.models.length} models`);
                  else toast(`Duplicate failed: ${res.error}`, { crit: true });
                });
            });
          });
        },
      })
    : null;

  card.append(el("div", { class: "pc-actions" }, valBtn, deepBtn, keyBtn, addModelBtn, dupBtn, valMsg, el("span", { style: { flex: "1" } }), delBtn));

  // balance endpoint row: configure + verify in one place (spec §3 P0)
  const epInput = el("input", {
    class: "input mono pc-ep-input",
    placeholder: "Balance endpoint (URL or path, e.g. /wallet/balance) — empty = off",
    value: p.balanceEndpoint,
    title: "GET, authenticated like the profile's completions calls",
  }) as HTMLInputElement;
  epInput.addEventListener("change", () => {
    void window.ide.models.setBalanceEndpoint(p.id, epInput.value);
  });
  const epTest = el("button", { class: "btn", text: "Test" }) as HTMLButtonElement;
  const epMsg = el("span", { class: "pc-valmsg" });
  epTest.addEventListener("click", () => {
    void window.ide.models.setBalanceEndpoint(p.id, epInput.value);
    epTest.disabled = true;
    void window.ide.models.checkBalance(p.id).then((res) => {
      epTest.disabled = false;
      if (!res.ok) {
        epMsg.textContent = res.error ?? "probe failed";
        epMsg.style.color = "var(--crit)";
      } else if (res.value === undefined) {
        epMsg.textContent = "unparseable response";
        epMsg.style.color = "var(--flare)";
        epMsg.title = res.raw ?? "";
      } else {
        epMsg.textContent = `${res.value}${res.currency ? ` ${res.currency}` : ""}`;
        epMsg.style.color = "var(--power)";
      }
    });
  });
  const thInput = el("input", {
    class: "input mono pc-th-input",
    type: "number",
    placeholder: "low ⚠",
    title: "Low-balance warning threshold (empty = off)",
    value: p.lowThreshold !== null ? String(p.lowThreshold) : "",
  }) as HTMLInputElement;
  thInput.addEventListener("change", () => {
    const v = thInput.value.trim();
    void window.ide.models.setLowThreshold(p.id, v === "" ? null : Number(v));
  });
  const reenable = p.health === "depleted"
    ? el("button", {
        class: "btn",
        text: "Re-enable",
        title: "Clear the depleted mark manually",
        onClick: () => void window.ide.models.clearDepleted(p.id),
      })
    : null;
  card.append(el("div", { class: "pc-balance-row" }, epInput, epTest, thInput, reenable, epMsg));
  return card;
}

function addProviderCard(): HTMLElement {
  const tmplSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [id, label] of [
    ["custom", "Custom (OpenAI-compatible) — OMP profile"],
    ["anthropic", "Anthropic"],
    ["openai", "OpenAI"],
    ["google", "Google (Gemini)"],
    ["openrouter", "OpenRouter"],
  ]) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label;
    tmplSelect.append(opt);
  }
  const nameInput = el("input", { class: "input mono", placeholder: "profile-name (slug — becomes the model qualifier)" }) as HTMLInputElement;
  const keyInput = el("input", { class: "input mono", placeholder: "API key" }) as HTMLInputElement;
  keyInput.type = "password";
  const urlInput = el("input", { class: "input mono", placeholder: "Base URL (optional for built-ins)" }) as HTMLInputElement;
  const errEl = el("div", { class: "ab-error", style: { display: "none" } });
  const addBtn = el("button", { class: "btn btn-primary", text: "Validate & Add" }) as HTMLButtonElement;

  const nameRow = el("div", { class: "ab-row" }, nameInput);
  const syncNameVisibility = () => {
    nameRow.style.display = tmplSelect.value === "custom" ? "" : "none";
  };
  tmplSelect.addEventListener("change", syncNameVisibility);
  syncNameVisibility();

  addBtn.addEventListener("click", () => {
    addBtn.disabled = true;
    addBtn.textContent = "Validating…";
    errEl.style.display = "none";
    const template = tmplSelect.value as ProviderTemplateId;
    void window.ide.models
      .addProvider({ template, name: nameInput.value, apiKey: keyInput.value, baseUrl: urlInput.value })
      .then((res) => {
        addBtn.disabled = false;
        addBtn.textContent = "Validate & Add";
        if (res.ok) {
          nameInput.value = "";
          keyInput.value = "";
          urlInput.value = "";
          toast(`Profile ${res.provider.id} added — ${res.provider.models.length} models. Restart the agent session to expose new profiles.`);
        } else {
          errEl.textContent = res.error;
          errEl.style.display = "";
        }
      });
  });

  return el(
    "div",
    { class: "addbot-card" },
    el("div", { class: "panel-header", text: "Add Profile" }),
    el("div", { class: "ab-row" }, tmplSelect),
    nameRow,
    el("div", { class: "ab-row" }, keyInput),
    el("div", { class: "ab-row" }, urlInput, addBtn),
    errEl,
  );
}

async function renderEventLog(host: HTMLElement): Promise<void> {
  const events = await window.ide.models.getEvents();
  if (!events.length) return;
  const wrap = el("div", {});
  wrap.append(el("div", { class: "panel-header", text: "Model Events", style: { padding: "4px 2px" } }));
  const feed = el("div", { class: "cc-feed" });
  for (const ev of [...events].reverse().slice(0, 50)) {
    const d = new Date(ev.time);
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    feed.append(
      el(
        "div",
        { class: "feed-row" },
        el("span", { class: "fr-time", text: t }),
        el("span", { class: "fr-kind", text: ev.kind }),
        el("span", { class: "fr-detail", text: ev.detail }),
        el("span", { class: "fr-bot", text: ev.origin }),
      ),
    );
  }
  wrap.append(feed);
  host.append(wrap);
}

// ---------------------------------------------------------------- agent panel mounts

export function mountUsageStrip(host: HTMLElement): void {
  usageEl = el("div", { class: "usage-strip" });
  host.append(usageEl);
  renderUsage();
}

function renderUsage(): void {
  if (!usageEl) return;
  clear(usageEl);
  usageEl.append(
    el("span", {}, "req ", el("span", { class: "us-val", text: String(usage.requests) })),
  );
  if (usage.hasTokenData) {
    usageEl.append(
      el("span", {}, "in ", el("span", { class: "us-val", text: usage.inputTokens.toLocaleString() })),
      el("span", {}, "out ", el("span", { class: "us-val", text: usage.outputTokens.toLocaleString() })),
    );
    if (usage.reasoningTokens > 0) {
      usageEl.append(
        el("span", {}, "think ", el("span", { class: "us-val", text: usage.reasoningTokens.toLocaleString() })),
      );
    }
  }
  const active = state.active;
  if (active) usageEl.append(el("span", { style: { marginLeft: "auto" } }, el("span", { class: "us-val", text: shortName(active.id) })));
}

/** one-shot "think harder" toggle for the composer row (owned here — single store) */
export function createBoostToggle(): HTMLElement {
  boostBtn = el("button", {
    class: "boost-btn",
    title: "Think harder — one level up for the next send only",
    onClick: () => {
      void window.ide.models.boostOnce("composer").then((r) => {
        if (!r.armed && r.level !== null) toast(`Already at ${r.level} — no higher level`);
        if (!r.armed && r.level === null && state.thinking.capability === "no-thinking")
          toast("Model doesn't support thinking", { crit: true });
      });
    },
  });
  boostBtn.append(svgIcon(I.sparkle), el("span", { class: "bb-label", text: "boost" }));
  renderBoost();
  return boostBtn;
}

function renderBoost(): void {
  if (!boostBtn) return;
  const noThink = state.thinking.capability === "no-thinking";
  boostBtn.style.display = noThink ? "none" : "";
  const armed = state.thinking.boost !== null;
  boostBtn.classList.toggle("armed", armed);
  const label = boostBtn.querySelector(".bb-label");
  if (label) label.textContent = armed ? `boost ${state.thinking.boost}` : "boost";
  boostBtn.title = armed
    ? `Boost armed: ${state.thinking.boost} for the next send — click to disarm`
    : "Think harder — one level up for the next send only";
}

export function mountModelWarning(host: HTMLElement): void {
  warnHost = host;
}

function renderWarning(): void {
  if (!warnHost) return;
  warnHost.querySelector(".model-warn")?.remove();
  const broken = anyRoleProviderBroken();
  if (!broken) return;
  // "flip to my other endpoint": same model id on OTHER healthy profiles first
  const brokenModel = state.roles.default.selector?.startsWith(`${broken.id}/`)
    ? state.roles.default.selector.slice(broken.id.length + 1)
    : null;
  const switchLabel = brokenModel ? "Switch profile" : "Switch model";
  const banner = el(
    "div",
    { class: "model-warn" },
    el("div", {},
      el("div", { text: `Profile "${broken.displayName}" is failing (${broken.health})` }),
      el("div", { class: "mw-detail", text: (broken.healthDetail ?? "").slice(0, 120) }),
    ),
    el(
      "span",
      { class: "mw-actions" },
      el("button", { class: "btn", text: "Fix key", onClick: () => openModelsDialog() }),
      el("button", {
        class: "btn",
        text: switchLabel,
        onClick: () => {
          void pickModel(
            brokenModel ? `Switch profile for ${brokenModel}` : "Switch model…",
            brokenModel ? { prefilter: brokenModel, excludeProfile: broken.id } : undefined,
          ).then((c) => {
            if (c) void switchAction(c.selector, "recovery");
          });
        },
      }),
      el("button", {
        class: "btn",
        text: "Retry",
        onClick: () => void window.ide.models.validateProvider(broken.id),
      }),
    ),
  );
  warnHost.prepend(banner);
}

// ---------------------------------------------------------------- init

export function initModels(): void {
  void window.ide.models.getState().then((s) => {
    state = s;
    renderChip();
    renderUsage();
    renderWarning();
    renderBoost();
  });
  void window.ide.models.getUsage().then((u) => {
    usage = u;
    renderUsage();
  });
  window.ide.models.onState((s) => {
    state = s;
    renderChip();
    renderUsage();
    renderWarning();
    renderBoost();
    if (dialogBody) renderDialog();
  });
  window.ide.models.onUsage((u) => {
    usage = u;
    renderUsage();
  });
  window.ide.models.onThinkRejected((modelId) => {
    toast(`Model ${modelId} doesn't support thinking — level ignored`, { crit: true });
  });
  window.ide.models.onRolesOrphaned((roles) => {
    forceReassignRoles(roles);
  });
  window.ide.models.onSwapNotice(({ message, crit }) => {
    toast(message, crit ? { crit: true } : {});
    // one-time flare→power fade on the swapped role slot (240ms, then calm)
    for (const slot of document.querySelectorAll(".role-slot")) {
      if (message.includes(slot.querySelector(".rs-role")?.textContent ?? "\u0000")) {
        slot.classList.remove("swap-flash");
        void (slot as HTMLElement).offsetWidth;
        slot.classList.add("swap-flash");
        setTimeout(() => slot.classList.remove("swap-flash"), 300);
      }
    }
  });
}
