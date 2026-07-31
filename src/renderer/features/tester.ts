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

const VERDICT_LABELS: Record<TesterVerdict, string> = {
  ok: "ok",
  auth: "auth error",
  quota: "quota",
  "rate-limited": "rate-limited",
  "http-error": "http error",
  network: "network",
  "model-mismatch": "model-mismatch",
  unparseable: "unparseable",
};

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
  return ms === null ? "—" : `${ms} ms`;
}

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
  const chip = el("span", { class: `tc-verdict mono ${verdictClass(r.verdict)}`, text: VERDICT_LABELS[r.verdict] });
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
  const lat = el("div", { class: "tc-latency" },
    el("div", { class: "tcl-item" },
      el("span", { class: "tcl-value mono", text: fmtMs(r.ttfbMs) }),
      el("span", { class: "tcl-label" }, "TTFB", r.ttfbMs !== null ? el("span", { class: `tcl-hint h-${ttfbHint(r.ttfbMs)}`, text: ` · ${ttfbHint(r.ttfbMs)}` }) : ""),
    ),
    el("div", { class: "tcl-item" },
      el("span", { class: "tcl-value mono sm", text: fmtMs(r.totalMs) }),
      el("span", { class: "tcl-label", text: "total" }),
    ),
  );
  if (r.firstTokenMs !== null) {
    lat.append(el("div", { class: "tcl-item" },
      el("span", { class: "tcl-value mono sm", text: fmtMs(r.firstTokenMs) }),
      el("span", { class: "tcl-label", text: "first token" }),
    ));
  }
  if (r.chunkCount !== null) {
    lat.append(el("div", { class: "tcl-item" },
      el("span", { class: "tcl-value mono sm", text: String(r.chunkCount) }),
      el("span", { class: "tcl-label", text: "chunks" }),
    ));
  }
  card.append(lat);

  // usage
  const usageRow = el("div", { class: "tc-usage" });
  if (r.usage) {
    usageRow.append(
      el("span", { class: "mono", text: r.usage.input !== null ? String(r.usage.input) : "—" }),
      el("span", { class: "tcu-label", text: "in · " }),
      el("span", { class: "mono", text: r.usage.output !== null ? String(r.usage.output) : "—" }),
      el("span", { class: "tcu-label", text: "out" }),
    );
    if (r.usage.reasoning !== null && r.usage.reasoning > 0) {
      usageRow.append(
        el("span", { class: "tcu-label", text: " · " }),
        el("span", { class: "mono", text: String(r.usage.reasoning) }),
        el("span", { class: "tcu-label", text: "reasoning" }),
      );
    }
  } else {
    usageRow.append(el("span", { class: "tcu-label", text: "token usage not reported" }));
  }
  card.append(usageRow);

  // model echo — the authenticity signal
  const mismatch = r.verdict === "model-mismatch";
  card.append(
    el("div", { class: `tc-echo${mismatch ? " mismatch" : ""}` },
      el("span", { class: "tce-label", text: "requested" }),
      el("span", { class: "mono", text: r.modelRequested }),
      el("span", { class: "tce-label", text: "returned" }),
      el("span", { class: "mono", text: r.modelReturned ?? "(not reported)" }),
    ),
  );

  // raw viewer
  const rawBody = el("div", { class: "tc-raw-body", style: { display: "none" } });
  rawBody.append(
    el("div", { class: "tcr-title mono", text: "── request (key redacted) ──" }),
    tintJson(r.rawRequest),
    el("div", { class: "tcr-title mono", text: "── response (verbatim) ──" }),
    tintJson(r.rawResponse || "(empty body)"),
  );
  card.append(
    el("div", {
      class: "tc-raw-head mono",
      text: "▸ raw request / response",
      onClick: (e) => {
        const open = rawBody.style.display !== "none";
        rawBody.style.display = open ? "none" : "";
        (e.currentTarget as HTMLElement).textContent = `${open ? "▸" : "▾"} raw request / response`;
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
  const urlInput = el("input", { class: "input mono", placeholder: "Base URL (e.g. https://api.example.com/v1)", value: prefill?.baseUrl ?? "" }) as HTMLInputElement;
  const keyInput = el("input", { class: "input mono", placeholder: prefill?.profileId ? "(key from profile)" : "API key (kept in memory only)" }) as HTMLInputElement;
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

  const modelInput = el("input", { class: "input mono", placeholder: "model id", value: prefill?.model ?? "" }) as HTMLInputElement;
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
    title: "Streaming probe: adds time-to-first-token and chunk count",
    onClick: () => {
      streaming = !streaming;
      streamSw.classList.toggle("on", streaming);
    },
  });

  const runBtn = el("button", { class: "btn btn-primary", text: "Run test" }) as HTMLButtonElement;
  const saveBtn = el("button", { class: "btn", text: "Save as profile", style: { display: "none" } }) as HTMLButtonElement;

  // ---- results region
  const resultHost = el("div", { class: "tf-result" });
  const historyStrip = el("div", { class: "tf-history" });

  const renderEmpty = () => {
    clear(resultHost);
    resultHost.append(
      el("div", { class: "tf-empty" },
        el("div", { class: "tfe-glyphs mono", text: "⚡ ▲ ◎ ✦" }),
        el("p", { text: "Test any AI endpoint with a real minimal completion: status, latency, token usage, model echo, raw payloads." }),
        el("p", { class: "tfe-privacy", text: "Keys are sent only to the endpoint being tested — never to hvoy.ai or any third party." }),
      ),
    );
  };

  const renderHistory = () => {
    clear(historyStrip);
    if (!history.length) return;
    historyStrip.append(el("span", { class: "tfh-label", text: "history" }));
    for (const r of history) {
      const t = new Date(r.at);
      const hh = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      historyStrip.append(
        el("button", {
          class: `tfh-item mono ${verdictClass(r.verdict)}`,
          title: `${r.target.baseUrl} · ${r.target.model}`,
          text: `${hh} ${r.target.profileId ?? r.target.model.slice(0, 14)} ${VERDICT_LABELS[r.verdict]}${r.ttfbMs !== null ? ` ${r.ttfbMs}ms` : ""}`,
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
      toast("Base URL and model id are required", { crit: true });
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
    runBtn.textContent = "Testing…";
    runBtn.classList.add("in-flight");
    clear(resultHost);
    resultHost.append(el("div", { class: "tf-flight" }, el("span", { class: "orb thinking" }), el("span", { class: "dim", text: ` probing ${baseUrl}…` })));
    void window.ide.tester.run(target).then((r) => {
      runBtn.disabled = false;
      runBtn.textContent = "Run test";
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
      title: "Save as profile",
      message: `Base URL ${lastOk.target.baseUrl} — the key moves into the OS vault. Profile name (slug):`,
      value: suggested,
      confirmLabel: "Save profile",
    }).then((name) => {
      if (!name) return;
      runBtn.disabled = true;
      void window.ide.models
        .addProvider({ template: "custom", name, apiKey: lastKey, baseUrl: lastOk!.target.baseUrl })
        .then((res) => {
          runBtn.disabled = false;
          if (res.ok) {
            toast(`Profile ${res.provider.id} saved — key stored in the OS vault.`);
            saveBtn.style.display = "none";
          } else {
            toast(`Save failed: ${res.error}`, { crit: true });
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
    mkLink("compare gateways on hvoy.ai", "https://www.hvoy.ai/en/"),
    el("span", { class: "dim", text: " · " }),
    mkLink("methodology: hvoy API key tester", "https://www.hvoy.ai/en/api-key-tester/"),
  );

  const dialog = el(
    "div",
    { class: "dialog tester-dialog" },
    el("h2", { text: prefill?.profileId ? `Deep test — ${prefill.profileId}` : "API Tester" }),
    el("div", { class: "tf-form" },
      el("div", { class: "ab-row" }, urlInput),
      prefill?.profileId ? null : el("div", { class: "ab-row" }, keyInput),
      protoWrap,
      el("div", { class: "ab-row tf-model-row" }, modelInput, el("span", { class: "tf-stream" }, el("span", { class: "tfs-label", text: "streaming" }), streamSw), runBtn),
      hintsEl,
    ),
    resultHost,
    historyStrip,
    el("div", { class: "dialog-actions" },
      linkOut,
      el("span", { style: { flex: "1" } }),
      saveBtn,
      el("button", { class: "btn", text: "Close", onClick: close }),
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
  const summary = el("div", { class: "ta-summary mono", text: "testing…" });
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
      el("span", { class: `tc-verdict mono sm ${verdictClass(r.verdict)}`, text: VERDICT_LABELS[r.verdict] }),
      el("span", { class: "mono dim", text: r.ttfbMs !== null ? `${r.ttfbMs}ms` : "—" }),
      el("span", { class: "ta-model dim", text: r.target.model }),
    );
    row.classList.add("materialize");
    const short = r.verdict === "ok" ? "ok" : r.verdict === "auth" ? "auth" : r.verdict === "model-mismatch" ? "mismatch" : VERDICT_LABELS[r.verdict];
    counts[short] = (counts[short] ?? 0) + 1;
    summary.textContent = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(" · ");
  });
  void window.ide.tester.runAll().then(() => {
    unsub();
    if (!rows.size) {
      summary.textContent = "no enabled profiles with keys";
    }
  });
}
