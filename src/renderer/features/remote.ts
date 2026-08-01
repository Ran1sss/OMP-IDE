/**
 * Remote Control Center: bot cards, add-bot flow, pairing dialog,
 * activity feed, status-bar beacon + popover. All gold.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { toast, confirmDialog, selectDialog } from "../core/ui";
import { on } from "../core/bus";
import { t, applyLang, resolveLang } from "../core/i18n";
import {
  initChatWatch,
  watchChatsSection,
  proposalsSection,
  cooldownControl,
  pendingProposals,
  pendingProposalsFor,
  botRequestsSection,
  toggleBotRequests,
  requestsOpen,
} from "./chatwatch";
import type {
  RemoteState,
  RemoteBotInfo,
  RemoteActivityEvent,
  RemotePairing,
} from "../../shared/types";

const ANTENNA = `<path d="M8 8.5v5"/><circle cx="8" cy="7.5" r="1.3"/><path d="M4.8 4.3a4.6 4.6 0 0 0 0 6.4M11.2 4.3a4.6 4.6 0 0 1 0 6.4"/><path d="M3 2.5a7.4 7.4 0 0 0 0 10M13 2.5a7.4 7.4 0 0 1 0 10"/>`;
const BOT_GLYPH = `<rect x="3" y="5" width="10" height="8" rx="2"/><circle cx="6.2" cy="8.5" r="1"/><circle cx="9.8" cy="8.5" r="1"/><path d="M8 5V2.8M6 11h4"/>`;

let ccRoot: HTMLElement | null = null;
let feedEl: HTMLElement | null = null;
let state: RemoteState = { globalEnabled: true, digestIntervalMs: 3000, proxyUrl: "", bots: [], pairing: null };
let activity: RemoteActivityEvent[] = [];

// pairing dialog live handles (so state pushes can flip it to "paired")
let pairingUi: {
  botId: string;
  codeEl: HTMLElement;
  ringFg: SVGCircleElement;
  hintEl: HTMLElement;
  timer: number;
  close: () => void;
} | null = null;

// beacon
let beaconEl: HTMLElement | null = null;
let beaconErrDot: HTMLElement | null = null;
let relayResetTimer: number | undefined;
let beaconBadge: HTMLElement | null = null;
let lastBadgeCount = 0;

/** gold pending-proposal count; count CHANGES crossfade, mere presence never animates */
function updateBeaconBadge(): void {
  if (!beaconBadge) return;
  const n = pendingProposals().length;
  const label = n > 9 ? "9+" : String(n);
  if (n === lastBadgeCount) return;
  lastBadgeCount = n;
  beaconBadge.style.display = n ? "" : "none";
  if (!n) return;
  beaconBadge.textContent = label;
  beaconBadge.classList.remove("count-fade");
  void beaconBadge.offsetWidth; // restart animation
  beaconBadge.classList.add("count-fade");
}

// ---------------------------------------------------------------- helpers

function switchEl(on: boolean, onToggle: (next: boolean) => void, title: string): HTMLElement {
  // optimistic: flip the visual immediately so a follow-up click sends the
  // opposite intent even before the state push re-renders the card
  const toggle = () => {
    const next = !sw.classList.contains("on");
    sw.classList.toggle("on", next);
    onToggle(next);
  };
  const sw = el("div", {
    class: on ? "switch on" : "switch",
    title,
    onClick: toggle,
  });
  sw.tabIndex = 0;
  sw.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  return sw;
}

function timeShort(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- bot card

function botCard(bot: RemoteBotInfo): HTMLElement {
  const glyph = el("span", { class: "bc-glyph" });
  glyph.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${BOT_GLYPH}</svg>`;

  const dot = el("span", { class: `bot-dot ${bot.state}`, dataset: { botDot: bot.id }, title: bot.state });

  const card = el("div", { class: bot.state === "auth-error" ? "bot-card auth-error" : "bot-card" });

  const head = el(
    "div",
    { class: "bc-head" },
    glyph,
    el("div", {},
      el("div", { class: "bc-name", text: bot.name }),
      el("div", { class: "bc-user", text: `@${bot.username}` }),
    ),
    el("span", { class: "bc-spacer" }),
    dot,
    switchEl(bot.enabled, (next) => void window.ide.remote.setBotEnabled(bot.id, next), bot.enabled ? t("rc.disableBot") : t("rc.enableBot")),
  );
  card.append(head);

  card.append(
    el(
      "div",
      { class: "bc-meta" },
      el("span", {}, `${t("rc.state")}: `, el("span", { class: "mono", text: bot.state })),
      el("span", {}, `${t("rc.msgs")}: `, el("span", { class: "mono", text: String(bot.sessionMessages) })),
      el("span", {}, `${t("rc.last")}: `, el("span", { class: "mono", text: bot.lastActivity ? timeShort(bot.lastActivity) : "—" })),
    ),
  );
  if (bot.detail && (bot.state === "auth-error" || bot.state === "degraded")) {
    card.append(el("div", { class: "bc-detail", text: bot.detail.slice(0, 160) }));
    // A proxy that died AFTER being committed shows up as generic network
    // failures; point at the likely culprit instead of leaving the user to guess.
    if (bot.state === "degraded" && state.proxyUrl)
      card.append(el("div", { class: "bc-detail", text: t("rc.proxyDegraded") }));
  }

  if (bot.paired.length) {
    const list = el("div", { class: "bc-paired" });
    for (const u of bot.paired) {
      // owner crown (owner-fix): the bot names crowned users in group replies
      const crown = el("button", {
        class: u.owner ? "icon-btn pu-crown on" : "icon-btn pu-crown",
        title: u.owner ? t("rc.removeOwner") : t("rc.makeOwner"),
        onClick: () => {
          void window.ide.remote.setUserOwner(bot.id, u.telegramId, !u.owner).then((res) => {
            if (!res.ok) toast(res.error === "last-owner" ? t("rc.ownerLast") : (res.error ?? "?"), { crit: true });
          });
        },
      }, "♛");
      const revoke = el("button", {
        class: "icon-btn pr-x",
        title: t("rc.revokeUser", u.username),
        onClick: () => {
          const others = bot.paired.filter((p) => p.telegramId !== u.telegramId);
          const lastOwner = !!u.owner && !others.some((p) => p.owner);
          const doRevoke = () => {
            void confirmDialog({
              title: t("rc.revokeTitle"),
              message: t("rc.revokeMsg", u.username, bot.username),
              confirmLabel: t("rc.revoke"),
              danger: true,
            }).then((ok) => {
              if (ok) void window.ide.remote.revokeUser(bot.id, u.telegramId);
            });
          };
          if (lastOwner && others.length) {
            // forced choice: crown a successor BEFORE the un-pair completes
            void selectDialog(t("rc.chooseOwner"), others.map((p) => `${p.firstName} @${p.username}`)).then((pick) => {
              if (!pick) return;
              const next = others.find((p) => pick.endsWith(`@${p.username}`));
              if (!next) return;
              void window.ide.remote.setUserOwner(bot.id, next.telegramId, true).then(() => doRevoke());
            });
          } else {
            doRevoke();
          }
        },
      });
      revoke.append(svgIcon(I.close));
      list.append(
        el(
          "div",
          { class: "paired-row" },
          crown,
          el("span", { text: u.firstName }),
          el("span", { class: "mono", text: `@${u.username}` }),
          revoke,
        ),
      );
    }
    card.append(list);
  }

  const pairBtn = el("button", {
    class: "btn",
    text: t("rc.pairUser"),
    onClick: () => void beginPairing(bot),
  });
  // «Запросы» (remote-fix 3): permanent home for this bot's proposals, gold
  // count badge while any are pending
  const reqCount = pendingProposalsFor(bot.id).length;
  const reqBtn = el("button", {
    class: `btn bc-requests-btn${requestsOpen(bot.id) ? " open" : ""}`,
    onClick: () => toggleBotRequests(bot.id),
  },
    el("span", { text: t("rc.requests") }),
    reqCount > 0 ? el("span", { class: "bc-req-badge mono", text: String(reqCount) }) : null,
  );
  const delBtn = el("button", {
    class: "btn btn-danger bc-del",
    text: t("rc.delete"),
    onClick: () => {
      void confirmDialog({
        title: t("rc.deleteTitle"),
        message: t("rc.deleteMsg", bot.username),
        confirmLabel: t("rc.delete"),
        danger: true,
      }).then((ok) => {
        if (ok) void window.ide.remote.removeBot(bot.id);
      });
    },
  });
  const chats = watchChatsSection(bot);
  if (chats) card.append(chats);
  card.append(el("div", { class: "bc-actions" }, pairBtn, reqBtn, delBtn));
  const requests = botRequestsSection(bot);
  if (requests) card.append(requests);
  return card;
}

// ---------------------------------------------------------------- add bot

function addBotCard(): HTMLElement {
  const input = el("input", { class: "input mono", placeholder: t("rc.tokenPlaceholder") }) as HTMLInputElement;
  input.type = "password";
  const errEl = el("div", { class: "ab-error", style: { display: "none" } });
  const addBtn = el("button", { class: "btn btn-primary", text: t("rc.add") }) as HTMLButtonElement;

  addBtn.addEventListener("click", () => {
    const token = input.value.trim();
    if (!token) return;
    addBtn.disabled = true;
    addBtn.textContent = t("rc.checking");
    errEl.style.display = "none";
    // Two-step registration (spec §3.1): probe getMe first, show the bot's
    // identity, and register only after the operator confirms it.
    void window.ide.remote
      .checkToken(token)
      .then((probe) => {
        if (!probe.ok) {
          errEl.textContent = probe.error;
          errEl.style.display = "";
          return null;
        }
        return confirmDialog({
          title: t("rc.registerTitle"),
          message: t("rc.registerMsg", probe.name, probe.username),
          confirmLabel: t("rc.register"),
        }).then((ok) => (ok ? window.ide.remote.addBot(token) : null));
      })
      .then((res) => {
        if (res) {
          if (res.ok) {
            input.value = "";
            toast(t("rc.registered", res.bot.username));
          } else {
            errEl.textContent = res.error;
            errEl.style.display = "";
          }
        }
      })
      .finally(() => {
        addBtn.disabled = false;
        addBtn.textContent = t("rc.add");
      });
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBtn.click();
  });

  return el(
    "div",
    { class: "addbot-card" },
    el("div", { class: "panel-header", text: t("rc.addBot") }),
    el("div", { class: "ab-note", text: t("rc.addBotNote") }),
    el("div", { class: "ab-row" }, input, addBtn),
    errEl,
  );
}

// ---------------------------------------------------------------- pairing

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** wait until the bot's runtime can receive /start (polling), or fail honestly */
async function waitForBotLive(
  botId: string,
  timeoutMs: number,
): Promise<{ ok: true; bot: RemoteBotInfo } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: RemoteBotInfo | undefined;
  while (Date.now() < deadline) {
    const s = await window.ide.remote.getState();
    last = s.bots.find((b) => b.id === botId);
    if (!last) return { ok: false, error: t("rc.botRemoved") };
    if (last.state === "auth-error")
      return { ok: false, error: t("rc.tokenRejected", last.detail ?? "auth error") };
    if (last.state === "polling" || last.state === "relaying") return { ok: true, bot: last };
    await sleep(300);
  }
  if (last?.state === "degraded")
    return { ok: false, error: t("rc.noReachTelegram", last.detail ?? "network error") };
  return { ok: false, error: t("rc.botStartTimeout") };
}

async function beginPairing(bot: RemoteBotInfo): Promise<void> {
  if (!state.globalEnabled) {
    toast(t("rc.masterOffToast"), { crit: true });
    return;
  }
  // pairing needs the bot polling; enable it ourselves instead of bouncing the user
  if (!bot.enabled) {
    toast(t("rc.startingBot", bot.username));
    await window.ide.remote.setBotEnabled(bot.id, true);
  }
  const live = await waitForBotLive(bot.id, 15_000);
  if (!live.ok) {
    toast(live.error, { crit: true });
    return;
  }
  const pairing = await window.ide.remote.startPairing(bot.id);
  showPairingDialog(live.bot, pairing);
}

function showPairingDialog(bot: RemoteBotInfo, pairing: RemotePairing): void {
  pairingUi?.close();

  const R = 70;
  const CIRC = 2 * Math.PI * R;
  const ringSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ringSvg.setAttribute("viewBox", "0 0 148 148");
  ringSvg.classList.add("ring");
  ringSvg.innerHTML =
    `<circle class="ring-bg" cx="74" cy="74" r="${R}" fill="none" stroke-width="3"/>` +
    `<circle class="ring-fg" cx="74" cy="74" r="${R}" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="0"/>`;
  const ringFg = ringSvg.querySelector(".ring-fg") as SVGCircleElement;

  const codeEl = el("div", {
    class: "pairing-code",
    text: pairing.code,
    title: t("rc.clickCopy"),
    onClick: () => {
      void navigator.clipboard.writeText(pairing.code);
      toast(t("rc.codeCopied"));
    },
  });
  const startChip = () =>
    el("code", {
      class: "copyable",
      text: `/start ${pairing.code}`,
      title: t("rc.clickCopy"),
      onClick: () => {
        void navigator.clipboard.writeText(`/start ${pairing.code}`);
        toast(t("rc.cmdCopied"));
      },
    });
  const hintEl = el("div", { class: "pairing-hint" });
  hintEl.append(t("rc.pairHintPrefix"), startChip(), t("rc.pairHintSuffix", bot.username, "5:00"));

  const link = `t.me/${bot.username}`;
  const copyBtn = el("button", {
    class: "icon-btn",
    title: t("rc.copyLink"),
    onClick: () => {
      void navigator.clipboard.writeText(`https://${link}`);
      toast(t("rc.linkCopied"));
    },
  });
  copyBtn.append(svgIcon(I.file));

  const overlay = el("div", { class: "overlay centered" });
  const close = () => {
    clearInterval(pairingUi?.timer);
    pairingUi = null;
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
    void window.ide.remote.cancelPairing();
  };

  const dialog = el(
    "div",
    { class: "dialog", style: { minWidth: "360px" } },
    el("h2", { text: t("rc.pairWith", bot.username) }),
    el(
      "div",
      { class: "pairing-body" },
      el("div", { class: "pairing-ring" }, ringSvg as unknown as HTMLElement, codeEl),
      hintEl,
      el("div", { class: "pairing-link" },
        el("a", {
          text: link,
          onClick: (e) => {
            e.preventDefault();
            window.ide.win.openExternal(`https://${link}`);
          },
          style: { cursor: "pointer" },
        }),
        copyBtn,
      ),
    ),
    el("div", { class: "dialog-actions" }, el("button", { class: "btn", text: t("rc.dlgClose"), onClick: close })),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add("visible"));

  const timer = window.setInterval(() => {
    const left = pairing.expiresAt - Date.now();
    if (left <= 0) {
      close();
      return;
    }
    ringFg.style.strokeDashoffset = String(CIRC * (1 - left / (5 * 60_000)));
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    clear(hintEl);
    hintEl.append(t("rc.pairHintPrefix"), startChip(), t("rc.pairHintSuffix", bot.username, `${m}:${String(s).padStart(2, "0")}`));
  }, 1000);

  pairingUi = { botId: bot.id, codeEl, ringFg, hintEl, timer, close };
}

/** called from state pushes: pairing vanished while dialog open + a new user appeared = success */
function maybeCompletePairing(prev: RemoteState, next: RemoteState): void {
  if (!pairingUi) return;
  if (next.pairing) return; // still pending
  const botId = pairingUi.botId;
  const before = prev.bots.find((b) => b.id === botId)?.paired.length ?? 0;
  const after = next.bots.find((b) => b.id === botId)?.paired.length ?? 0;
  const ui = pairingUi;
  if (after > before) {
    clearInterval(ui.timer);
    ui.codeEl.textContent = "✓";
    ui.codeEl.classList.add("paired-ok");
    ui.ringFg.style.strokeDashoffset = "0";
    clear(ui.hintEl);
    ui.hintEl.append("Paired.");
    setTimeout(() => ui.close(), 1600);
    pairingUi = null; // close() must not cancelPairing-toast again
  }
}

// ---------------------------------------------------------------- activity feed

function feedRow(ev: RemoteActivityEvent): HTMLElement {
  return el(
    "div",
    { class: ev.kind === "blocked-unauthorized" ? "feed-row blocked" : ev.kind === "dialog" ? "feed-row dialog" : ev.kind === "dialog-guard" ? "feed-row dialog-guard" : "feed-row" },
    el("span", { class: "fr-time", text: timeShort(ev.time) }),
    el("span", { class: "fr-kind", text: ev.kind === "blocked-unauthorized" ? t("rc.blocked") : ev.kind === "dialog" ? t("rc.dialog") : ev.kind === "dialog-guard" ? t("rc.dialogGuard") : ev.kind }),
    el("span", { class: "fr-sender", text: ev.sender }),
    el("span", { class: "fr-detail", text: ev.detail }),
    el("span", { class: "fr-bot", text: ev.botUsername ? `@${ev.botUsername}` : "" }),
  );
}

function renderFeed(): void {
  if (!feedEl) return;
  clear(feedEl);
  if (!activity.length) {
    feedEl.append(el("div", { class: "cc-empty", text: t("rc.noActivity") }));
    return;
  }
  for (const ev of [...activity].reverse()) feedEl.append(feedRow(ev));
}

// ---------------------------------------------------------------- main render

/** compact RU/EN picker (fix 4) — global setting, applies live */
function langSelector(): HTMLElement {
  const sel = el("select", { class: "cc-lang", title: t("set.language") }) as HTMLSelectElement;
  const opts: [string, string][] = [["auto", t("set.langAuto")], ["ru", "Русский"], ["en", "English"]];
  for (const [v, label] of opts) {
    const o = el("option", { text: label }) as HTMLOptionElement;
    o.value = v;
    sel.append(o);
  }
  void window.ide.store.getSettings().then((s) => {
    sel.value = s.uiLang ?? "auto";
  });
  sel.addEventListener("change", () => {
    void window.ide.store.setSettings({ uiLang: sel.value as "auto" | "ru" | "en" }).then((s) => {
      applyLang(resolveLang(s.uiLang));
    });
  });
  return sel;
}

function renderControlCenter(): void {
  if (!ccRoot) return;
  clear(ccRoot);

  const digestInput = el("input", {
    class: "input mono cc-num",
    type: "number",
    value: String(Math.round(state.digestIntervalMs / 1000)),
    title: t("rc.digestTitle"),
    onChange: (e) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      if (v >= 1 && v <= 30) void window.ide.remote.setDigestInterval(v * 1000);
    },
  });

  ccRoot.append(
    el(
      "div",
      { class: "cc-global" },
      switchEl(state.globalEnabled, (next) => void window.ide.remote.setGlobalEnabled(next), t("rc.master")),
      el("div", { style: { flex: "1 1 130px" } },
        el("div", { style: { fontWeight: "700", fontSize: "12.5px" }, text: t("rc.remoteControl") }),
        el("div", { class: "cc-note", text: t("rc.worksOnly") }),
      ),
      // compact language selector (fix 4) — the Remote header area surface
      langSelector(),
      // digest+cooldown wrap below the title as ONE unit at narrow widths
      el("span", { class: "cc-dials" },
        el("span", { class: "cc-note", text: t("rc.digestLbl") }),
        digestInput,
        el("span", { class: "cc-note", text: t("rc.secSuffix") }),
        ...cooldownControl(),
      ),
    ),
  );

  // telegram proxy (api.telegram.org is blocked for many RF users)
  const proxyInput = el("input", {
    class: "input mono",
    placeholder: t("rc.proxyPlaceholder"),
    value: state.proxyUrl,
    title: t("rc.proxyInputTitle"),
  }) as HTMLInputElement;
  const proxyApply = el("button", { class: "btn", text: t("rc.apply") }) as HTMLButtonElement;
  const proxyTest = el("button", { class: "btn", text: t("rc.proxyTest"), title: t("rc.proxyTestTitle") }) as HTMLButtonElement;
  const applyProxy = () => {
    const url = proxyInput.value.trim();
    if (url === state.proxyUrl) return;
    proxyApply.disabled = true;
    void window.ide.remote.setProxyUrl(url).then((res) => {
      proxyApply.disabled = false;
      if (res.ok) toast(url ? t("rc.proxyApplied", res.probe ?? t("rc.proxySetFallback")) : t("rc.proxyCleared"));
      else toast(res.error ?? t("rc.invalidProxy"), { crit: true });
    });
  };
  const testProxy = () => {
    proxyTest.disabled = true;
    void window.ide.remote.testProxy(proxyInput.value).then((res) => {
      proxyTest.disabled = false;
      toast(res.detail, { crit: !res.ok });
    });
  };
  proxyApply.addEventListener("click", applyProxy);
  proxyTest.addEventListener("click", testProxy);
  proxyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyProxy();
  });
  ccRoot.append(
    el(
      "div",
      { class: "cc-proxy" },
      el("span", { class: "cc-note", text: t("rc.proxy") }),
      proxyInput,
      proxyApply,
      proxyTest,
    ),
  );

  const proposals = proposalsSection();
  if (proposals) ccRoot.append(proposals);

  for (const bot of state.bots) ccRoot.append(botCard(bot));
  ccRoot.append(addBotCard());

  ccRoot.append(el("div", { class: "panel-header", text: t("rc.activity"), style: { padding: "6px 2px 2px" } }));
  feedEl = el("div", { class: "cc-feed" });
  ccRoot.append(feedEl);
  renderFeed();
}

// ---------------------------------------------------------------- beacon

function aggregateBeacon(): void {
  if (!beaconEl) return;
  const anyError = state.bots.some((b) => b.enabled && b.state === "auth-error");
  const anyLive = state.globalEnabled && state.bots.some((b) => b.enabled && (b.state === "polling" || b.state === "relaying" || b.state === "degraded"));
  beaconEl.classList.toggle("polling", anyLive);
  if (beaconErrDot) beaconErrDot.style.display = anyError ? "" : "none";
}

function beaconRelayPulse(): void {
  if (!beaconEl) return;
  beaconEl.classList.remove("relaying");
  void beaconEl.offsetWidth; // restart animation
  beaconEl.classList.add("relaying");
  clearTimeout(relayResetTimer);
  relayResetTimer = window.setTimeout(() => beaconEl?.classList.remove("relaying"), 600);
}

function showBeaconPopover(anchor: HTMLElement, openCC: () => void): void {
  document.querySelector(".beacon-pop")?.remove();
  const pop = el("div", { class: "beacon-pop" });
  if (!state.bots.length) {
    pop.append(el("div", { class: "bp-row", text: t("rc.noBots") }));
  }
  const pending = pendingProposals();
  if (pending.length) {
    pop.append(el("div", { class: "bp-proposals-hdr", text: t("rc.pendingProposals") }));
    for (const p of pending) {
      pop.append(
        el(
          "div",
          { class: "bp-row bp-proposal", onClick: () => { pop.remove(); openCC(); } },
          el("span", { class: "bp-gold-dot" }),
          el("span", { class: "bp-headline", text: p.headline }),
        ),
      );
    }
  }
  for (const b of state.bots) {
    pop.append(
      el(
        "div",
        { class: "bp-row" },
        el("span", { class: `bot-dot ${b.state}` }),
        el("span", { class: "mono", text: `@${b.username}` }),
        el("span", { text: b.state }),
        el("span", { style: { marginLeft: "auto" }, text: b.lastActivity ? timeShort(b.lastActivity) : "" }),
      ),
    );
  }
  const killBtn = el("button", {
    class: state.globalEnabled ? "btn btn-danger" : "btn",
    text: state.globalEnabled ? t("rc.killAll") : t("rc.enableRemote"),
    onClick: () => {
      void window.ide.remote.setGlobalEnabled(!state.globalEnabled);
      pop.remove();
    },
  });
  const openBtn = el("button", { class: "btn", text: t("rc.controlCenter"), onClick: () => { pop.remove(); openCC(); } });
  pop.append(el("div", { class: "bp-actions" }, openBtn, el("span", { style: { flex: "1" } }), killBtn));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - pr.width - 8)}px`;
  pop.style.top = `${r.top - pr.height - 8}px`;
  setTimeout(() => {
    const onDown = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node)) {
        pop.remove();
        window.removeEventListener("mousedown", onDown, { capture: true });
      }
    };
    window.addEventListener("mousedown", onDown, { capture: true });
  });
}

export function createBeacon(openCC: () => void): HTMLElement {
  beaconEl = el("span", { class: "beacon", title: t("rc.remoteControl") });
  beaconEl.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ANTENNA}</svg>`;
  beaconErrDot = el("span", { class: "beacon-err", style: { display: "none" } });
  beaconEl.append(beaconErrDot);
  const wrap = el("span", { class: "sb-item", title: t("rc.remoteControl"), onClick: () => showBeaconPopover(wrap, openCC) });
  wrap.append(beaconEl);
  beaconBadge = el("span", { class: "beacon-badge", style: { display: "none" } });
  wrap.append(beaconBadge);
  updateBeaconBadge();
  aggregateBeacon();
  return wrap;
}

// ---------------------------------------------------------------- init

export function initRemote(container: HTMLElement): void {
  ccRoot = container;
  ccRoot.classList.add("control-center");

  void window.ide.remote.getState().then((s) => {
    state = s;
    renderControlCenter();
    aggregateBeacon();
  });
  void window.ide.remote.getActivity().then((a) => {
    activity = a;
    renderFeed();
  });

  window.ide.remote.onState((s) => {
    const prev = state;
    state = s;
    maybeCompletePairing(prev, s);
    renderControlCenter();
    aggregateBeacon();
  });
  window.ide.remote.onActivity((ev) => {
    activity.push(ev);
    if (activity.length > 100) activity.shift();
    renderFeed();
  });
  window.ide.remote.onRelay((botId) => {
    beaconRelayPulse();
    const dot = document.querySelector(`[data-bot-dot="${CSS.escape(botId)}"]`);
    if (dot) {
      dot.classList.remove("relaying");
      void (dot as HTMLElement).offsetWidth;
      dot.classList.add("relaying");
      setTimeout(() => dot.classList.remove("relaying"), 600);
    }
  });
  initChatWatch(() => {
    renderControlCenter();
    updateBeaconBadge();
  });
  // language switch re-renders the whole view live (fix 4)
  on("lang-changed", () => renderControlCenter());
}
