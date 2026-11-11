// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "ana@pve", name: "Ana", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { EngineProvider, useEngine } from "../src/data/store.tsx";
import { company, renderOrg, setup, state } from "./engine-harness.tsx";

beforeEach(setup);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const settle = () => new Promise((r) => setTimeout(r, 150));

function Probe() {
  const { data } = useEngine();
  return <pre data-testid="orgs">{data.orgs.map((o) => o.name).join(",")}</pre>;
}

describe("ERR-ENG-002 / ERR-SYNC-001: only organizations the person can open", () => {
  it("lists with scope=accessible and never requests a non-member organization", async () => {
    state.routes["GET /engine/api/companies"] = (_b, url) => [200, url.searchParams.get("scope") === "accessible" ? [company("c1", "Acme Works", "ACME")] : [company("c1", "Acme Works", "ACME"), company("c2", "Locked", "LCK")]];
    state.routes["GET /engine/api/companies/c2/agents"] = () => [403, { error: "User does not have access to this company" }];
    render(<EngineProvider><Probe /></EngineProvider>);
    await waitFor(() => expect(screen.getByTestId("orgs").textContent).toBe("Acme Works"));
    await settle();
    expect(state.calls.find((c) => c.path === "/engine/api/companies")?.search).toContain("scope=accessible");
    expect(state.calls.filter((c) => c.path.includes("/companies/c2"))).toEqual([]);
  });
});

describe("ERR-CON-002: no request that is known to fail", () => {
  it("makes no chat request while agent chat is off, on the chat page or the device-wide lists", async () => {
    state.routes["GET /engine/api/instance/settings/experimental"] = () => [200, { enableAgentChat: false }];
    state.routes["GET /engine/api/companies/c1/chats"] = () => [404, { error: "Agent Chat is disabled" }];
    renderOrg("/pve/acme/chat");
    expect(await screen.findByText("Chat is switched off")).toBeTruthy();
    await settle();
    expect(state.calls.filter((c) => c.path.endsWith("/chats"))).toEqual([]);
  });

  it("asks for agent readiness once, even when it is refused", async () => {
    state.routes["GET /api/agent-readiness"] = () => [403, { error: "not_member" }];
    renderOrg("/pve/acme/agents");
    await screen.findByText("Forge");
    await new Promise((r) => setTimeout(r, 1600)); // past react-query's first retry delay

    expect(state.calls.filter((c) => c.path === "/api/agent-readiness")).toHaveLength(1);
  });
});
