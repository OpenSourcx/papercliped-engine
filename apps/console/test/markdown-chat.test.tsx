// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Markdown, parseBlocks } from "../src/pages/pin/notes/Markdown.tsx";

afterEach(cleanup);

describe("Markdown in chat", () => {
  it("formats what a model writes: bold, code, lists, with no stray markers left", () => {
    const text = 'Your Proxmox host **pve** is running well:\n\n- **CPU**: 8-core Intel Xeon W3520 @ 2.67GHz, 3.3% used.\n- **Memory**: 32GB total, `4GB` used.\n- **Uptime**: 9 days, 3 hours.';
    const { container } = render(<Markdown text={text} chat />);
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).not.toContain("`");
    expect([...container.querySelectorAll("strong")].map((e) => e.textContent)).toEqual(["pve", "CPU", "Memory", "Uptime"]);
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector("code")!.textContent).toBe("4GB");
  });

  it("renders strikethrough, underscore emphasis and nested lists, but leaves snake_case alone", () => {
    const { container } = render(<Markdown text={"~~old~~ __bold__ _soft_ my_container_name\n\n- top\n  - child\n    - grandchild"} chat />);
    expect(container.querySelector("del")!.textContent).toBe("old");
    expect(container.querySelector("strong")!.textContent).toBe("bold");
    expect(container.querySelector("em")!.textContent).toBe("soft");
    expect(container.textContent).toContain("my_container_name");
    const items = [...container.querySelectorAll("li")];
    expect(items.map((li) => li.className)).toEqual(["", "ml-5", "ml-10"]);
  });

  it("renders a table with alignment and keeps cell text inert", () => {
    const text = "| Machine | Status | Memory |\n| :--- | :---: | ---: |\n| `web` | **running** | 2 GB |\n| <b>db</b> | stopped | 4 GB |";
    const { container } = render(<Markdown text={text} chat />);
    expect([...container.querySelectorAll("th")].map((e) => e.textContent)).toEqual(["Machine", "Status", "Memory"]);
    expect([...container.querySelectorAll("th")].map((e) => e.className.match(/text-(left|center|right)/)![1])).toEqual(["left", "center", "right"]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelector("tbody strong")!.textContent).toBe("running");
    expect(container.querySelector("b")).toBeNull(); // raw tags are text
    expect(container.textContent).toContain("<b>db</b>");
    expect(parseBlocks("text\n| a | b |\n|---|---|\n| 1 | 2 |").map((b) => b.t)).toEqual(["p", "table"]);
    expect(parseBlocks("a | b\nnot a table").map((b) => b.t)).toEqual(["p"]);
  });

  it("gives code blocks a copy button that copies exactly the code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown text={"```bash\npct list\nqm list\n```"} chat />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("pct list\nqm list");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("copes with a reply that is still being written", () => {
    const { container } = render(<Markdown text={"Here you go:\n\n```bash\npct create 120 local:vztmpl/debian"} chat />);
    expect(container.querySelector("pre")!.textContent).toBe("pct create 120 local:vztmpl/debian");
    const half = render(<Markdown text={"This is **half"} chat />);
    expect(half.container.textContent).toBe("This is **half");
  });

  it("keeps headings in chat no bigger than the answer around them", () => {
    const { container } = render(<Markdown text={"# Big\n\n### Small"} chat />);
    const heads = [...container.querySelectorAll('[role="heading"]')];
    expect(heads.map((h) => h.className)).toEqual([expect.stringContaining("text-body"), expect.stringContaining("text-sm")]);
  });
});
