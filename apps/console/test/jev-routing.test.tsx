// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { JevRouting } from "../src/pages/connect/JevRouting.tsx";

type Call = { method: string; path: string; body: any };
let calls: Call[];
let view: Record<string, unknown>;
const DISCLOSURE = "When this is on, each new task's goal text, file names and expected size are sent to TypeSafe.";

beforeEach(() => {
  calls = [];
  view = { enabled: false, hasKey: false, consentSendTaskText: false, active: false, disclosure: DISCLOSURE };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname.endsWith("/jev/key") && method === "PUT") view = { ...view, hasKey: true };
    else if (url.pathname.endsWith("/jev") && method === "PUT") {
      view = { ...view, ...body };
      view.active = !!(view.enabled && view.hasKey && view.consentSendTaskText);
    }
    return new Response(JSON.stringify(view), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><JevRouting companyId="co_1" orgName="Northwind" /></MemoryRouter></QueryClientProvider>);

describe("Jev task routing card", () => {
  it("starts off, says what is sent, and the switch needs a key and consent", async () => {
    wrap();
    expect(await screen.findByText(DISCLOSURE)).toBeTruthy();
    const sw = screen.getByRole("switch") as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.disabled).toBe(true);
    expect(screen.getByText("Needs a key and your confirmation")).toBeTruthy();
  });
  it("saves the key (password field, cleared afterwards), then consent, then the switch", async () => {
    wrap();
    const input = (await screen.findByLabelText("TypeSafe API key")) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "tsk_test_ABCDEFGH12345678" } });
    fireEvent.click(screen.getByRole("button", { name: /Save key/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/jev/key") && c.body.apiKey === "tsk_test_ABCDEFGH12345678")).toBe(true));
    await screen.findByRole("button", { name: /Replace key/ });
    expect(input.value).toBe("");
    expect(document.body.textContent).not.toContain("tsk_test_ABCDEFGH12345678");
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.body?.consentSendTaskText === true)).toBe(true));
    await waitFor(() => expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("On")).toBeTruthy();
  });
});
