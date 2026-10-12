import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { AlertTriangle, Loader2, Plug, RefreshCw } from "lucide-react";
import { useEngine } from "../../../data/store.tsx";
import type { Org } from "../../../data/types.ts";
import { useOrgEvents } from "../../../data/engine/events.ts";
import { errorText, useEngineStatus, useOrgs, type EngineGate } from "../../../data/engine/queries.ts";
import { Button, Card, EmptyState, PageFrame, PageHeader } from "../../../ui/primitives.tsx";
import { AgentContainersBanner } from "../../containers/Banner.tsx";

/** The live organization at /<device>/<org>, with its engine company id. Only valid under LiveOrgRoute. */
export function useLiveOrg(): { org: Org; companyId: string } {
  const { org: slug } = useParams();
  const org = useEngine().data.orgs.find((o) => o.slug === slug);
  if (!org?.engine) throw new Error("useLiveOrg outside a live organization");
  return { org, companyId: org.engine.companyId };
}

/** What to tell someone when the engine can't be used, and what they can do about it. */
export function EngineUnavailable({ gate, compact }: { gate: Exclude<EngineGate, { state: "demo" | "ready" | "checking" }>; compact?: boolean }) {
  const what = {
    not_installed: { title: "The engine isn't installed", body: "Organizations, agents and tasks live in the Paperclip engine, which isn't on this device yet. Install it with the ePaperclip installer (it needs about 2 GB of free memory and 3 GB of disk), then come back." },
    unreachable: { title: "The engine isn't answering", body: "It's installed but not responding. It may be restarting. On the host, check the epaperclip-engine service; this page retries on its own." },
    starting: { title: "The engine is getting ready", body: "It's starting up or finishing its first-time setup. This usually takes a minute; this page updates on its own." },
    unknown: { title: "Can't check the engine", body: "The host service didn't say whether the engine is ready. This page retries on its own." },
  }[gate.state];
  const detail = gate.message && gate.message !== what.body ? gate.message : null;
  const body = (
    <EmptyState
      icon={gate.state === "starting" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plug className="h-5 w-5" />}
      title={what.title}
      body={detail ? `${what.body} (${detail})` : what.body}
    />
  );
  if (compact) return body;
  return (
    <PageFrame width="3xl">
      <Card>{body}</Card>
    </PageFrame>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-14 text-ink-3 text-sm" aria-busy="true">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

/** A failed read, with the engine's own words and a retry. */
export function LoadError({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-4 text-sm" role="alert">
      <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
      <span className="flex-1 text-ink-2">{errorText(error)}</span>
      {retry && <Button size="sm" variant="ghost" onClick={retry}><RefreshCw className="h-3.5 w-3.5" />Try again</Button>}
    </div>
  );
}

/** A write that failed, shown inline under the form. */
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-compact text-critical mt-2" role="alert">{errorText(error)}</p>;
}

/** Pages under an organization that the engine doesn't back yet. Live, they redirect to the dashboard rather than show made-up data. */
export const LIVE_HIDDEN = new Set(["inbox", "chat", "routines", "artifacts", "workspaces", "skills", "connectors"]);

/**
 * Everything under /<device>/<org>. Live, it waits for the engine and the organization list, explains calmly when the
 * engine can't be used, keeps the organization's live-events socket open, and hides pages the engine doesn't back.
 */
export function OrgRoute() {
  const { live } = useEngine();
  return live ? <LiveOrgRoute /> : <Outlet />;
}

function LiveOrgRoute() {
  const gate = useEngineStatus();
  const orgs = useOrgs();
  const { setup, data } = useEngine();
  const { org: slug } = useParams();
  const loc = useLocation();
  const org = data.orgs.find((o) => o.slug === slug);
  useOrgEvents(org?.engine?.companyId);
  const device = setup?.deviceName ?? "pve";
  if (gate.state === "checking") return <PageFrame width="3xl"><Loading label="Checking the engine" /></PageFrame>;
  if (gate.state !== "ready" && gate.state !== "demo") return <EngineUnavailable gate={gate} />;
  if (orgs.error && !orgs.data) {
    return (
      <PageFrame width="3xl">
        <PageHeader title="Organization" />
        <Card><LoadError error={orgs.error} retry={() => void orgs.refetch()} /></Card>
      </PageFrame>
    );
  }
  if (!orgs.data) return <PageFrame width="3xl"><Loading label="Loading organizations" /></PageFrame>;
  // A list being refreshed may not have a just-created organization yet: wait for it before giving up on the address.
  if (!org && orgs.isFetching) return <PageFrame width="3xl"><Loading label="Loading organizations" /></PageFrame>;
  if (!org) return <Navigate to={`/${device}/home`} replace />;
  const page = loc.pathname.split("/")[3];
  if (page && LIVE_HIDDEN.has(page)) return <Navigate to={`/${device}/${org.slug}`} replace />;
  return (
    <>
      <AgentContainersBanner />
      <Outlet />
    </>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-compact text-ink-2 mb-1.5">{label}{hint && <span className="text-ink-3"> {hint}</span>}</span>
      {children}
    </label>
  );
}

export const selectClass = "h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-sm outline-none focus:border-line-strong";
export const textareaClass = "w-full rounded-lg bg-surface-2 border border-line px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none focus:border-line-strong focus:ring-2 focus:ring-accent/30 transition";
