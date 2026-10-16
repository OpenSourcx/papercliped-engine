// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Tabs } from "../src/ui/primitives.tsx";

afterEach(cleanup);
const tabs = [{ id: "a", label: "Users" }, { id: "b", label: "Resource groups" }];

describe("Tabs", () => {
  it("scrolls sideways by default", () => {
    render(<Tabs value="a" tabs={tabs} onChange={() => {}} />);
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).not.toContain("flex-wrap");
  });

  it("wraps onto more rows when asked, so no tab is ever clipped", () => {
    render(<Tabs value="a" tabs={tabs} onChange={() => {}} wrap />);
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("flex-wrap");
    expect(list.className).not.toContain("overflow-x-auto");
    expect(screen.getByRole("tab", { name: "Resource groups" })).toBeTruthy();
  });
});
