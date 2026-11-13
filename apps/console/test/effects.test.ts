import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * React treats whatever an effect returns as its cleanup and calls it later. An effect written as a one-line expression
 * (`useEffect(() => el.scrollIntoView(), [])`) therefore returns that call's result: in current Chrome scrollIntoView returns a
 * Promise, and unmounting the page threw "is not a function" and left a blank screen (the CEO chat, 2026-11-12). An effect either
 * has a block body, or its one expression is itself a cleanup function or a parenthesised choice of one.
 */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : []; });

describe("effects never return a value that is not a cleanup", () => {
  it("every one-line effect is a cleanup function or a parenthesised choice", () => {
    const bad: string[] = [];
    for (const file of walk(join(__dirname, "../src"))) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const m = /\buse(?:Layout)?Effect\(\(\) => (.*)$/.exec(line);
        if (!m) return;
        const body = m[1]!;
        if (body.startsWith("{") || body.startsWith("() =>") || body.startsWith("(")) return; // block, cleanup, or a parenthesised choice
        bad.push(`${file.split("/src/")[1]}:${i + 1} ${line.trim().slice(0, 100)}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
