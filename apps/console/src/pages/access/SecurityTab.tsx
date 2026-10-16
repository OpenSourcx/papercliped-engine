import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, MonitorSmartphone } from "lucide-react";
import { accessAdmin, type SessionRow } from "../../data/engine/accessAdmin.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Chip, Input, Notice, SectionTitle, Toggle } from "../../ui/primitives.tsx";
import { QueryState, Table, Td, Th, AField as Field, plural } from "./shared.tsx";

const SESSIONS = ["access", "sessions"] as const;
const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** A short, readable device name from a browser's user agent text. */
export function deviceOf(agent: string | null): string {
  if (!agent) return "Unknown device";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : /curl|python|node/i.test(agent) ? "Script" : "Browser";
  const os = /Windows/.test(agent) ? "Windows" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Mac OS X/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => accessAdmin.changeOwnPassword(current, next),
    onSuccess: (r) => {
      setCurrent("");
      setNext("");
      setAgain("");
      setError(null);
      setDone(r.otherSessionsEnded ? `Password changed. ${plural(r.otherSessionsEnded, "other session")} signed out.` : "Password changed.");
      qc.invalidateQueries({ queryKey: SESSIONS });
    },
    onError: (e) => {
      setDone(null);
      setError(errorText(e));
    },
  });
  const mismatch = again !== "" && again !== next;
  return (
    <section aria-label="Change your password">
      <SectionTitle>Change your password</SectionTitle>
      <div className="max-w-md space-y-4">
        <Field label="Current password"><Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="At least 8 characters. Your other sessions are signed out when you change it."><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="New password again" error={mismatch ? "The two don't match" : undefined}><Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></Field>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
        {done && <p role="status" className="text-compact text-good">{done}</p>}
        <Button variant="primary" loading={save.isPending} disabled={!current || next.length < 8 || next !== again} onClick={() => save.mutate()}><KeyRound className="h-4 w-4" />Change password</Button>
        <p className="text-xs text-ink-3">Passwords of directory (LDAP, Active Directory) and OpenID accounts live there, not in Proxmox, and are changed there.</p>
      </div>
    </section>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: [...SESSIONS, all], queryFn: () => accessAdmin.sessions.list(all), retry: 1, refetchInterval: 30_000 });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: SESSIONS });
  const fail = (e: unknown) => setError(errorText(e));
  const revoke = useMutation({ mutationFn: (h: string) => accessAdmin.sessions.revoke(h), onSuccess: refresh, onError: fail });
  const others = useMutation({ mutationFn: accessAdmin.sessions.revokeOthers, onSuccess: refresh, onError: fail });
  const person = useMutation({ mutationFn: (u: string) => accessAdmin.sessions.revokeUser(u), onSuccess: refresh, onError: fail });
  const mineCount = q.data?.sessions.filter((s) => s.current || !all).length ?? 0;
  const row = (s: SessionRow, showUser: boolean) => (
    <tr key={s.handle} className="border-b border-line last:border-0">
      <Td><div className="font-medium flex items-center gap-2"><MonitorSmartphone className="h-4 w-4 text-ink-3" aria-hidden />{deviceOf(s.agent)}{s.current && <Chip tone="good">This session</Chip>}</div>{showUser && <div className="text-xs text-ink-3 font-mono">{s.username}</div>}</Td>
      <Td className="text-ink-2 font-mono text-compact">{s.ip ?? "unknown"}</Td>
      <Td className="text-ink-2">{s.via === "openid" ? "OpenID Connect" : "Password"}</Td>
      <Td className="text-ink-2">{when(s.createdAt)}</Td>
      <Td className="text-ink-2">{when(s.lastSeen)}</Td>
      <Td className="text-right">
        {!s.current && <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === s.handle} onClick={() => revoke.mutate(s.handle)} aria-label={`Sign out ${deviceOf(s.agent)} from ${s.ip ?? "unknown address"}`}><LogOut className="h-4 w-4" />Sign out</Button>}
      </Td>
    </tr>
  );
  const people = [...new Set(q.data?.sessions.map((s) => s.username) ?? [])].sort();
  return (
    <section aria-label="Signed-in sessions">
      <SectionTitle action={q.data?.canManageOthers ? <label className="flex items-center gap-2 text-compact text-ink-2"><Toggle checked={all} onChange={setAll} label="Everyone's sessions" />Everyone's sessions</label> : undefined}>Where you're signed in</SectionTitle>
      <p className="text-compact text-ink-2 mb-3 max-w-2xl">Each browser or device you've signed in from. A session ends after two hours without use, or twelve hours in total. If one looks wrong, sign it out and change your password.</p>
      {error && <p role="alert" className="text-compact text-critical mb-2">{error}</p>}
      <QueryState query={q}>
        {q.data && (
          <>
            <Table min="min-w-[760px]">
              <thead><tr className="border-b border-line"><Th>Device</Th><Th>Address</Th><Th>Signed in with</Th><Th>Started</Th><Th>Last active</Th><Th /></tr></thead>
              <tbody>{q.data.sessions.map((s) => row(s, all))}</tbody>
            </Table>
            <div className="flex flex-wrap gap-2 mt-3">
              {mineCount > 1 && <Button onClick={() => others.mutate()} loading={others.isPending}><LogOut className="h-4 w-4" />Sign out everywhere else</Button>}
            </div>
            {all && people.length > 0 && (
              <div className="mt-6">
                <h3 className="text-compact font-medium mb-2">End everything for one person</h3>
                <p className="text-xs text-ink-3 mb-2">Signs them out of every browser at once, for example when a laptop is lost. Their API tokens stay until revoked or expired.</p>
                <div className="flex flex-wrap gap-2">
                  {people.filter((p) => !q.data.sessions.some((s) => s.username === p && s.current)).map((p) => <Button key={p} size="sm" loading={person.isPending && person.variables === p} onClick={() => person.mutate(p)}>Sign out {p}</Button>)}
                </div>
              </div>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}

/** Your own sign-in security: password and the places you are signed in. */
export function SecurityTab() {
  return (
    <div className="space-y-10">
      <Notice tone="info" title="Your account">Two-factor settings are on the Two-factor tab; API tokens on the API tokens tab.</Notice>
      <ChangePassword />
      <Sessions />
    </div>
  );
}
