import type { ReactNode } from "react";
import { Cable, Loader2, Lock, ServerOff, WifiOff } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { FabricError, fabricErrorText, type FabricOverview, useFabric } from "../../data/engine/fabric.ts";
import { Button, Card, EmptyState, PageFrame, PageHeader } from "../../ui/primitives.tsx";

/**
 * The honest outer states of every Worker Fabric page: the demo has no host, the host may not offer the Fabric or have
 * it switched off, the person may not be an administrator, or the device may be unreachable. Only a real answer reaches
 * `children`; nothing is invented.
 */
export function FabricGate({ title, subtitle, children }: { title: string; subtitle?: string; children: (f: FabricOverview) => ReactNode }) {
  const live = useEngine().live;
  const q = useFabric();
  if (!live) return <Frame title={title} subtitle={subtitle}><Card><EmptyState icon={<ServerOff className="h-5 w-5" />} title="Workers need a connected device" body="The demo has no host to adopt computers into. On a real device, a Proxmox administrator adopts workers here." /></Card></Frame>;
  if (q.isPending) return <Frame title={title} subtitle={subtitle}><div className="py-12 grid place-items-center text-ink-3" aria-busy="true" role="status"><Loader2 className="h-5 w-5 animate-spin" aria-hidden /><span className="sr-only">Loading workers</span></div></Frame>;
  if (q.error) {
    const e = q.error;
    const status = e instanceof FabricError ? e.status : -1;
    const [icon, head, body] =
      status === 404 ? [<ServerOff key="i" className="h-5 w-5" />, "This device doesn't offer the Worker Fabric", "The host service on this device is older than the Worker Fabric, or it was built without it. Update ePaperclip to use workers. Nothing is lost in the meantime."]
      : status === 403 ? [<Lock key="i" className="h-5 w-5" />, "Only Proxmox administrators can manage workers", "Ask an administrator of this device to add or change workers."]
      : status === 0 ? [<WifiOff key="i" className="h-5 w-5" />, "Can't reach this device", "Check that the host service is running and that this browser can reach it, then try again."]
      : [<Cable key="i" className="h-5 w-5" />, "The Worker Fabric didn't answer", fabricErrorText(e)];
    return <Frame title={title} subtitle={subtitle}><Card><EmptyState icon={icon} title={head as string} body={body as string} action={status === 404 || status === 403 ? undefined : <Button onClick={() => void q.refetch()}>Try again</Button>} /></Card></Frame>;
  }
  if (!q.data.enabled) return <Frame title={title} subtitle={subtitle}><Card><EmptyState icon={<Cable className="h-5 w-5" />} title="The Worker Fabric is turned off" body="This device supports workers, but the Fabric is not switched on yet. Turn it on in the host service's configuration (see the Worker Fabric guide), then reload this page." /></Card></Frame>;
  return <>{children(q.data)}</>;
}

function Frame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <PageFrame><PageHeader title={title} subtitle={subtitle} />{children}</PageFrame>;
}
