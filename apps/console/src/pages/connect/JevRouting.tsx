import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Route } from "lucide-react";
import { connectApi, type JevSettingsView } from "../../data/engine/connectApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Card, Field, Input, Notice, SectionTitle, Toggle } from "../../ui/primitives.tsx";

/**
 * Optional Jev task routing for one organization (docs/CONNECTORS.md, "Task routing with Jev"). The organization brings
 * its own TypeSafe API key; the key is sealed on this device and never shown again. Turning Jev on is a separate, explicit
 * choice that says what is sent. Without it, tasks are routed by built-in rules on this device.
 */
export function JevRouting({ companyId, orgName }: { companyId: string; orgName: string }) {
  const qc = useQueryClient();
  const KEY = ["task-router", "jev", companyId] as const;
  const q = useQuery({ queryKey: KEY, queryFn: () => connectApi.jev(companyId), retry: 1 });
  const [key, setKey] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const done = (v: JevSettingsView) => { qc.setQueryData(KEY, v); setNote(null); };
  const fail = (e: unknown) => setNote({ ok: false, text: errorText(e) });
  const save = useMutation({ mutationFn: (k: string) => connectApi.setJevKey(companyId, k), onSuccess: (v) => { done(v); setKey(""); }, onError: fail });
  const remove = useMutation({ mutationFn: () => connectApi.removeJevKey(companyId), onSuccess: done, onError: fail });
  const set = useMutation({ mutationFn: (b: { enabled?: boolean; consentSendTaskText?: boolean }) => connectApi.setJev(companyId, b), onSuccess: done, onError: fail });
  const test = useMutation({ mutationFn: () => connectApi.testJev(companyId), onSuccess: () => setNote({ ok: true, text: "TypeSafe accepted the key." }), onError: fail });
  const v = q.data;
  const submit = (e: FormEvent) => { e.preventDefault(); if (key.trim()) save.mutate(key.trim()); };

  return (
    <section className="mt-8">
      <SectionTitle>Task routing for {orgName}</SectionTitle>
      <Card className="p-5 space-y-4">
        <div className="flex items-center gap-2"><Route className="h-4 w-4 text-ink-3" aria-hidden /><h3 className="text-sm font-semibold">{v?.card?.title ?? "Jev task routing (TypeSafe)"}</h3></div>
        <p className="text-compact text-ink-2 text-pretty">{v?.card?.summary ?? "Use TypeSafe's Jev model to decide which AI model should do each task."} It is optional and off until you turn it on.</p>
        {q.isPending && <p className="text-sm text-ink-3">Loading…</p>}
        {q.error && <p role="alert" className="text-compact text-critical">{errorText(q.error)}</p>}
        {v && (
          <>
            <Notice title="What is sent to TypeSafe">{v.disclosure}</Notice>
            <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
              <Field label={v.card?.keyLabel ?? "TypeSafe API key"} hint={v.hasKey ? "A key is saved and sealed on this device. Paste a new one to replace it." : "Your own key from TypeSafe. It is stored on this device only and never shown again."} htmlFor="jev-key" className="flex-1 min-w-[16rem]">
                <Input id="jev-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={v.hasKey ? "••••••••" : "Paste your key"} />
              </Field>
              <Button type="submit" loading={save.isPending} disabled={!key.trim()}><KeyRound className="h-4 w-4" aria-hidden />{v.hasKey ? "Replace key" : "Save key"}</Button>
              {v.hasKey && <Button type="button" variant="ghost" loading={test.isPending} onClick={() => test.mutate()}>Test key</Button>}
              {v.hasKey && <Button type="button" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>Remove key</Button>}
            </form>
            <label className="flex items-start gap-2 text-compact text-ink-2">
              <input type="checkbox" className="mt-1" checked={v.consentSendTaskText} disabled={set.isPending} onChange={(e) => set.mutate({ consentSendTaskText: e.target.checked })} />
              <span>{v.card?.consentLabel ?? "I understand task text is sent to TypeSafe"}</span>
            </label>
            <div className="flex items-center gap-3">
              <Toggle checked={v.enabled} onChange={(on) => set.mutate({ enabled: on })} label={v.card?.switchLabel ?? "Route my organization's tasks with Jev"} disabled={set.isPending || (!v.enabled && !(v.hasKey && v.consentSendTaskText))} />
              <span className="text-sm">{v.card?.switchLabel ?? "Route my organization's tasks with Jev"}</span>
              <span className="text-xs text-ink-3">{v.active ? "On" : v.hasKey && v.consentSendTaskText ? "Off" : "Needs a key and your confirmation"}</span>
            </div>
          </>
        )}
        {note && <p role={note.ok ? "status" : "alert"} className={note.ok ? "text-compact text-good" : "text-compact text-critical"}>{note.text}</p>}
      </Card>
    </section>
  );
}
