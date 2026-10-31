// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TerminalTransport } from "../src/terminal/transport.ts";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
    onResize() {
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const { Terminal } = await import("../src/terminal/Terminal.tsx");

function transport() {
  const t = { live: true, opened: 0, closed: 0, open() { t.opened++; }, input() {}, close() { t.closed++; } };
  return t as TerminalTransport & { opened: number; closed: number };
}

beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a console in its own window", () => {
  it("opens the console's page in a pop-up and steps aside until that window is closed", () => {
    const t = transport();
    const win = { closed: false, focus: vi.fn(), close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    render(<Terminal make={() => t} title="root@web" popout="/pve/console/101" />);
    expect(t.opened).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Open in its own window" }));
    expect(open).toHaveBeenCalledWith("/pve/console/101", "epc-console:/pve/console/101", "popup,width=960,height=640");
    expect(screen.getByText("This console is open in its own window.")).toBeTruthy();
    expect(t.closed).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Go to the window" }));
    expect(win.focus).toHaveBeenCalledTimes(2);
    win.closed = true;
    act(() => void vi.advanceTimersByTime(1100));
    expect(screen.queryByText("This console is open in its own window.")).toBeNull();
    expect(t.opened).toBe(2);
  });

  it("brings the console back on request, closing the other window", () => {
    const t = transport();
    const win = { closed: false, focus: vi.fn(), close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    render(<Terminal make={() => t} title="root@web" popout="/pve/console/101" />);
    fireEvent.click(screen.getByRole("button", { name: "Open in its own window" }));
    fireEvent.click(screen.getByRole("button", { name: "Show it here instead" }));
    expect(win.close).toHaveBeenCalled();
    expect(t.opened).toBe(2);
  });

  it("falls back to full screen when the browser blocks the pop-up", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<Terminal make={() => transport()} title="root@web" popout="/pve/console/101" />);
    fireEvent.click(screen.getByRole("button", { name: "Open in its own window" }));
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeTruthy();
  });

  it("keeps full screen for a console with no page of its own", () => {
    render(<Terminal make={() => transport()} title="apt full-upgrade" />);
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in its own window" })).toBeNull();
  });
});
