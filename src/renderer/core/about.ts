/**
 * App/author identity — the ONE source for every credit surface (welcome
 * footer, settings About block). A handle change is a one-line edit here.
 */

import { version } from "../../../package.json";

export const APP_VERSION: string = version;

export const ABOUT = {
  author: "Ranis",
  telegram: { handle: "@Ranis5467", url: "https://t.me/Ranis5467" },
  github: { handle: "Ran1sss", url: "https://github.com/Ran1sss" },
} as const;

/** 12–14 px inline glyphs (currentColor) — the icon set has no brand marks */
export const TELEGRAM_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M14.7 1.8L1.6 6.9c-.9.35-.88 1.62.03 1.93l3.3 1.13 1.27 3.9c.28.85 1.36 1.02 1.87.3l1.84-2.62 3.36 2.47c.7.5 1.68.13 1.86-.72l2-9.4c.2-.95-.72-1.74-1.63-1.39zM5.6 9.4l7.06-4.5c.3-.2.62.2.36.45L7.6 10.2l-.22 2.35L5.6 9.4z" transform="scale(0.85) translate(1.2 1.2)"/></svg>';

export const GITHUB_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 .8a7.2 7.2 0 0 0-2.28 14.03c.36.07.5-.15.5-.34v-1.34c-2 .43-2.43-.85-2.43-.85-.33-.83-.8-1.05-.8-1.05-.66-.45.05-.44.05-.44.72.05 1.1.74 1.1.74.65 1.1 1.7.8 2.1.6.07-.46.26-.79.46-.97-1.6-.18-3.28-.8-3.28-3.56 0-.79.28-1.43.74-1.94-.07-.18-.32-.91.07-1.9 0 0 .6-.2 1.98.74a6.9 6.9 0 0 1 3.6 0c1.37-.93 1.97-.74 1.97-.74.4.99.15 1.72.07 1.9.46.5.74 1.15.74 1.94 0 2.77-1.69 3.38-3.3 3.55.26.23.5.67.5 1.35v2c0 .2.13.42.5.34A7.2 7.2 0 0 0 8 .8z"/></svg>';
