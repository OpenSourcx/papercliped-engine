import { describe, expect, it } from "vitest";
import { agentStatusOf } from "../src/data/engine/labels.tsx";

// An agent the engine still calls "running" but that has no queued or running work is not shown as Working.
describe("agentStatusOf with the live-runs answer", () => {
  it("shows Working only while a run is live", () => {
    expect(agentStatusOf("running", "ready", true)[1]).toBe("Working");
    expect(agentStatusOf("running", "ready", false)[1]).toBe("Idle");
  });
  it("keeps the engine's word while the live-runs answer is unknown", () => {
    expect(agentStatusOf("running", "ready", undefined)[1]).toBe("Working");
    expect(agentStatusOf("running", "ready")[1]).toBe("Working");
  });
  it("changes nothing for the other states, and setup still wins", () => {
    for (const s of ["idle", "paused", "error", "pending_approval", "terminated", "active"]) expect(agentStatusOf(s, "ready", false)).toEqual(agentStatusOf(s, "ready"));
    expect(agentStatusOf("running", "verifying", false)[1]).toBe("Verifying");
  });
});
