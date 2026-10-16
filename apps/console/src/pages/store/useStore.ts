import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { connectApi } from "../../data/engine/connectApi.ts";
import { isoEntries, type Latest } from "@papercliped-engine/os-library";
import type { CatalogTemplate } from "../../data/api.ts";
import { useEngine } from "../../data/store.tsx";
import { DEFAULT_PLUGINS, PLUGINS, fromMarket, type PluginEntry } from "../../data/storePlugins.ts";
import { storagesWith } from "../storage/content.ts";
import { buildStoreItems, type FilesByStorage, type StoreItem } from "./catalog.ts";

const names = (items: { volid: string }[]) => items.map((i) => i.volid.slice(i.volid.indexOf("/") + 1));

/**
 * Everything the Store shows, read from the drives, Proxmox's template list and the vendors' own download lists.
 * Anything that can't be read leaves its items as "not installed" rather than hiding them.
 */
export function useStoreItems() {
  const engine = useEngine();
  const { data, backend, contentVersion } = engine;
  const [catalog, setCatalog] = useState<CatalogTemplate[]>([]);
  const [isoFiles, setIsoFiles] = useState<FilesByStorage>({});
  const [tplFiles, setTplFiles] = useState<FilesByStorage>({});
  const [latest, setLatest] = useState<Record<string, Latest | undefined>>({});
  const [market, setMarket] = useState<PluginEntry[]>([]);
  const [catalogProblem, setCatalogProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [problems, setProblems] = useState<string[]>([]);

  const isoStorages = storagesWith(data.host.storage, "iso").map((s) => s.id).join(",");
  const tplStorages = storagesWith(data.host.storage, "vztmpl").map((s) => s.id).join(",");

  useEffect(() => {
    let gone = false;
    const bad: string[] = [];
    (async () => {
      const files = async (list: string, kind: "iso" | "vztmpl"): Promise<FilesByStorage> => {
        const out: FilesByStorage = {};
        await Promise.all(list.split(",").filter(Boolean).map(async (s) => {
          try { out[s] = names(await backend.content(s, kind)); } catch { bad.push(`Couldn't read ${s}.`); }
        }));
        return out;
      };
      const [iso, tpl, cat] = await Promise.all([files(isoStorages, "iso"), files(tplStorages, "vztmpl"), backend.catalog().catch(() => { bad.push("Couldn't read Proxmox's template list."); return [] as CatalogTemplate[]; })]);
      if (gone) return;
      setIsoFiles(iso); setTplFiles(tpl); setCatalog(cat); setProblems(bad); setLoading(false);
    })();
    return () => { gone = true; };
  }, [backend, contentVersion, isoStorages, tplStorages]);

  useEffect(() => {
    let gone = false;
    for (const e of isoEntries()) {
      backend.libraryLatest(e.id).then((l) => { if (!gone) setLatest((m) => (m[e.id] ? m : { ...m, [e.id]: l })); }, () => {});
    }
    return () => { gone = true; };
  }, [backend]);

  useEffect(() => {
    let gone = false;
    backend.marketplace().then((m) => { if (gone) return; setMarket(m.entries.map(fromMarket)); setCatalogProblem(m.problem?.message ?? null); }, () => {});
    return () => { gone = true; };
  }, [backend]);

  // On a device, adapters are really switched on in the engine (docs/CONNECTORS.md); the engine's answer replaces the saved choice.
  const adapters = useQuery({ queryKey: ["connect", "adapters"], queryFn: connectApi.adapters, enabled: engine.live, retry: 1 });
  const installedPlugins = useMemo(() => {
    const base = new Set([...(data.plugins ?? DEFAULT_PLUGINS), ...data.connectors.map((c) => c.id)]);
    if (engine.live && adapters.data) {
      for (const p of PLUGINS) if (p.kind === "adapter") base.delete(p.id);
      for (const a of adapters.data.adapters) if (a.enabled) base.add(a.type);
      for (const a of adapters.data.adapters) if (a.source === "external" && a.verified && a.enabled) base.add(a.type);
    }
    return base;
  }, [data.plugins, data.connectors, engine.live, adapters.data]);
  const items: StoreItem[] = useMemo(() => buildStoreItems({ catalog, isoFiles, tplFiles, latest, installedPlugins, market }), [catalog, isoFiles, tplFiles, latest, installedPlugins, market]);
  return { items, loading, problems: catalogProblem ? [...problems, catalogProblem] : problems, latest };
}
