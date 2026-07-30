/** Inline SVG path data — 16x16 grid, stroke-based, one visual language. */

export const I = {
  // chrome
  minimize: `<line x1="3" y1="8" x2="13" y2="8"/>`,
  maximize: `<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>`,
  restore: `<rect x="3" y="5" width="8" height="8" rx="1"/><path d="M5.5 5V3.8A.8.8 0 0 1 6.3 3H12a1 1 0 0 1 1 1v5.7a.8.8 0 0 1-.8.8H12"/>`,
  close: `<line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>`,
  // activity bar
  files: `<path d="M9.5 2H4.8a.8.8 0 0 0-.8.8v10.4c0 .44.36.8.8.8h6.4a.8.8 0 0 0 .8-.8V4.5L9.5 2z"/><path d="M9.5 2v2.5H12"/>`,
  search: `<circle cx="7" cy="7" r="4.2"/><line x1="10.2" y1="10.2" x2="13.5" y2="13.5"/>`,
  git: `<circle cx="5" cy="4" r="1.8"/><circle cx="5" cy="12" r="1.8"/><circle cx="11" cy="8" r="1.8"/><path d="M5 5.8v4.4M9.2 8H6.8"/>`,
  agent: `<circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.6"/><path d="M8 2.8v1.6M8 11.6v1.6M2.8 8h1.6M11.6 8h1.6"/>`,
  settings: `<circle cx="8" cy="8" r="2"/><path d="M8 1.8v2M8 12.2v2M2.6 4.9l1.7 1M11.7 10.1l1.7 1M2.6 11.1l1.7-1M11.7 5.9l1.7-1"/>`,
  // tree / files
  chevron: `<path d="M6 4l4 4-4 4"/>`,
  folder: `<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7z"/>`,
  folderOpen: `<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h4.8A1.2 1.2 0 0 1 13.5 6H4.4L2.6 12.7A1.5 1.5 0 0 1 2 11.5v-7z"/><path d="M4.4 6h9.8l-1.7 6.2a1.2 1.2 0 0 1-1.2.8H2.8"/>`,
  file: `<path d="M9.5 2H4.8a.8.8 0 0 0-.8.8v10.4c0 .44.36.8.8.8h6.4a.8.8 0 0 0 .8-.8V4.5L9.5 2z"/><path d="M9.5 2v2.5H12"/>`,
  fileCode: `<path d="M9.5 2H4.8a.8.8 0 0 0-.8.8v10.4c0 .44.36.8.8.8h6.4a.8.8 0 0 0 .8-.8V4.5L9.5 2z"/><path d="M6.5 8l-1.3 1.5L6.5 11M9.5 8l1.3 1.5L9.5 11"/>`,
  fileImage: `<rect x="3" y="3" width="10" height="10" rx="1.2"/><circle cx="6" cy="6.2" r="1"/><path d="M3.5 11.5l3-3 2 2 2-2 2.5 2.5"/>`,
  newFile: `<path d="M9.5 2H4.8a.8.8 0 0 0-.8.8v10.4c0 .44.36.8.8.8h6.4a.8.8 0 0 0 .8-.8V4.5L9.5 2z"/><path d="M8 7v4M6 9h4"/>`,
  newFolder: `<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7z"/><path d="M8 7.5v3.4M6.3 9.2h3.4"/>`,
  refresh: `<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5V5h-2.5"/>`,
  collapse: `<path d="M5 5.5L8 3l3 2.5M5 10.5L8 13l3-2.5"/>`,
  trash: `<path d="M3 4.5h10M6.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M5 4.5l.6 8.1a1 1 0 0 0 1 .9h2.8a1 1 0 0 0 1-.9l.6-8.1"/>`,
  edit: `<path d="M11.3 2.7l2 2L6 12l-2.7.7L4 10l7.3-7.3z"/>`,
  // terminal
  terminal: `<rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="M5 6.5L7.5 9 5 11.5M8.5 11.5H11"/>`,
  plus: `<path d="M8 3.5v9M3.5 8h9"/>`,
  kill: `<circle cx="8" cy="8" r="5.5"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/>`,
  restart2: `<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5V5h-2.5"/>`,
  history: `<circle cx="8.5" cy="8" r="5"/><path d="M8.5 5.2V8l2 1.5"/><path d="M3.5 8H1.8M3 5.2l1.2.8"/>`,
  chevronDown: `<path d="M4 6l4 4 4-4"/>`,
  panelToggle: `<rect x="2" y="3" width="12" height="10" rx="1.2"/><line x1="2" y1="10" x2="14" y2="10"/>`,
  // git
  check: `<path d="M3.5 8.5L6.5 11.5 12.5 4.5"/>`,
  undo: `<path d="M3 6h6a4 4 0 0 1 0 8H6"/><path d="M5.5 3.5L3 6l2.5 2.5"/>`,
  branch: `<circle cx="5" cy="4" r="1.8"/><circle cx="5" cy="12" r="1.8"/><circle cx="11" cy="8" r="1.8"/><path d="M5 5.8v4.4M9.2 8H6.8"/>`,
  diff: `<path d="M5 2.5v6M2.5 5.5h5"/><path d="M2.5 11.5h5"/><path d="M11 4.5v9"/><path d="M8.8 11.2L11 13.5l2.2-2.3"/>`,
  stage: `<path d="M8 3.5v9M3.5 8h9"/>`,
  unstage: `<path d="M3.5 8h9"/>`,
  // agent / tools
  send: `<path d="M2.5 8L13.5 2.5 11 13.5 7.5 9.5 2.5 8z"/><path d="M7.5 9.5L13.5 2.5"/>`,
  stop: `<rect x="4.5" y="4.5" width="7" height="7" rx="1"/>`,
  sparkle: `<path d="M8 2l1.2 3.4L12.5 6.5 9.2 7.7 8 11 6.8 7.7 3.5 6.5 6.8 5.4 8 2z"/><path d="M12.5 10.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z"/>`,
  toolRead: `<path d="M8 3.5C5 3.5 2.8 5.5 2 8c.8 2.5 3 4.5 6 4.5S13.2 10.5 14 8c-.8-2.5-3-4.5-6-4.5z"/><circle cx="8" cy="8" r="1.8"/>`,
  toolEdit: `<path d="M11.3 2.7l2 2L6 12l-2.7.7L4 10l7.3-7.3z"/>`,
  toolWrite: `<path d="M9.5 2H4.8a.8.8 0 0 0-.8.8v10.4c0 .44.36.8.8.8h6.4a.8.8 0 0 0 .8-.8V4.5L9.5 2z"/><path d="M6 9h4M6 11h2.5"/>`,
  toolBash: `<rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="M5 6.5L7.5 9 5 11.5"/>`,
  toolSearch: `<circle cx="7" cy="7" r="4.2"/><line x1="10.2" y1="10.2" x2="13.5" y2="13.5"/>`,
  toolTask: `<circle cx="4.5" cy="4.5" r="2"/><circle cx="11.5" cy="4.5" r="2"/><circle cx="8" cy="11.5" r="2"/><path d="M5.8 6l1.4 3.6M10.2 6L8.8 9.6"/>`,
  toolTodo: `<rect x="3" y="2.5" width="10" height="11" rx="1.2"/><path d="M5.5 6l1 1 2-2M5.5 10l1 1 2-2"/>`,
  toolGeneric: `<path d="M9.8 2.8a3.5 3.5 0 0 0-4.6 4.6L2 10.6V14h3.4l3.2-3.2a3.5 3.5 0 0 0 4.6-4.6L11 8.4 7.6 5l2.2-2.2z"/>`,
  bell: `<path d="M8 2.5a3.8 3.8 0 0 1 3.8 3.8c0 3 .9 4 1.7 4.7H2.5c.8-.7 1.7-1.7 1.7-4.7A3.8 3.8 0 0 1 8 2.5z"/><path d="M6.8 13a1.3 1.3 0 0 0 2.4 0"/>`,
  save: `<path d="M3 3.8A.8.8 0 0 1 3.8 3h7L13 5.2v7a.8.8 0 0 1-.8.8H3.8a.8.8 0 0 1-.8-.8V3.8z"/><path d="M5 3v3h5V3M5 13V9.5h6V13"/>`,
  splitH: `<rect x="2" y="3" width="12" height="10" rx="1.2"/><line x1="8" y1="3" x2="8" y2="13"/>`,
  zap: `<path d="M8.8 2L3.5 9h3.4L7.2 14l5.3-7H9.1L8.8 2z"/>`,
  outline: `<line x1="6" y1="4" x2="13" y2="4"/><line x1="8" y1="8" x2="13" y2="8"/><line x1="10" y1="12" x2="13" y2="12"/><circle cx="3.5" cy="4" r="1"/><circle cx="5.5" cy="8" r="1"/><circle cx="7.5" cy="12" r="1"/>`,
} as const;

const TOOL_ICON: Record<string, string> = {
  read: I.toolRead,
  edit: I.toolEdit,
  write: I.toolWrite,
  bash: I.toolBash,
  grep: I.toolSearch,
  glob: I.toolSearch,
  web_search: I.toolSearch,
  task: I.toolTask,
  todo: I.toolTodo,
  hub: I.toolTask,
  eval: I.toolBash,
  ask: I.sparkle,
};

export function toolIcon(name: string): string {
  return TOOL_ICON[name] ?? I.toolGeneric;
}
