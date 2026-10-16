import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessAdmin } from "../../data/engine/accessAdmin.ts";
import { Chip, Input, Notice, SectionTitle } from "../../ui/primitives.tsx";
import { QueryState, Table, Td, Th, useIac, AField as Field } from "./shared.tsx";

const WHO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,31}(![A-Za-z][A-Za-z0-9._-]{1,63})?$/;

/** Everything one user or API token can do, path by path, and which role and group each privilege comes from. */
export function ExplorerTab() {
  const iacQ = useIac();
  const [who, setWho] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["access", "explorer", asked], queryFn: () => accessAdmin.explore(asked!), enabled: !!asked, retry: 0 });
  return (
    <div>
      <SectionTitle>Effective permissions</SectionTitle>
      <p className="text-compact text-ink-2 mb-3 max-w-2xl">Pick a user or an API token to see every permission they hold: the entries that give it (their own, their groups', inheritance), and what they add up to on each path.</p>
      <form className="flex gap-3 items-end mb-5 max-w-xl" onSubmit={(e) => { e.preventDefault(); if (WHO.test(who)) setAsked(who); }}>
        <Field label="User or API token" className="flex-1">
          <Input list="explore-who" value={who} onChange={(e) => setWho(e.target.value.trim())} placeholder="sam@pve or sam@pve!ci" className="font-mono" spellCheck={false} />
          <datalist id="explore-who">{(iacQ.data?.users ?? []).map((u) => <option key={u.userid} value={u.userid} />)}</datalist>
        </Field>
        <button type="submit" disabled={!WHO.test(who)} className="h-10 px-4 rounded-full bg-primary text-primary-ink text-sm font-medium disabled:bg-surface-3 disabled:text-ink-3">Explore</button>
      </form>
      {asked && (
        <QueryState query={q}>
          {q.data && (
            <div className="space-y-8">
              {q.data.note && <Notice tone="warning" title="Separate privileges">{q.data.note}</Notice>}
              <section aria-label="Entries">
                <h3 className="text-compact font-medium mb-2">Entries that apply to {q.data.userid}{q.data.groups.length ? ` (in ${q.data.groups.join(", ")})` : ""}</h3>
                {q.data.entries.length === 0 ? <p className="text-compact text-ink-3">Nothing is granted to them directly, through a group, or by their token.</p> : (
                  <Table min="min-w-[560px]">
                    <thead><tr className="border-b border-line"><Th>Path</Th><Th>Role</Th><Th>Applies below</Th><Th>Comes from</Th></tr></thead>
                    <tbody>{q.data.entries.map((e) => <tr key={`${e.path}${e.role}${e.source}`} className="border-b border-line last:border-0"><Td className="font-mono text-compact">{e.path}</Td><Td><Chip tone="accent">{e.role}</Chip></Td><Td className="text-ink-2">{e.propagate ? "Yes" : "No"}</Td><Td className="text-ink-2">{e.source}</Td></tr>)}</tbody>
                  </Table>
                )}
              </section>
              <section aria-label="What it adds up to">
                <h3 className="text-compact font-medium mb-2">What it adds up to</h3>
                {q.data.effective.length === 0 ? <p className="text-compact text-ink-3">No privileges anywhere.</p> : (
                  <div className="rounded-xl border border-line divide-y divide-line">
                    {q.data.effective.map((e) => (
                      <div key={e.path} className="px-4 py-3">
                        <button type="button" className="w-full flex items-center justify-between gap-3 text-left" aria-expanded={open === e.path} onClick={() => setOpen(open === e.path ? null : e.path)}>
                          <span className="font-mono text-compact">{e.path}</span>
                          <span className="text-compact text-ink-3">{e.privileges.length} privileges</span>
                        </button>
                        {open === e.path && (
                          <ul className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-1">
                            {e.privileges.map((p) => (
                              <li key={p} className="text-compact"><span className="font-mono">{p}</span><span className="block text-xs text-ink-3">{e.grants[p]?.map((g) => `${g.role} on ${g.at} (${g.source})`).join("; ") || "from Proxmox's own rules"}</span></li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </QueryState>
      )}
    </div>
  );
}
