// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PIN_FIELD_FPS, PinField, PinFieldPanel, makeField, stepField } from "../src/ui/PinField.tsx";
import { EmptyState } from "../src/ui/primitives.tsx";

type Listener = () => void;
let narrow = false;
let reduced = false;
const rafs: Map<number, FrameRequestCallback> = new Map();
let rafId = 0;
let ctxCalls = 0;
const ctx = new Proxy({} as Record<string, unknown>, {
  get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => { ctxCalls++; void a; }),
  set: (t, k: string, v) => { t[k] = v; return true; },
});

beforeEach(() => {
  narrow = false; reduced = false; rafs.clear(); rafId = 0; ctxCalls = 0;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width") ? narrow : q.includes("reduced-motion") ? reduced : false, addEventListener: (_: string, __: Listener) => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { rafs.set(++rafId, cb); return rafId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafs.delete(id); });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const tick = (t: number) => { const cbs = [...rafs.values()]; rafs.clear(); cbs.forEach((cb) => cb(t)); };

describe("PinField", () => {
  it("renders an aria-hidden canvas with no text", () => {
    render(<PinField />);
    const c = screen.getByTestId("pin-field");
    expect(c.getAttribute("aria-hidden")).toBe("true");
    expect(c.textContent).toBe("");
  });

  it("is absent at 375 px and below", () => {
    narrow = true;
    render(<PinField />);
    expect(screen.queryByTestId("pin-field")).toBeNull();
    expect(rafs.size).toBe(0);
  });

  it("draws one static frame and never schedules a frame under reduced motion", () => {
    reduced = true;
    render(<PinField />);
    expect(ctxCalls).toBeGreaterThan(0);
    expect(rafs.size).toBe(0);
  });

  it("animates, caps at 24 fps, and stops its loop on unmount", () => {
    render(<PinField />);
    expect(rafs.size).toBe(1);
    tick(1000);
    const first = ctxCalls;
    expect(first).toBeGreaterThan(0);
    tick(1000 + 1000 / PIN_FIELD_FPS / 2); // too soon: no redraw
    expect(ctxCalls).toBe(first);
    tick(1000 + 1000 / PIN_FIELD_FPS + 1);
    expect(ctxCalls).toBeGreaterThan(first);
    cleanup();
    expect(rafs.size).toBe(0);
  });

  it("pauses while the tab is hidden and resumes when visible", () => {
    render(<PinField />);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rafs.size).toBe(0);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rafs.size).toBe(1);
  });

  it("pauses while off screen", () => {
    let cb: IntersectionObserverCallback = () => undefined;
    vi.stubGlobal("IntersectionObserver", class { constructor(c: IntersectionObserverCallback) { cb = c; } observe() {} disconnect() {} });
    render(<PinField />);
    cb([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(rafs.size).toBe(0);
    cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(rafs.size).toBe(1);
  });

  it("allocates nothing per frame: sprite state is fixed typed arrays that stepping never replaces", () => {
    const f = makeField();
    const arrays = Object.values(f);
    stepField(f, true);
    stepField(f, false);
    expect(Object.values(f).every((a, i) => a === arrays[i])).toBe(true);
    expect(f.x.every((v) => v >= -0.7 && v <= 1.1)).toBe(true);
  });

  it("moves workers only while an agent is working", () => {
    const f = makeField();
    const w = f.kind.findIndex((k) => k === 2);
    const x0 = f.x[w];
    stepField(f, false);
    expect(f.x[w]).toBe(x0);
    stepField(f, true);
    expect(f.x[w]).toBeGreaterThan(x0);
  });

  it("the side panel is desktop-only and hidden from assistive tech", () => {
    render(<PinFieldPanel />);
    const p = screen.getByTestId("pin-field-panel");
    expect(p.className).toContain("hidden lg:block");
    expect(p.getAttribute("aria-hidden")).toBe("true");
  });

  it("appears in empty states without changing their text", () => {
    render(<EmptyState icon={null} title="No agents yet" body="Create an agent." />);
    expect(screen.getByTestId("pin-field")).toBeTruthy();
    expect(screen.getByText("No agents yet")).toBeTruthy();
  });
});
