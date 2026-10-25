// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { tileFor, tilesOf } from "../src/pages/pinview/tiles.ts";
import { Menu } from "../src/ui/Menu.tsx";
import { plainText } from "../src/pin/PinThread.tsx";
import type { ThreadMessage } from "../src/pin/useThread.ts";

afterEach(cleanup);
const tool = (id: string, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): ThreadMessage => ({ id: `m-${id}`, from: "pin", text: "", tool: { id, name, args, status: "done", ...extra } as never });

describe("tiles from tool steps", () => {
  it("opens a file for reads and writes, the output for commands, and the steps for a plan", () => {
    const read = tileFor(tool("1", "machine_read_file", { vmid: 103, path: "/etc/hosts" }, { result: "Read /etc/hosts. In paperclip (103).\n127.0.0.1 localhost" }));
    expect(read).toMatchObject({ kind: "file", title: "hosts", vmid: 103, write: false, text: "127.0.0.1 localhost", status: "done" });
    const write = tileFor(tool("2", "machine_write_file", { vmid: 103, path: "/srv/app/.env", content: "PORT=3100" }, { status: "approval" }));
    expect(write).toMatchObject({ kind: "file", write: true, text: "PORT=3100", status: "waiting" });
    const exec = tileFor(tool("3", "machine_exec", { vmid: 103, command: "node --version" }, { status: "failed", error: "The console asks for a login." }));
    expect(exec).toMatchObject({ kind: "command", title: "node --version", text: "The console asks for a login.", status: "failed" });
    const plan = tileFor(tool("4", "propose_plan", { planId: "p1", title: "Install Paperclip", summary: "Four steps", steps: [{ label: "Install Node", destructive: false }, { label: "Wipe disk", destructive: true }] }, { status: "proposed" }));
    expect(plan).toMatchObject({ kind: "plan", title: "Install Paperclip", steps: [{ label: "Install Node" }, { label: "Wipe disk", destructive: true }] });
    expect(tileFor(tool("5", "list_machines", {}))).toBeNull();
    expect(tileFor({ id: "x", from: "pin", text: "hi" })).toBeNull();
  });

  it("leaves out tiles the person closed, in thread order", () => {
    const msgs = [tool("1", "machine_exec", { command: "a" }), { id: "t", from: "pin" as const, text: "words" }, tool("2", "machine_exec", { command: "b" })];
    expect(tilesOf(msgs, new Set()).map((t) => t.id)).toEqual(["1", "2"]);
    expect(tilesOf(msgs, new Set(["1"])).map((t) => t.id)).toEqual(["2"]);
  });
});

describe("Menu", () => {
  it("opens from its button, moves with the arrow keys, runs with Enter and gives focus back", () => {
    const ran: string[] = [];
    render(<Menu label="More" icon={<span>⋯</span>} items={[{ label: "Rename", onSelect: () => ran.push("rename") }, { kind: "separator" }, { label: "Delete", danger: true, onSelect: () => ran.push("delete") }]} />);
    const button = screen.getByRole("button", { name: "More" });
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "More" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(ran).toEqual(["delete"]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("keeps checkboxes open while you tick them and closes on Escape", () => {
    let on = false;
    const { rerender } = render(<Menu label="Show" icon={<span>v</span>} items={[{ kind: "check", label: "Goal", checked: on, onToggle: (v) => { on = v; } }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Goal" }));
    expect(on).toBe(true);
    rerender(<Menu label="Show" icon={<span>v</span>} items={[{ kind: "check", label: "Goal", checked: on, onToggle: (v) => { on = v; } }]} />);
    expect(screen.getByRole("menuitemcheckbox", { name: "Goal" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("copying a message", () => {
  it("reads Markdown as plain words", () => {
    expect(plainText("## Done\n**Node** is `v24` — see [the docs](https://x.example).\n> quoted")).toBe("Done\nNode is v24 — see the docs.\nquoted");
  });
});
