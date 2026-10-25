// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_THEME, ThemeProvider, glassFrom, inkOn, resolveTokens, withRecent } from "../src/theme/theme.tsx";
import { Appearance } from "../src/pages/Appearance.tsx";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("theme runtime", () => {
  it("turns glass solid when transparency effects are off", () => {
    const on = resolveTokens({ ...DEFAULT_THEME, glassBlur: 20, glassAlpha: 0.5 }).tokens;
    expect([on["--glass-blur"], on["--glass-alpha"]]).toEqual(["20px", "0.5"]);
    const off = resolveTokens({ ...DEFAULT_THEME, transparency: false }).tokens;
    expect([off["--glass-blur"], off["--glass-alpha"]]).toEqual(["0px", "1"]);
  });

  it("sets blur and see-through together from one amount", () => {
    expect(glassFrom(0)).toEqual({ glassBlur: 0, glassAlpha: 0.95 });
    expect(glassFrom(100)).toEqual({ glassBlur: 40, glassAlpha: 0.3 });
  });

  it("follows the device in Match this device mode", () => {
    expect(resolveTokens({ ...DEFAULT_THEME, mode: "system", preset: "midnight" }, true).scheme).toBe("light");
    const dark = resolveTokens({ ...DEFAULT_THEME, mode: "system", preset: "midnight" }, false);
    expect(dark.scheme).toBe("dark");
    expect(dark.tokens["--bg"]).toBe("#0b0f1c");
  });

  it("picks readable text for the accent and keeps five recent colours, newest first", () => {
    expect(inkOn("#f2f2f2")).toBe("#1b1a16");
    expect(inkOn("#0063b1")).toBe("#ffffff");
    expect(resolveTokens({ ...DEFAULT_THEME, accent: "#0063b1" }).tokens["--on-accent"]).toBe("#ffffff");
    expect(withRecent(["#111111", "#222222", "#333333", "#444444", "#555555"], "#333333")).toEqual(["#333333", "#111111", "#222222", "#444444", "#555555"]);
    expect(withRecent(["#1", "#2", "#3", "#4", "#5"], "#6")).toHaveLength(5);
  });
});

describe("Appearance page", () => {
  const page = () => render(<ThemeProvider><Appearance /></ThemeProvider>);

  it("switches transparency effects off and greys out the glass amount", () => {
    page();
    fireEvent.click(screen.getByRole("switch", { name: "Transparency effects" }));
    expect(document.documentElement.dataset.transparency).toBe("off");
    expect(document.documentElement.style.getPropertyValue("--glass-blur")).toBe("0px");
    expect(screen.getByText("Turn on transparency effects to use glass.")).toBeTruthy();
  });

  it("chooses an accent from the palette and remembers it as a recent colour", () => {
    page();
    fireEvent.click(screen.getByRole("radio", { name: "Accent #0078d4" }));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#0078d4");
    expect(screen.getByRole("radiogroup", { name: "Recent colours" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("epc.theme")!).recentAccents).toEqual(["#0078d4"]);
  });

  it("turns the rail accent off", () => {
    page();
    fireEvent.click(screen.getByRole("switch", { name: "Accent on the rail" }));
    expect(document.documentElement.dataset.railAccent).toBe("off");
  });
});
