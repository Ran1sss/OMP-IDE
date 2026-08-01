/**
 * API Tester UI (spec: omp-ide-api-tester-prompt.md): verdict card, free-form
 * tester dialog, Deep test entry points. hvoy.ai is the methodology reference
 * and a link-out — keys go ONLY to the endpoint under test, never to hvoy.ai.
 *
 * One engine, two entry points: openApiTester() (free-form / prefilled) and
 * deepTestProfile() both render the same verdict card from the same result
 * type. Deletable without harming Models/Profiles.
 */

import { el, clear } from "../core/dom";
import { t } from "../core/i18n";
import { toast, inputDialog } from "../core/ui";
import type {
  ProviderInfo,
  TesterProtocol,
  TesterResult,
  TesterTarget,
  TesterVerdict,
} from "../../shared/types";
import { TESTER_PROTOCOLS } from "../../shared/types";

const PROTOCOL_LABELS: Record<TesterProtocol, string> = {
  "openai-chat": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

function verdictLabel(v: TesterVerdict): string {
  switch (v) {
    case "ok": return t("tst.verdictOk");
    case "auth": return t("tst.verdictAuth");
    case "quota": return t("tst.verdictQuota");
    case "rate-limited": return t("tst.verdictRate");
    case "http-error": return t("tst.verdictHttp");
    case "network": return t("tst.verdictNetwork");
    case "model-mismatch": return t("tst.verdictMismatch");
    case "unparseable": return t("tst.verdictUnparseable");
  }
}

/** verdict → chip family: ok = power, quota = flare, the rest of the failures = crit */
function verdictClass(v: TesterVerdict): string {
  if (v === "ok") return "v-ok";
  if (v === "quota" || v === "rate-limited") return "v-flare";
  return "v-crit";
}

/** session-only history (P0: not persisted) */
const history: TesterResult[] = [];
const MAX_HISTORY = 20;

let hintsCache: Record<TesterProtocol, string[]> | null = null;

// ---------------------------------------------------------------- verdict card

function fmtMs(ms: number | null): string {
  return ms === null ? "—" : t("tst.msValue", ms);
}

/** class suffix stays technical (h-fast/h-ok/h-slow); displayed word translates */
function ttfbHint(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? "fast" : ms < 3000 ? "ok" : "slow";
}


/** minimal JSON syntax tint: keys mid, strings hi, numbers power */
function tintJson(text: string): HTMLElement {
  const holder = el("div", { class: "tj" });
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) holder.append(text.slice(last, m.index));
    if (m[1] !== undefined) {
      holder.append(el("span", { class: m[2] ? "tj-key" : "tj-str", text: m[1] }));
      if (m[2]) holder.append(m[2]);
    } else if (m[3] !== undefined) {
      holder.append(el("span", { class: "tj-num", text: m[3] }));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) holder.append(text.slice(last));
  return holder;
}

export function renderVerdictCard(r: TesterResult): HTMLElement {
  const card = el("div", { class: "tester-card materialize" });

  // status line
  const chip = el("span", { class: `tc-verdict mono ${verdictClass(r.verdict)}`, text: verdictLabel(r.verdict) });
  const targetLabel = `${r.target.profileId ? r.target.profileId + " · " : ""}${r.target.model}`;
  card.append(
    el("div", { class: "tc-status" },
      chip,
      r.httpStatus !== null ? el("span", { class: "mono tcs-http", text: `HTTP ${r.httpStatus}` }) : null,
      el("span", { class: "tcs-target", title: r.target.baseUrl, text: targetLabel }),
      el("span", { class: "tcs-proto mono", text: PROTOCOL_LABELS[r.target.protocol] }),
    ),
  );
  if (r.verdict !== "ok") {
    card.append(el("div", { class: "tc-detail mono", text: r.detail.slice(0, 600) }));
  }

  // latency block — TTFB is the typographic anchor
  const hintCls = ttfbHint(r.ttfbMs);
  const hintWord = hintCls === "fast" ? t("tst.hintFast") : hintCls === "ok" ? t("tst.hintOk") : hintCls === "slow" ? t("tst.hintSlow") : "";
  const lat = el("div", { class: "tc-latency" },
    el("div", { class: "tcl-item" },
      el("span", { class: "tcl-value mono", text: fmtMs(r.ttfbMs) }),
      el("span", { class: "tcl-label" }, "TTFB", r.ttfbMs !== null ? el("span", { class: `tcl-hint h-${hintCls}`, text: ` · ${hintWord}` }) : ""),
    ),
    el("div", { class: "tcl-item" },
      el("span", { class: "tcl-value mono sm", text: fmtMs(r.totalMs) }),
      el("span", { class: "tcl-label", text: t("tst.total") }),
    ),
  );
  if (r.firstTokenMs !== null) {
    lat.append(el("div", { class: "tcl-item" },
      el("span", { class: "tcl-value mono sm", text: fmtMs(r.firstTokenMs) }),
      el("span", { class: "tcl-label", text: t("tst.firstToken") }),
    ));
  }
  if (r.chunkCount !== null) {
    lat.append(el("div", { class: "tcl-item" },
      el("span", { class: "tcl-value mono sm", text: String(r.chunkCount) }),
      el("span", { class: "tcl-label", text: t("tst.chunks") }),
    ));
  }
  card.append(lat);

  // usage
  const usageRow = el("div", { class: "tc-usage" });
  if (r.usage) {
    usageRow.append(
      el("span", { class: "mono", text: r.usage.input !== null ? String(r.usage.input) : "—" }),
      el("span", { class: "tcu-label", text: t("tst.usageIn") }),
      el("span", { class: "mono", text: r.usage.output !== null ? String(r.usage.output) : "—" }),
      el("span", { class: "tcu-label", text: t("tst.usageOut") }),
    );
    if (r.usage.reasoning !== null && r.usage.reasoning > 0) {
      usageRow.append(
        el("span", { class: "tcu-label", text: " · " }),
        el("span", { class: "mono", text: String(r.usage.reasoning) }),
        el("span", { class: "tcu-label", text: t("tst.usageReasoning") }),
      );
    }
  } else {
    usageRow.append(el("span", { class: "tcu-label", text: t("tst.usageMissing") }));
  }
  card.append(usageRow);

  // model echo — the authenticity signal
  const mismatch = r.verdict === "model-mismatch";
  card.append(
    el("div", { class: `tc-echo${mismatch ? " mismatch" : ""}` },
      el("span", { class: "tce-label", text: t("tst.requested") }),
      el("span", { class: "mono", text: r.modelRequested }),
      el("span", { class: "tce-label", text: t("tst.returned") }),
      el("span", { class: "mono", text: r.modelReturned ?? t("tst.notReported") }),
    ),
  );

  // raw viewer
  const rawBody = el("div", { class: "tc-raw-body", style: { display: "none" } });
  rawBody.append(
    el("div", { class: "tcr-title mono", text: t("tst.rawReqTitle") }),
    tintJson(r.rawRequest),
    el("div", { class: "tcr-title mono", text: t("tst.rawRespTitle") }),
    tintJson(r.rawResponse || t("tst.emptyBody")),
  );
  card.append(
    el("div", {
      class: "tc-raw-head mono",
      text: `▸ ${t("tst.rawHead")}`,
      onClick: (e) => {
        const open = rawBody.style.display !== "none";
        rawBody.style.display = open ? "none" : "";
        (e.currentTarget as HTMLElement).textContent = `${open ? "▸" : "▾"} ${t("tst.rawHead")}`;
      },
    }),
    rawBody,
  );
  return card;
}

// ---------------------------------------------------------------- tester dialog

let dialogClose: (() => void) | null = null;

export interface TesterPrefill {
  profileId?: string;
  baseUrl?: string;
  protocol?: TesterProtocol;
  model?: string;
  models?: string[];
}

export function openApiTester(prefill?: TesterPrefill): void {
  dialogClose?.();
  const overlay = el("div", { class: "overlay centered" });
  const close = () => {
    if (dialogClose === close) dialogClose = null;
    unsub();
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
  };
  dialogClose = close;

  // ---- form
  const urlInput = el("input", { class: "input mono", placeholder: t("tst.baseUrlPh"), value: prefill?.baseUrl ?? "" }) as HTMLInputElement;
  const keyInput = el("input", { class: "input mono", placeholder: prefill?.profileId ? t("tst.keyFromProfilePh") : t("tst.keyPh") }) as HTMLInputElement;
  keyInput.type = "password";
  if (prefill?.profileId) keyInput.disabled = true;

  const protoWrap = el("div", { class: "tf-protos" });
  let protocol: TesterProtocol = prefill?.protocol ?? "openai-chat";
  const protoBtns = new Map<TesterProtocol, HTMLElement>();
  for (const p of TESTER_PROTOCOLS) {
    const b = el("button", {
      class: `tf-proto${p === protocol ? " on" : ""}`,
      text: PROTOCOL_LABELS[p],
      onClick: () => {
        protocol = p;
        for (const [id, btn] of protoBtns) btn.classList.toggle("on", id === p);
        renderHints();
      },
    });
    protoBtns.set(p, b);
    protoWrap.append(b);
  }

  const modelInput = el("input", { class: "input mono", placeholder: t("tst.modelPh"), value: prefill?.model ?? "" }) as HTMLInputElement;
  const hintsEl = el("div", { class: "tf-hints" });
  const renderHints = () => {
    clear(hintsEl);
    const pool = prefill?.models?.length ? prefill.models : hintsCache?.[protocol] ?? [];
    for (const id of pool.slice(0, 6)) {
      hintsEl.append(el("button", { class: "tf-hint mono", text: id, onClick: () => { modelInput.value = id; } }));
    }
  };
  void window.ide.tester.modelHints().then((h) => {
    hintsCache = h;
    renderHints();
  });
  renderHints();

  let streaming = false;
  const streamSw = el("div", {
    class: "switch",
    title: t("tst.streamTip"),
    onClick: () => {
      streaming = !streaming;
      streamSw.classList.toggle("on", streaming);
    },
  });

  const runBtn = el("button", { class: "btn btn-primary", text: t("tst.run") }) as HTMLButtonElement;
  const saveBtn = el("button", { class: "btn", text: t("tst.saveAsProfile"), style: { display: "none" } }) as HTMLButtonElement;

  // ---- results region
  const resultHost = el("div", { class: "tf-result" });
  const historyStrip = el("div", { class: "tf-history" });

  const renderEmpty = () => {
    clear(resultHost);
    resultHost.append(
      el("div", { class: "tf-empty" },
        el("div", { class: "tfe-glyphs mono", text: "⚡ ▲ ◎ ✦" }),
        el("p", { text: t("tst.emptyIntro") }),
        el("p", { class: "tfe-privacy", text: t("tst.emptyPrivacy") }),
      ),
    );
  };

  const renderHistory = () => {
    clear(historyStrip);
    if (!history.length) return;
    historyStrip.append(el("span", { class: "tfh-label", text: t("tst.history") }));
    for (const r of history) {
      const at = new Date(r.at);
      const hh = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      historyStrip.append(
        el("button", {
          class: `tfh-item mono ${verdictClass(r.verdict)}`,
          title: `${r.target.baseUrl} · ${r.target.model}`,
          text: `${hh} ${r.target.profileId ?? r.target.model.slice(0, 14)} ${verdictLabel(r.verdict)}${r.ttfbMs !== null ? ` ${t("tst.msValue", r.ttfbMs)}` : ""}`,
          onClick: () => {
            clear(resultHost);
            resultHost.append(renderVerdictCard(r));
          },
        }),
      );
    }
  };

  let lastOk: TesterResult | null = null;
  let lastKey = "";

  const showResult = (r: TesterResult) => {
    clear(resultHost);
    resultHost.append(renderVerdictCard(r));
    renderHistory();
    if (!r.target.profileId && r.verdict === "ok") {
      lastOk = r;
      saveBtn.style.display = "";
    }
  };

  const run = () => {
    const baseUrl = urlInput.value.trim();
    const model = modelInput.value.trim();
    if (!baseUrl || !model) {
      toast(t("tst.needUrlModel"), { crit: true });
      return;
    }
    const target: TesterTarget = {
      profileId: prefill?.profileId ?? null,
      baseUrl,
      ...(prefill?.profileId ? {} : { apiKey: keyInput.value }),
      protocol,
      model,
      streaming,
    };
    lastKey = keyInput.value;
    runBtn.disabled = true;
    runBtn.textContent = t("tst.testing");
    runBtn.classList.add("in-flight");
    clear(resultHost);
    resultHost.append(el("div", { class: "tf-flight" }, el("span", { class: "orb thinking" }), el("span", { class: "dim", text: ` ${t("tst.probing", baseUrl)}` })));
    void window.ide.tester.run(target).then((r) => {
      runBtn.disabled = false;
      runBtn.textContent = t("tst.run");
      runBtn.classList.remove("in-flight");
      showResult(r);
    });
  };
  runBtn.addEventListener("click", run);

  saveBtn.addEventListener("click", () => {
    if (!lastOk) return;
    // name suggestion from the URL host; IP hosts get a generic stem
    let suggested = "gateway";
    try {
      const h = new URL(lastOk.target.baseUrl).hostname;
      suggested = /^[\d.]+$/.test(h) ? "gateway" : h.replace(/^api\./, "").split(".")[0];
    } catch { /* keep default */ }
    suggested = suggested.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "") || "gateway";
    void inputDialog({
      title: t("tst.saveAsProfile"),
      message: t("tst.saveMsg", lastOk.target.baseUrl),
      value: suggested,
      confirmLabel: t("tst.saveProfileBtn"),
    }).then((name) => {
      if (!name) return;
      runBtn.disabled = true;
      void window.ide.models
        .addProvider({ template: "custom", name, apiKey: lastKey, baseUrl: lastOk!.target.baseUrl })
        .then((res) => {
          runBtn.disabled = false;
          if (res.ok) {
            toast(t("tst.profileSaved", res.provider.id));
            saveBtn.style.display = "none";
          } else {
            toast(t("tst.saveFailed", res.error), { crit: true });
          }
        });
    });
  });

  // results from anywhere (Deep test, Test all) land in this dialog's history too
  const unsub = window.ide.tester.onResult((r) => {
    history.unshift(r);
    if (history.length > MAX_HISTORY) history.pop();
    renderHistory();
  });

  const linkOut = el("div", { class: "tf-links" });
  const mkLink = (text: string, url: string) =>
    el("a", { class: "tf-link", text, onClick: () => window.ide.win.openExternal(url) });
  linkOut.append(
    mkLink(t("tst.linkCompare"), "https://www.hvoy.ai/en/"),
    el("span", { class: "dim", text: " · " }),
    mkLink(t("tst.linkMethod"), "https://www.hvoy.ai/en/api-key-tester/"),
  );

  const dialog = el(
    "div",
    { class: "dialog tester-dialog" },
    el("h2", { text: prefill?.profileId ? t("tst.deepTestTitle", prefill.profileId) : t("tst.title") }),
    el("div", { class: "tf-form" },
      el("div", { class: "ab-row" }, urlInput),
      prefill?.profileId ? null : el("div", { class: "ab-row" }, keyInput),
      protoWrap,
      el("div", { class: "ab-row tf-model-row" }, modelInput, el("span", { class: "tf-stream" }, el("span", { class: "tfs-label", text: t("tst.streaming") }), streamSw), runBtn),
      hintsEl,
    ),
    resultHost,
    historyStrip,
    el("div", { class: "dialog-actions" },
      linkOut,
      el("span", { style: { flex: "1" } }),
      saveBtn,
      el("button", { class: "btn", text: t("tst.close"), onClick: close }),
    ),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.append(overlay);
  renderEmpty();
  renderHistory();
  requestAnimationFrame(() => overlay.classList.add("visible"));
  modelInput.focus();
}

// ---------------------------------------------------------------- deep test entry points

const PROTOCOL_BY_TEMPLATE: Record<string, TesterProtocol> = {
  anthropic: "anthropic",
  google: "gemini",
};

export function deepTestProfile(p: ProviderInfo): void {
  const starred = [...p.models].sort((a, b) => Number(b.favorite) - Number(a.favorite));
  openApiTester({
    profileId: p.id,
    baseUrl: p.baseUrl,
    protocol: PROTOCOL_BY_TEMPLATE[p.template] ?? "openai-chat",
    model: starred[0]?.id ?? "",
    models: starred.map((m) => m.id),
  });
}

/** "Test all" — verdicts stream back into the host via renderRow as they land */
export function runTestAll(host: HTMLElement): void {
  clear(host);
  host.style.display = "";
  const rows = new Map<string, HTMLElement>();
  const counts: Record<string, number> = {};
  const summary = el("div", { class: "ta-summary mono", text: t("tst.testingAll") });
  host.append(summary);
  const unsub = window.ide.tester.onResult((r) => {
    if (!r.target.profileId) return;
    const key = r.target.profileId;
    let row = rows.get(key);
    if (!row) {
      row = el("div", { class: "ta-row" });
      rows.set(key, row);
      host.append(row);
    }
    clear(row);
    row.append(
      el("span", { class: "ta-name mono", text: key }),
      el("span", { class: `tc-verdict mono sm ${verdictClass(r.verdict)}`, text: verdictLabel(r.verdict) }),
      el("span", { class: "mono dim", text: r.ttfbMs !== null ? t("tst.msValue", r.ttfbMs) : "—" }),
      el("span", { class: "ta-model dim", text: r.target.model }),
    );
    row.classList.add("materialize");
    const short = r.verdict === "ok" ? t("tst.verdictOk") : r.verdict === "auth" ? t("tst.shortAuth") : r.verdict === "model-mismatch" ? t("tst.shortMismatch") : verdictLabel(r.verdict);
    counts[short] = (counts[short] ?? 0) + 1;
    summary.textContent = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(" · ");
  });
  void window.ide.tester.runAll().then(() => {
    unsub();
    if (!rows.size) {
      summary.textContent = t("tst.noProfiles");
    }
  });
}
