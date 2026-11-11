import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/storage.ts";

/**
 * PinField: a quiet canvas of pin and pushpin sprites that drift, tilt and fade, with small worker sprites crossing
 * while `working` is true (design system, "Pin animation"). Our own shapes and code.
 *
 * It is decoration. It carries no text and no status: callers pass `working` only when a real run is in progress, and
 * the real status components say what is happening. It stays out of the way:
 *   - hidden at 375 px and narrower (nothing is rendered, no layout space is taken);
 *   - a single static frame under prefers-reduced-motion;
 *   - paused while the tab or the element is off screen, capped at 24 fps;
 *   - no allocation per frame: sprites live in preallocated typed arrays and the canvas is sized to its box.
 */
export const PIN_FIELD_FPS = 24;
export const PIN_FIELD_HIDE_AT = 375;
const PINS = 20;
const WORKERS = 3;
const SLOTS = PINS + WORKERS;
const FRAME_MS = 1000 / PIN_FIELD_FPS;

/** Per-sprite state, one typed array per field (x, y in 0..1 of the box; r, a in radians; size in px). */
export interface Field {
  x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array;
  rot: Float32Array; spin: Float32Array; phase: Float32Array; size: Float32Array; kind: Uint8Array;
}
/** kind 0 = pin, 1 = pushpin, 2 = worker. */
export const makeField = (seed = 7): Field => {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const f: Field = { x: new Float32Array(SLOTS), y: new Float32Array(SLOTS), vx: new Float32Array(SLOTS), vy: new Float32Array(SLOTS), rot: new Float32Array(SLOTS), spin: new Float32Array(SLOTS), phase: new Float32Array(SLOTS), size: new Float32Array(SLOTS), kind: new Uint8Array(SLOTS) };
  for (let i = 0; i < SLOTS; i++) {
    const worker = i >= PINS;
    f.kind[i] = worker ? 2 : i % 3 === 0 ? 1 : 0;
    f.x[i] = worker ? -0.1 - rnd() * 0.6 : rnd();
    f.y[i] = worker ? 0.2 + rnd() * 0.6 : rnd();
    f.vx[i] = worker ? 0.006 + rnd() * 0.004 : (rnd() - 0.5) * 0.0035;
    f.vy[i] = worker ? 0 : (rnd() - 0.5) * 0.0035;
    f.rot[i] = worker ? 0 : rnd() * Math.PI * 2;
    f.spin[i] = worker ? 0 : (rnd() - 0.5) * 0.02;
    f.phase[i] = rnd() * Math.PI * 2;
    f.size[i] = worker ? 9 : 7 + rnd() * 10;
  }
  return f;
};

/** Advances every sprite one tick. Workers only move while `working`; they cross left to right and re-enter. */
export const stepField = (f: Field, working: boolean) => {
  for (let i = 0; i < SLOTS; i++) {
    if (f.kind[i] === 2) {
      if (!working) continue;
      f.x[i] += f.vx[i];
      if (f.x[i] > 1.1) f.x[i] = -0.1;
      continue;
    }
    f.x[i] += f.vx[i]; f.y[i] += f.vy[i]; f.rot[i] += f.spin[i]; f.phase[i] += 0.03;
    if (f.x[i] < -0.05) f.x[i] = 1.05; else if (f.x[i] > 1.05) f.x[i] = -0.05;
    if (f.y[i] < -0.05) f.y[i] = 1.05; else if (f.y[i] > 1.05) f.y[i] = -0.05;
  }
};

const drawSprite = (ctx: CanvasRenderingContext2D, k: number, s: number) => {
  ctx.beginPath();
  if (k === 0) {
    // a pin: round head, needle
    ctx.arc(0, -s * 0.6, s * 0.28, 0, Math.PI * 2);
    ctx.moveTo(0, -s * 0.32); ctx.lineTo(0, s * 0.7);
  } else if (k === 1) {
    // a pushpin: flat cap, wide body, short point
    ctx.moveTo(-s * 0.45, -s * 0.7); ctx.lineTo(s * 0.45, -s * 0.7);
    ctx.moveTo(-s * 0.3, -s * 0.7); ctx.lineTo(-s * 0.3, -s * 0.15); ctx.lineTo(s * 0.3, -s * 0.15); ctx.lineTo(s * 0.3, -s * 0.7);
    ctx.moveTo(0, -s * 0.15); ctx.lineTo(0, s * 0.65);
  } else {
    // a worker: a small walking figure with a pin head
    ctx.arc(0, -s * 0.7, s * 0.2, 0, Math.PI * 2);
    ctx.moveTo(0, -s * 0.5); ctx.lineTo(0, s * 0.1);
    ctx.moveTo(-s * 0.35, -s * 0.3); ctx.lineTo(s * 0.35, -s * 0.3);
    ctx.moveTo(0, s * 0.1); ctx.lineTo(-s * 0.25, s * 0.65);
    ctx.moveTo(0, s * 0.1); ctx.lineTo(s * 0.25, s * 0.65);
  }
  ctx.stroke();
};

const useNarrow = () => {
  const query = `(max-width: ${PIN_FIELD_HIDE_AT}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return narrow;
};

export function PinField({ className, working = false }: { className?: string; working?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const workingRef = useRef(working);
  workingRef.current = working;
  const narrow = useNarrow();

  useEffect(() => {
    const canvas = ref.current;
    if (narrow || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const field = makeField();
    let w = 1, h = 1, dpr = 1, raf = 0, last = 0, ticks = 0, ink = "currentColor";
    let onScreen = true, running = false;

    const readInk = () => { ink = getComputedStyle(canvas).color || "currentColor"; };
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (let i = 0; i < SLOTS; i++) {
        const k = field.kind[i];
        if (k === 2 && !workingRef.current) continue;
        // fade: slow sine between nearly gone and clearly visible
        ctx.globalAlpha = k === 2 ? 0.5 : 0.08 + 0.3 * (0.5 + 0.5 * Math.sin(field.phase[i]));
        const c = Math.cos(field.rot[i]), s = Math.sin(field.rot[i]);
        ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * field.x[i] * w, dpr * field.y[i] * h);
        drawSprite(ctx, k, field.size[i]);
      }
      ctx.globalAlpha = 1;
    };
    const size = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth || 1; h = canvas.clientHeight || 1;
      const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      readInk();
      draw();
    };
    const frame = (t: number) => {
      raf = 0;
      if (!running) return;
      if (t - last >= FRAME_MS) {
        last = t;
        stepField(field, workingRef.current);
        if (++ticks % 240 === 0) readInk(); // follows a theme change without a listener
        draw();
      }
      raf = requestAnimationFrame(frame);
    };
    const update = () => {
      const want = !reduced && onScreen && !document.hidden;
      if (want && !running) { running = true; raf = requestAnimationFrame(frame); }
      else if (!want && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    };

    stepField(field, true); // a static frame that already has some composition
    size();
    const io = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((e) => { onScreen = !!e[e.length - 1]?.isIntersecting; update(); });
    io?.observe(canvas);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
    ro?.observe(canvas);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      ro?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [narrow]);

  if (narrow) return null;
  return <canvas ref={ref} aria-hidden="true" data-testid="pin-field" className={cn("pin-field pointer-events-none absolute inset-0 h-full w-full text-ink", className)} />;
}

/** The field as a side panel: right edge, desktop width only (1024 px and up), never taking space from the form. */
export function PinFieldPanel({ working = false }: { working?: boolean }) {
  return (
    <aside aria-hidden="true" data-testid="pin-field-panel" className="hidden lg:block fixed inset-y-0 right-0 w-1/4 border-l border-line overflow-hidden">
      <PinField working={working} className="opacity-80" />
    </aside>
  );
}
