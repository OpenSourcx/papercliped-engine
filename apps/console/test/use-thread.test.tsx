// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useThread, wait } from "../src/pin/useThread.ts";

describe("useThread", () => {
  it("adds the person's message and builds the answer from a source's events, steps in order", async () => {
    const { result } = renderHook(() => useThread());
    act(() => result.current.run("hi", async ({ emit }) => {
      emit({ type: "delta", text: "Looking" });
      emit({ type: "tool", tool: { id: "t1", name: "list_machines", args: {}, status: "running" } as never });
      emit({ type: "delta", text: "Done." });
    }));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.messages.map((m) => [m.from, m.text, m.tool?.id ?? null])).toEqual([["you", "hi", null], ["pin", "Looking", null], ["pin", "", "t1"], ["pin", "Done.", null]]);
  });

  it("labels an agent's answer and passes earlier turns as history", async () => {
    const { result } = renderHook(() => useThread());
    let seen: unknown;
    act(() => result.current.run("one", async ({ emit }) => emit({ type: "delta", text: "A" }), { from: "agent", name: "CEO" }));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    act(() => result.current.run("two", async ({ emit, history }) => { seen = history; emit({ type: "delta", text: "B" }); }, { from: "agent", name: "CEO" }));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(seen).toEqual([{ role: "user", content: "one" }, { role: "assistant", content: "A" }]);
    expect(result.current.messages.at(-1)).toMatchObject({ from: "agent", name: "CEO", text: "B" });
  });

  it("stop ends a slow answer at once and drops the empty reply", async () => {
    const { result } = renderHook(() => useThread());
    act(() => result.current.run("slow", async ({ signal }) => { await wait(5_000, signal); }));
    expect(result.current.streaming).toBe(true);
    act(() => result.current.stop());
    expect(result.current.streaming).toBe(false);
    expect(result.current.messages.map((m) => m.from)).toEqual(["you"]);
  });
});
