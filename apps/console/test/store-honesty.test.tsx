// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "ana@pve", name: "Ana", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { EngineProvider } from "../src/data/store.tsx";
import { StoreItemModal } from "../src/pages/store/Store.tsx";
import { setup } from "./engine-harness.tsx";

beforeEach(setup);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function open(item: string) {
  window.history.pushState({}, "", `/?modal=store-item&item=${item}`);
  return render(<QueryClientProvider client={new QueryClient()}><EngineProvider><MemoryRouter><StoreItemModal onClose={() => {}} /></MemoryRouter></EngineProvider></QueryClientProvider>);
}
const installButton = async () => (await screen.findByRole("button", { name: /Install/ })) as HTMLButtonElement;

describe("Store on a live device (ERR-STORE-002, ERR-STORE-003)", () => {
  it("disables Install for a connector with a reason instead of changing demo state", async () => {
    open("slack");
    const btn = await installButton();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("Not available yet");
    expect(screen.getByText(/Not available yet\./)).toBeTruthy();
  });
  it("disables Install for a skill", async () => {
    open("update-guardian");
    expect((await installButton()).disabled).toBe(true);
  });
  it("renders a planned connector (no host implementation) as not installable", async () => {
    open("linear");
    expect((await installButton()).disabled).toBe(true);
    expect(screen.getByText(/this is planned/i)).toBeTruthy();
  });
});
