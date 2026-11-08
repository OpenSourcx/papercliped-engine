import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthPanel } from "../src/pages/workers/Health.tsx";
import { healthOf, span } from "../src/pages/workers/util.ts";
import { worker } from "./workers.fixtures.ts";
import type { WorkerStats } from "../src/data/engine/fabric.ts";

const latest = { at: Date.now(), uptimeS: 90000, load: [0.1, 0.2, 0.3] as [number, number, number], cpu: { pct: 23, cores: 6, tempC: 51 }, mem: { totalMb: 7485, usedMb: 1300, availMb: 6185, swapTotalMb: 0, swapUsedMb: 0 }, disk: [{ path: "/", totalGb: 958, freeGb: 892 }], gpu: { kind: "jetson" as const, name: "NVIDIA Jetson Orin Nano", utilPct: 0, tempC: 52.5, memUsedMb: null, memTotalMb: null, source: "sysfs" }, temps: {}, services: { worker: "active" as const, ollama: "active" as const, tailscale: "failed" as const }, ollama: { up: true, version: "0.40.15", loaded: [], available: [{ name: "qwen2.5-coder:3b", sizeMb: 1841 }], running: 0, queued: 1 }, pulls: [] };
const pts = [0, 1, 2].map((i) => ({ at: Date.now() - (2 - i) * 15000, cpu: 10 + i, memPct: 20, gpu: 0, temp: 50, load: 0.1, diskFree: 890, loaded: 0 }));

describe("worker health", () => {
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  it("shows live numbers, service states as words, and models", () => {
    render(<HealthPanel cores={6} data={{ online: true, latest, recent: pts, history: pts } as WorkerStats} />);
    expect(screen.getByText(/23% of 6 cores/)).toBeTruthy();
    expect(screen.getAllByText(/Tailscale failed/).length).toBeGreaterThan(0);
    expect(screen.getByText(/qwen2\.5-coder:3b/)).toBeTruthy();
    expect(screen.getByText("1 d 1 h")).toBeTruthy();
  });
  it("says what is missing instead of an empty chart", () => {
    render(<HealthPanel cores={6} data={{ online: true, latest: null, recent: [], history: [] }} />);
    expect(screen.getByText("No health samples yet")).toBeTruthy();
  });
  it("labels a connected worker with no recent sample as stale", () => {
    expect(healthOf(worker({ health: { ...worker().health, state: "stale" } })).label).toBe("Stale");
    expect(span(120)).toBe("2 min");
  });
});
