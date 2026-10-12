import { readJson, writeJson } from "../lib/storage.ts";
import type { useEngine } from "../data/store.tsx";
import { pinApi, type ConnectorInfo, type ModelInfo, type PinSettings } from "./live.ts";

/**
 * Where Pin's settings come from. Live, the host service holds them (and the provider keys); the demo keeps them in the
 * browser, with the demo's connectors standing in. The settings screen only sees this interface, so it is tested
 * against a fake.
 */
export interface PinSettingsSource {
  load(): Promise<{ settings: PinSettings; connectors: ConnectorInfo[] }>;
  models(provider: string): Promise<ModelInfo[]>;
  save(s: PinSettings): Promise<PinSettings>;
}

export function liveSettingsSource(api = pinApi()): PinSettingsSource {
  return {
    load: async () => {
      const [settings, connectors] = await Promise.all([api.settings(), api.connectors()]);
      return { settings, connectors };
    },
    models: (provider) => api.models(provider),
    save: (s) => api.saveSettings(s),
  };
}

type Engine = ReturnType<typeof useEngine>;
const KEY = "epc.pinSettings";

/** Placeholder model names for the demo; a live console lists what the provider key can really use. */
export const DEMO_MODELS: ModelInfo[] = [
  { id: "balanced", name: "Balanced" },
  { id: "fast", name: "Fast" },
  { id: "thorough", name: "Thorough" },
];

export function demoSettingsSource(engine: Pick<Engine, "data" | "setup" | "setPinMode" | "setConnectorAccess">): PinSettingsSource {
  const connectors = (): ConnectorInfo[] =>
    engine.data.connectors.map((c) => ({ id: c.id, name: c.name, kind: c.kind === "model" ? "provider" : c.kind, configured: c.status === "connected" }));
  return {
    load: async () => {
      const saved = readJson<Partial<PinSettings>>(KEY, {});
      const list = connectors();
      const firstProvider = list.find((c) => c.kind === "provider" && c.configured)?.id ?? null;
      return {
        connectors: list,
        settings: {
          provider: saved.provider ?? firstProvider,
          model: saved.model ?? (firstProvider ? DEMO_MODELS[0].id : null),
          mode: engine.setup?.pinMode ?? "assistant",
          connectors: engine.data.connectors.filter((c) => c.kind !== "model" && c.access.pin).map((c) => c.id),
        },
      };
    },
    models: async () => DEMO_MODELS,
    save: async (s) => {
      writeJson(KEY, { provider: s.provider, model: s.model });
      engine.setPinMode(s.mode);
      for (const c of engine.data.connectors) if (c.kind !== "model" && c.access.pin !== s.connectors.includes(c.id)) engine.setConnectorAccess(c.id, "pin", s.connectors.includes(c.id));
      return s;
    },
  };
}
