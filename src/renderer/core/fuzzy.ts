/** Fuzzy matcher used by the file opener and command palette. */

export interface FuzzyResult {
  score: number;
  /** character indices in the target that matched */
  indices: number[];
}

/**
 * Subsequence match with scoring: consecutive runs, word-boundary and
 * basename hits score higher; gaps penalize.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length > t.length) return null;

  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let lastMatch = -2;

  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    // Prefer a boundary match within a short lookahead window.
    for (let j = ti; j < t.length; j++) {
      if (t[j] !== c) continue;
      found = j;
      const prev = j > 0 ? t[j - 1] : "";
      if (j === 0 || prev === "/" || prev === "\\" || prev === "_" || prev === "-" || prev === "." || prev === " ") {
        break; // boundary hit — take it
      }
      if (j === lastMatch + 1) break; // consecutive — take it
      // otherwise keep scanning a bit for a better position
      let better = -1;
      for (let k = j + 1; k < Math.min(t.length, j + 24); k++) {
        if (t[k] !== c) continue;
        const kprev = t[k - 1];
        if (kprev === "/" || kprev === "\\" || kprev === "_" || kprev === "-" || kprev === "." || kprev === " " || k === lastMatch + 1) {
          better = k;
          break;
        }
      }
      if (better >= 0) found = better;
      break;
    }
    if (found < 0) return null;

    indices.push(found);
    if (found === lastMatch + 1) score += 8; // consecutive
    const prev = found > 0 ? t[found - 1] : "";
    if (found === 0 || prev === "/" || prev === "\\") score += 10;
    else if (prev === "_" || prev === "-" || prev === "." || prev === " ") score += 7;
    else score += 1;
    score -= Math.min(found - (lastMatch + 1), 12) * 0.35; // gap penalty
    lastMatch = found;
    ti = found + 1;
  }

  // Matches close to the basename score higher.
  const lastSep = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  const inBasename = indices.filter((i) => i > lastSep).length;
  score += inBasename * 2.5;
  score -= (t.length - q.length) * 0.02; // shorter targets win ties
  return { score, indices };
}

/**
 * Whitespace-separated tokens AND-matched against the target ("ranis fable"
 * → both "ranis" and "fable" must fuzzy-match). Scores and indices merge.
 */
export function fuzzyMatchMulti(query: string, target: string): FuzzyResult | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return fuzzyMatch(query.trim(), target);
  let score = 0;
  const indices = new Set<number>();
  for (const tok of tokens) {
    const r = fuzzyMatch(tok, target);
    if (!r) return null;
    score += r.score;
    for (const i of r.indices) indices.add(i);
  }
  return { score, indices: [...indices].sort((a, b) => a - b) };
}

/** Render a target with matched chars wrapped in a span. */
export function highlight(target: string, indices: number[], cls: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const idxSet = new Set(indices);
  let run = "";
  let runMatched: boolean | null = null;
  const flush = () => {
    if (!run) return;
    if (runMatched) {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = run;
      frag.append(s);
    } else {
      frag.append(run);
    }
    run = "";
  };
  for (let i = 0; i < target.length; i++) {
    const matched = idxSet.has(i);
    if (matched !== runMatched) {
      flush();
      runMatched = matched;
    }
    run += target[i];
  }
  flush();
  return frag;
}
