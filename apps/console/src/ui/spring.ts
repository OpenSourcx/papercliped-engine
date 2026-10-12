import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A small spring engine for shape changes (Pin's island). Physical springs are interruptible by nature: retargeting
 * mid-flight keeps the current velocity, so a shape that changes its mind never jumps. Values are written straight to
 * element.style (CSSOM), which the strict CSP (style-src 'self') allows. Parameters come from the motion tokens in
 * index.css (--spring-<name>-stiffness, -damping, -mass), so motion is tuned in one place.
 *
 * We measured Motion (motion.dev) for this job: its layout features add 34 to 49 kB gzipped to this bundle. The island
 * is the console's only shape morph, so this file does the same work in about 1 kB.
 */

export interface SpringParams {
  stiffness: number;
  damping: number;
  mass: number;
}

const FALLBACK: Record<string, SpringParams> = {
  island: { stiffness: 400, damping: 34, mass: 1 },
  gentle: { stiffness: 260, damping: 30, mass: 1 },
};

/** Reads a spring from the motion tokens, falling back to the documented defaults outside a browser. */
export function readSpring(name: "island" | "gentle"): SpringParams {
  const base = FALLBACK[name];
  if (typeof document === "undefined") return base;
  const css = getComputedStyle(document.documentElement);
  const num = (k: keyof SpringParams) => {
    const v = parseFloat(css.getPropertyValue(`--spring-${name}-${k}`));
    return Number.isFinite(v) && v > 0 ? v : base[k];
  };
  return { stiffness: num("stiffness"), damping: num("damping"), mass: num("mass") };
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

type Values = Record<string, number>;

/** One step of a damped spring (semi-implicit Euler), exported for tests. */
export function stepSpring(x: number, v: number, target: number, p: SpringParams, dt: number): [number, number] {
  const a = (-p.stiffness * (x - target) - p.damping * v) / p.mass;
  const nv = v + a * dt;
  return [x + nv * dt, nv];
}

/** Drives a set of numbers toward targets together, calling onFrame with the current values each frame. */
export class SpringSet {
  private x: Values;
  private v: Values = {};
  private target: Values;
  private raf = 0;
  private last = 0;
  private readonly onFrame: (v: Values) => void;
  params: SpringParams;

  constructor(initial: Values, onFrame: (v: Values) => void, params: SpringParams) {
    this.x = { ...initial };
    this.target = { ...initial };
    for (const k of Object.keys(initial)) this.v[k] = 0;
    this.onFrame = onFrame;
    this.params = params;
  }

  get values(): Values {
    return { ...this.x };
  }

  /** Moves toward new targets. `immediate` jumps (first paint, reduced motion). */
  set(target: Values, immediate = false) {
    this.target = { ...this.target, ...target };
    for (const k of Object.keys(target)) if (!(k in this.x)) { this.x[k] = target[k]; this.v[k] = 0; }
    if (immediate) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      for (const k of Object.keys(this.target)) { this.x[k] = this.target[k]; this.v[k] = 0; }
      this.onFrame(this.values);
      return;
    }
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number) => {
    // Cap the frame time so a backgrounded tab doesn't explode the integration; sub-step for stability.
    let dt = Math.min(0.064, (now - this.last) / 1000);
    this.last = now;
    const h = 1 / 240;
    let resting = true;
    while (dt > 0) {
      const s = Math.min(h, dt);
      for (const k of Object.keys(this.target)) [this.x[k], this.v[k]] = stepSpring(this.x[k], this.v[k], this.target[k], this.params, s);
      dt -= s;
    }
    for (const k of Object.keys(this.target)) {
      if (Math.abs(this.x[k] - this.target[k]) > 0.25 || Math.abs(this.v[k]) > 2) resting = false;
    }
    if (resting) for (const k of Object.keys(this.target)) { this.x[k] = this.target[k]; this.v[k] = 0; }
    this.onFrame(this.values);
    this.raf = resting ? 0 : requestAnimationFrame(this.tick);
  };

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

/**
 * Springs an element's width, height and corner radius (in px) toward a target box. The first box is applied without
 * animation; with reduced motion every change applies at once (the content still cross-fades).
 */
export function useSpringBox(ref: RefObject<HTMLElement | null>, box: { width: number; height: number; radius: number }, spring: "island" | "gentle" = "island") {
  const set = useRef<SpringSet | null>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!set.current) {
      set.current = new SpringSet(box, (v) => {
        el.style.width = `${v.width}px`;
        el.style.height = `${v.height}px`;
        el.style.borderRadius = `${Math.max(0, v.radius)}px`;
      }, readSpring(spring));
    }
    set.current.set(box, first.current || prefersReducedMotion());
    first.current = false;
  }, [ref, box.width, box.height, box.radius, spring]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => set.current?.stop(), []);
}
