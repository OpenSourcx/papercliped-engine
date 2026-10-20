// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const task = vi.fn();
const engine = { live: true, backend: { task } };
vi.mock("../src/data/store.tsx", () => ({ useEngine: () => engine }));

import { TaskLogModal } from "../src/pages/Tasks.tsx";

// jsdom has no scrollTo on elements; the log scrolls itself to the end.
Element.prototype.scrollTo = () => undefined;

const UPID = "UPID:pve:001D994B:05ABF79F:6AD7EB7B:aptupdate::root@pam:";
afterEach(() => {
  cleanup();
  task.mockReset();
  window.history.pushState({}, "", "/");
});

describe("a task's log", () => {
  it("reads again when a finished task has no result line yet, instead of stopping on the early read", async () => {
    window.history.pushState({}, "", `/?upid=${encodeURIComponent(UPID)}`);
    task
      .mockResolvedValueOnce({ status: "stopped", exitstatus: "OK", log: [] }) // read a moment before the last line was written
      .mockResolvedValue({ status: "stopped", exitstatus: "OK", log: ["TASK OK"] });
    render(<MemoryRouter><TaskLogModal onClose={() => undefined} /></MemoryRouter>);
    expect(await screen.findByText("TASK OK", {}, { timeout: 3000 })).toBeTruthy();
    expect(task.mock.calls.length).toBe(2);
  });

  it("says it is waiting while a task runs with nothing written, and stops re-reading a finished one that has its result", async () => {
    window.history.pushState({}, "", `/?upid=${encodeURIComponent(UPID)}`);
    task.mockResolvedValue({ status: "stopped", exitstatus: "OK", log: ["TASK OK"] });
    render(<MemoryRouter><TaskLogModal onClose={() => undefined} /></MemoryRouter>);
    await screen.findByText("TASK OK");
    await new Promise((r) => setTimeout(r, 900));
    expect(task).toHaveBeenCalledTimes(1);
    cleanup();
    task.mockReset();
    task.mockResolvedValue({ status: "running", exitstatus: null, log: [] });
    render(<MemoryRouter><TaskLogModal onClose={() => undefined} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Waiting for output…")).toBeTruthy());
  });
});
