import type { ReactNode } from "react";
import { Bot, Cable, Code2, Mail, MessageSquare } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import type { Connector } from "../data/types.ts";
import { Avatar, Card, PageHeader, Status, Toggle } from "../ui/primitives.tsx";
import { PinOrb } from "../pin/PinIsland.tsx";

const ICON: Record<Connector["kind"], ReactNode> = { model: <Bot className="h-4 w-4" />, code: <Code2 className="h-4 w-4" />, chat: <MessageSquare className="h-4 w-4" />, mail: <Mail className="h-4 w-4" />, storage: <Cable className="h-4 w-4" /> };

export function Connectors() {
  const { data, setConnectorAccess } = useEngine();
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-20 sm:pt-24 pb-20">
      <PageHeader title="Connectors" subtitle="System-wide connections, set up once. For each one, choose who can use it: Pin, and any of your organizations. An org's agents only see the connectors granted to it." />
      <Card className="overflow-x-auto">
        <table className="w-full text-[14px] min-w-[640px]">
          <thead>
            <tr className="text-[12px] text-ink-3 border-b border-line">
              <th className="text-left font-normal px-5 h-11">Connector</th>
              <th className="font-normal px-3"><span className="inline-flex items-center gap-1.5"><PinOrb size={14} />Pin</span></th>
              {data.orgs.map((o) => (
                <th key={o.slug} className="font-normal px-3"><span className="inline-flex items-center gap-1.5"><Avatar name={o.name} hue={o.hue} size={16} />{o.name}</span></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.connectors.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <span className="h-8 w-8 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2">{ICON[c.kind]}</span>
                    <div>
                      <div className="font-medium">{c.name}</div>
                      {c.status === "connected" ? <Status kind="good" label="Connected" /> : <Status kind="warning" label="Needs setup" />}
                    </div>
                  </div>
                </td>
                <td className="px-3 text-center"><span className="inline-flex"><Toggle label={`Pin can use ${c.name}`} checked={c.access.pin} disabled={c.status !== "connected"} onChange={(v) => setConnectorAccess(c.id, "pin", v)} /></span></td>
                {data.orgs.map((o) => (
                  <td key={o.slug} className="px-3 text-center"><span className="inline-flex"><Toggle label={`${o.name} can use ${c.name}`} checked={c.access.orgs.includes(o.slug)} disabled={c.status !== "connected"} onChange={(v) => setConnectorAccess(c.id, o.slug, v)} /></span></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-[12px] text-ink-3 mt-3">Credentials stay in the Vault. Agents and Pin receive short-lived, run-scoped access, never the key itself.</p>
    </div>
  );
}
