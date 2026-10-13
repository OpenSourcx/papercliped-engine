import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { clusterApi, type ClusterOverview } from "../../data/engine/clusterApi.ts";
import { useEngine } from "../../data/store.tsx";
import { Button, EmptyState } from "../../ui/primitives.tsx";
import { Async, LiveOnly } from "../node/common.tsx";

export const useOverview = () => {
  const { live } = useEngine();
  return useQuery({ queryKey: ["cluster", "overview"], queryFn: clusterApi.overview, enabled: live, refetchInterval: 20_000, retry: 1 });
};

/** For screens that only mean something in a cluster: a single device gets a calm explanation and a way in. */
export function ClusterOnly({ children, what }: { children: (o: ClusterOverview) => ReactNode; what: string }) {
  const q = useOverview();
  const { setup } = useEngine();
  return (
    <LiveOnly>
      <Async q={q}>
        {(o) => o.clustered ? <>{children(o)}</> : (
          <EmptyState
            icon={<Network className="h-5 w-5" />}
            title="This device is not in a cluster"
            body={`${what} needs two or more devices joined into a cluster. This one runs on its own, which is fine. You can create a cluster here, or join it to an existing one.`}
            action={<Link to={`/${setup?.deviceName ?? "pve"}/datacenter/cluster`}><Button variant="primary">Create cluster</Button></Link>}
          />
        )}
      </Async>
    </LiveOnly>
  );
}

export const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : "Never");

/** "3 minutes ago" for a unix time in seconds. */
export function ago(t: number | null, now = Date.now()): string {
  if (!t) return "Never";
  const s = Math.max(0, Math.round(now / 1000 - t));
  if (s < 90) return "Just now";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

export function useToggle(initial = false): [boolean, () => void, () => void] {
  const [on, set] = useState(initial);
  return [on, () => set(true), () => set(false)];
}
