/**
 * Motion system root switch (Motion Upgrade A+D).
 *
 * One place computes the effective motion mode and reflects it as classes on
 * <body>; all motion CSS keys off these classes — zero per-component
 * conditionals:
 *
 *   .motion-full     both layers (Kinetic Reactor events + Aurora ambient)
 *   .motion-events   event layer only; ambient rules are gated out entirely
 *   .motion-minimal  no movement anywhere: transition/animation durations
 *                    collapse to snaps ≤80ms (see base.css override block)
 *   .ambient-paused  rides WITH .motion-full when the window loses focus or
 *                    the machine is on battery — ambient animations get
 *                    animation-play-state: paused (spec §2 pause discipline)
 *
 * Setting semantics (spec §3): the stored setting is the user's choice;
 * prefers-reduced-motion demotes effective "full" to "events".
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

let userMotion: "full" | "events" | "minimal" = "full";
let onBattery = false;

function effective(): "full" | "events" | "minimal" {
  if (userMotion === "full" && reduced.matches) return "events";
  return userMotion;
}

let userReduceGlass = false;

function reflect(): void {
  const mode = effective();
  const b = document.body.classList;
  b.toggle("motion-full", mode === "full");
  b.toggle("motion-events", mode === "events");
  b.toggle("motion-minimal", mode === "minimal");
  // pause discipline only matters while ambient is running at all
  b.toggle("ambient-paused", mode === "full" && (!document.hasFocus() || onBattery));
  // nebula glass fallback: user toggle OR auto-on under minimal motion (spec §3)
  b.toggle("reduce-transparency", userReduceGlass || mode === "minimal");
}

/** Apply the stored settings (startup + every settings save). */
export function applyMotion(setting: "full" | "events" | "minimal", reduceTransparency = userReduceGlass): void {
  userMotion = setting;
  userReduceGlass = reduceTransparency;
  reflect();
}

/** Wire the pause-discipline listeners once at startup. */
export function initMotion(): void {
  reflect();
  window.addEventListener("focus", reflect);
  window.addEventListener("blur", reflect);
  reduced.addEventListener("change", reflect);
  void window.ide.win.isOnBattery().then((on) => {
    onBattery = on;
    reflect();
  });
  window.ide.win.onBattery((on) => {
    onBattery = on;
    reflect();
  });
}
