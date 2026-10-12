// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PinSettingsPanel } from "../src/pin/PinSettings.tsx";
import type { ConnectorInfo, PinSettings } from "../src/pin/live.ts";
import type { PinSettingsSource } from "../src/pin/settings.ts";

afterEach(cleanup);

const CONNECTORS: ConnectorInfo[] = [
  { id: "anthropic", kind: "model", name: "Anthropic", configured: true, last4: "abcd", ok: true },
  { id: "openai", kind: "model", name: "OpenAI", configured: true },
  { id: "gemini", kind: "model", name: "Gemini", configured: false },
  { id: "github", kind: "code", name: "GitHub", configured: true },
  { id: "slack", kind: "chat", name: "Slack", configured: false },
];

function fakeSource(settings: PinSettings, connectors = CONNECTORS) {
  const models: Record<string, { id: string; name: string }[]> = {
    anthropic: [{ id: "model-a", name: "Model A" }],
    openai: [{ id: "model-x", name: "Model X" }, { id: "model-y", name: "Model Y" }],
  };
  const source: PinSettingsSource & { save: ReturnType<typeof vi.fn> } = {
    load: vi.fn(async () => ({ settings, connectors })),
    models: vi.fn(async (p: string) => models[p] ?? []),
    save: vi.fn(async (s: PinSettings) => s),
  };
  return source;
}

const mount = (source: PinSettingsSource, onSaved = vi.fn()) => {
  render(<MemoryRouter><PinSettingsPanel source={source} onSaved={onSaved} /></MemoryRouter>);
  return onSaved;
};

describe("Pin settings", () => {
  it("chooses a provider, a model, the mode and connectors, then saves them in one go", async () => {
    const source = fakeSource({ provider: "anthropic", model: "model-a", mode: "assistant", connectors: [] });
    const onSaved = mount(source);

    await screen.findByRole("radio", { name: /Anthropic/ });
    expect(screen.getByRole("radio", { name: /Gemini/ })).toHaveProperty("disabled", true);
    const save = screen.getByRole("button", { name: "Save settings" });
    expect(save).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("radio", { name: /OpenAI/ }));
    await waitFor(() => expect(source.models).toHaveBeenCalledWith("openai"));
    const select = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll("option").length).toBe(3));
    fireEvent.change(select, { target: { value: "model-y" } });

    fireEvent.click(screen.getByRole("radio", { name: /Agent/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Let Pin use GitHub" }));
    expect(screen.getByRole("switch", { name: "Let Pin use Slack" })).toHaveProperty("disabled", true);

    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    await waitFor(() => expect(source.save).toHaveBeenCalledWith({ provider: "openai", model: "model-y", mode: "agent", connectors: ["github"] }));
    await screen.findByText(/Saved/);
    expect(onSaved).toHaveBeenCalled();
    expect(save).toHaveProperty("disabled", true);
  });

  it("asks for a model provider when none is set up", async () => {
    mount(fakeSource({ provider: null, model: null, mode: "assistant", connectors: [] }, CONNECTORS.map((c) => ({ ...c, configured: c.kind === "model" ? false : c.configured }))));
    await screen.findByText("Pin needs a model provider");
    expect(screen.getByRole("link", { name: "Add a model provider" }).getAttribute("href")).toContain("settings=connectors");
  });

  it("says when a save fails and keeps the changes", async () => {
    const source = fakeSource({ provider: "anthropic", model: "model-a", mode: "assistant", connectors: [] });
    source.save.mockRejectedValueOnce(new Error("The host service is restarting."));
    mount(source);
    fireEvent.click(await screen.findByRole("radio", { name: /Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("The host service is restarting.");
    expect(screen.getByRole("button", { name: "Save settings" })).toHaveProperty("disabled", false);
  });

  it("offers a retry when the settings don't load", async () => {
    const source = fakeSource({ provider: null, model: null, mode: "assistant", connectors: [] });
    (source.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Can't reach this device."));
    mount(source);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("radio", { name: /Anthropic/ });
  });
});
