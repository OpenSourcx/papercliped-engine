import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSession } from "../../auth/session.tsx";
import { engine, errorText } from "../../data/engine/queries.ts";
import { Button, Card, Notice, PageFrame, PageHeader } from "../../ui/primitives.tsx";
import { ProviderMark } from "../../ui/ProviderMark.tsx";

/** An external sender explicitly binds their identity to the signed-in Proxmox person. */
export function ChannelIdentity() {
  const { session } = useSession();
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  useEffect(() => { window.history.replaceState(null, "", window.location.pathname); }, []);
  const valid = token.length >= 32 && token.length <= 4096;
  const preview = useQuery({ queryKey: ["channel-identity", token], queryFn: () => engine.channels.previewIdentity(token), enabled: valid && session.mode === "live", retry: false, gcTime: 0 });
  const confirm = useMutation({ mutationFn: () => engine.channels.confirmIdentity(token) });
  const identity = preview.data;
  return <PageFrame width="3xl"><PageHeader title="Link your chat identity" /><Card className="p-6 space-y-4">
    {!valid || preview.error ? <p role="alert">This link is invalid, expired, or unavailable to your account. Request a new link from the provider.</p> : !identity ? <p>Checking identity…</p> : confirm.isSuccess ? <p role="status">Identity linked. Messages from {identity.externalLabel} now use your current permissions in {identity.companyName}.</p> : <>
      <div className="flex items-center gap-3"><ProviderMark id={identity.provider} name={identity.provider} /><div><div className="font-medium">{identity.externalLabel}</div><div className="text-xs text-ink-3">{identity.externalDetail}</div></div></div>
      <p className="text-sm text-ink-2">Link this identity to <strong>{session.mode === "live" ? session.user.username : "your account"}</strong> in <strong>{identity.companyName}</strong>. Only confirm if this is your provider account. Every action still checks your organization permissions.</p>
      {identity.canConfirm === false ? <Notice tone="warning">You need access to this organization first. Ask a device administrator to grant it in Access control, then request a new link.</Notice> : <Button variant="primary" loading={confirm.isPending} onClick={() => confirm.mutate()}>Confirm my identity</Button>}
      {confirm.error && <p role="alert" className="text-sm text-critical">{errorText(confirm.error)}</p>}
    </>}
  </Card></PageFrame>;
}
