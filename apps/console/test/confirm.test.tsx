// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useConfirm } from "../src/ui/Confirm.tsx";

afterEach(cleanup);

function Harness({ run }: { run: () => void }) {
  const { ask, dialog } = useConfirm();
  return (<>{dialog}<button onClick={() => ask({ title: "Shut down web?", body: "It stops being reachable.", label: "Shut down", danger: true, run })}>Shut down</button></>);
}

describe("confirm before a dangerous action", () => {
  it("does nothing on the first click, asks, and acts only when confirmed", async () => {
    const run = vi.fn();
    render(<Harness run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "Shut down" }));
    expect(run).not.toHaveBeenCalled();
    expect(await screen.findByText("Shut down web?")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Shut down" }).at(-1)!);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("Cancel closes it without acting", async () => {
    const run = vi.fn();
    render(<Harness run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "Shut down" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Shut down web?")).toBeNull());
    expect(run).not.toHaveBeenCalled();
  });
});
