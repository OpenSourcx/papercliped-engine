import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { nativeAppApi } from "../../data/engine/connectApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Card, PageFrame, PageHeader } from "../../ui/primitives.tsx";

/** No popup message can mark a connection healthy; only the engine consumes and validates OAuth state. */
export function ProviderCallback() {
  const [fields] = useState(() => Object.fromEntries(new URLSearchParams(window.location.hash.slice(1))));
  useEffect(() => { window.history.replaceState(null, "", window.location.pathname); }, []);
  const complete = useMutation({ mutationFn: () => nativeAppApi.complete(fields) });
  return <PageFrame width="3xl"><PageHeader title="Finish provider sign-in" /><Card className="p-6 space-y-4">
    {complete.isSuccess ? <p role="status">Sign-in completed. Return to the organization’s apps page to review agent access.</p> : <><p className="text-sm text-ink-2">Complete sign-in as the ePaperclip user who started this connection.</p><Button variant="primary" disabled={!fields.state || complete.isError} loading={complete.isPending} onClick={() => complete.mutate()}>Complete sign-in</Button></>}
    {complete.error && <p role="alert" className="text-sm text-critical">{errorText(complete.error)}</p>}
    {!fields.state && <p role="alert">This sign-in link is incomplete. Return to Organization apps and start again.</p>}
  </Card></PageFrame>;
}
