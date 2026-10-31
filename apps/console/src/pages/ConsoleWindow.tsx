import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useEngine } from "../data/store.tsx";
import { Terminal } from "../terminal/LazyTerminal.tsx";
import { DemoTransport, LiveTransport } from "../terminal/transport.ts";

/**
 * A console on its own, filling a browser window: what a console's "Open in its own window" button opens
 * (/:device/console/:vmid, or /:device/console/host for the host shell). No app chrome, so it can sit beside other work.
 */
export function ConsoleWindow() {
  const { vmid } = useParams();
  const { data, setup, host, live, ready } = useEngine();
  const isHost = vmid === "host";
  const g = isHost ? null : data.guests.find((x) => String(x.vmid) === vmid);
  const name = isHost ? setup?.deviceName ?? "pve" : g?.name;
  useEffect(() => {
    if (name) document.title = `root@${name}`;
  }, [name]);
  const make = useMemo(
    () => () =>
      isHost
        ? live ? new LiveTransport("/api/console/node") : new DemoTransport({ kind: "host", name: setup?.deviceName ?? "pve", os: "Debian 13 (trixie)", ip: host.ip, cores: host.cpus, memUsed: host.memUsed, memMax: host.memTotal, diskMax: host.diskTotal, uptimeSec: host.uptimeSec })
        : live && g ? new LiveTransport(`/api/console/guests/${g.vmid}`) : new DemoTransport({ kind: g?.type ?? "lxc", name: g?.name ?? "machine", os: g?.os ?? "Linux", ip: g?.ip ?? null, cores: g?.cores ?? 1, memUsed: g?.memUsed ?? 0, memMax: g?.memMax ?? 1, diskMax: g?.diskMax ?? 1, uptimeSec: host.uptimeSec - 3600 }),
    [vmid, live, !!g], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!isHost && !g) return <Message text={ready ? "That machine isn't on this device any more. Close this window." : "Opening console…"} />;
  if (g && g.status !== "running") return <Message text={`${g.name} isn't running. Start it, then open its console again.`} />;
  return (
    <div className="h-dvh bg-bg p-2 flex">
      <Terminal make={make} title={`root@${name}`} className="flex-1 h-full" />
    </div>
  );
}

function Message({ text }: { text: string }) {
  return <div className="h-dvh bg-bg flex items-center justify-center p-6 text-compact text-ink-3 text-center">{text}</div>;
}
