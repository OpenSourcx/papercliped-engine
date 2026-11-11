import { describe, expect, it } from "vitest";
import { Breaker, BreakerOpenError, type BreakerStore } from "../src/breaker.js";

const opts = { threshold: 3, windowMs: 15 * 60_000, cooldownMs: 120_000, maxCooldownMs: 30 * 60_000 };
const MIN = 60_000;

function make(now = { t: 1_000_000 }, store?: BreakerStore) {
  return { now, breaker: new Breaker({ now: () => now.t, store }) };
}

describe("Breaker", () => {
  it("stays closed below the threshold and opens at N consecutive failures", async () => {
    const { breaker } = make();
    for (let i = 0; i < 2; i++) { await breaker.check("k", opts); await breaker.failure("k", opts, new Error("boom")); }
    await breaker.check("k", opts); // still closed
    await breaker.failure("k", opts, new Error("quota full"));
    await expect(breaker.check("k", opts)).rejects.toThrow(BreakerOpenError);
    await expect(breaker.check("k", opts)).rejects.toThrow(/breaker is open.*retry after.*quota full/i);
  });

  it("ignores failures older than the window", async () => {
    const { breaker, now } = make();
    await breaker.failure("k", opts, new Error("a"));
    await breaker.failure("k", opts, new Error("b"));
    now.t += 16 * MIN;
    await breaker.failure("k", opts, new Error("c"));
    await expect(breaker.check("k", opts)).resolves.toBeUndefined();
  });

  it("lets one trial through after the cooldown and doubles the cooldown on another failure, capped at 30 min", async () => {
    const { breaker, now } = make();
    const trip = async () => { for (let i = 0; i < 3; i++) await breaker.failure("k", opts, new Error("x")); };
    await trip();
    now.t += 119_000;
    await expect(breaker.check("k", opts)).rejects.toThrow(BreakerOpenError);
    now.t += 2_000; // 2 min passed
    await breaker.check("k", opts);
    await breaker.failure("k", opts, new Error("again"));
    now.t += 3 * MIN; // second cooldown is 4 min
    await expect(breaker.check("k", opts)).rejects.toThrow(BreakerOpenError);
    now.t += 2 * MIN;
    await breaker.check("k", opts);
    for (let i = 0; i < 10; i++) { await breaker.failure("k", opts, new Error("again")); now.t += 31 * MIN; await breaker.check("k", opts); }
    await breaker.failure("k", opts, new Error("again"));
    now.t += 29 * MIN;
    await expect(breaker.check("k", opts)).rejects.toThrow(BreakerOpenError);
    now.t += 2 * MIN;
    await breaker.check("k", opts);
  });

  it("one success resets everything, and keys are independent", async () => {
    const { breaker } = make();
    for (let i = 0; i < 3; i++) await breaker.failure("a", opts, new Error("x"));
    await breaker.check("b", opts);
    await breaker.success("a");
    await breaker.check("a", opts);
    await breaker.failure("a", opts, new Error("x"));
    await breaker.failure("a", opts, new Error("x"));
    await breaker.check("a", opts);
  });

  it("is persisted through the store, so a new instance (worker restart) stays open", async () => {
    const data = new Map<string, unknown>();
    const store: BreakerStore = { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
    const first = make({ t: 5_000_000 }, store);
    for (let i = 0; i < 3; i++) await first.breaker.failure("k", opts, new Error("disk full"));
    const second = make(first.now, store);
    await expect(second.breaker.check("k", opts)).rejects.toThrow(/disk full/);
  });

  it("survives a broken store and can be disabled with threshold 0", async () => {
    const store: BreakerStore = { get: async () => { throw new Error("nope"); }, set: async () => { throw new Error("nope"); } };
    const { breaker } = make({ t: 1 }, store);
    for (let i = 0; i < 3; i++) await breaker.failure("k", opts, new Error("x"));
    await expect(breaker.check("k", opts)).rejects.toThrow(BreakerOpenError);
    for (let i = 0; i < 9; i++) await breaker.failure("off", { ...opts, threshold: 0 }, new Error("x"));
    await breaker.check("off", { ...opts, threshold: 0 });
  });
});
