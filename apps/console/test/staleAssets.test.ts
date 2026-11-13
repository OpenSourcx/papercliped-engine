import { describe, expect, it } from "vitest";
import { isStaleAssetError, reloadOnceForUpdate } from "../src/lib/staleAssets.ts";

describe("a tab left open across a deploy", () => {
  it("recognises the errors a missing screen file produces, and nothing else", () => {
    for (const m of ["Failed to fetch dynamically imported module: https://x/assets/LiveChat-abc.js", "error loading dynamically imported module", "Importing a module script failed.", "Loading chunk 12 failed."]) expect(isStaleAssetError(new Error(m))).toBe(true);
    for (const m of ["l is not a function", "Cannot read properties of undefined", "Objects are not valid as a React child"]) expect(isStaleAssetError(new Error(m))).toBe(false);
  });
  it("reloads once, then lets the problem show instead of looping", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    let reloads = 0;
    expect(reloadOnceForUpdate(1_000, store, () => { reloads++; })).toBe(true);
    expect(reloadOnceForUpdate(20_000, store, () => { reloads++; })).toBe(false);
    expect(reloads).toBe(1);
    expect(reloadOnceForUpdate(70_000, store, () => { reloads++; })).toBe(true); // a later deploy is a new situation
  });
});
