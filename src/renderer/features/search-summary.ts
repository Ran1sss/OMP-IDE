export interface SearchSummaryState {
  matches: number;
  files: number;
  done: boolean;
  hitLimit: boolean;
  error?: string;
}

export interface SearchSummaryCopy {
  noResults: string;
  searching: string;
  summary: (matches: number, files: number) => string;
  truncated: (matches: number, files: number) => string;
}

export function formatSearchSummary(
  state: SearchSummaryState,
  copy: SearchSummaryCopy,
): { text: string; warning: boolean } {
  if (state.error) return { text: state.error, warning: true };
  if (state.matches === 0) {
    return {
      text: state.done ? copy.noResults : copy.searching,
      warning: false,
    };
  }
  if (state.done && state.hitLimit) {
    return {
      text: copy.truncated(state.matches, state.files),
      warning: true,
    };
  }
  const summary = copy.summary(state.matches, state.files);
  return {
    text: state.done ? summary : `${summary}…`,
    warning: false,
  };
}
