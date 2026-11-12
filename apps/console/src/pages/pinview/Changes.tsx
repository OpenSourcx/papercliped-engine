import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDot, CircleX, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, Loader2 } from "lucide-react";
import { githubApi, type GithubStatus, type PullRequest } from "../../data/engine/githubApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { useEngine } from "../../data/store.tsx";
import { httpUrl } from "../../lib/safeUrl.ts";
import { cn } from "../../lib/storage.ts";
import { Button, Field, Input, Textarea } from "../../ui/primitives.tsx";

/**
 * Changes: the pull requests of the GitHub repositories this device follows, with their checks. An administrator
 * connects a token and picks repositories right here; everyone signed in then sees the list. GitHub is asked at most once
 * a minute (the host caches the answer).
 */

const STATUS_KEY = ["github", "status"] as const;
const PRS_KEY = ["github", "prs"] as const;

export function useGithub() {
  const { live } = useEngine();
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: githubApi.status, enabled: live, retry: false, staleTime: 60_000 });
  const prs = useQuery({ queryKey: PRS_KEY, queryFn: githubApi.prs, enabled: !!status.data?.connected, retry: false, refetchInterval: 60_000 });
  return { status, prs };
}

const parseRepos = (text: string) => text.split(/[\s,]+/).map((r) => r.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "")).filter(Boolean);

/** Sign in with GitHub: a short code to type at github.com, no token to paste. Polls until the person approves. */
function GithubSignIn({ onDone }: { onDone: () => void }) {
  const [dev, setDev] = useState<{ id: string; userCode: string; verificationUri: string; interval: number } | null>(null);
  const [state, setState] = useState<"idle" | "waiting" | "denied" | "expired">("idle");
  const start = useMutation({ mutationFn: () => githubApi.deviceStart(), onSuccess: (d) => { setDev(d); setState("waiting"); } });
  useEffect(() => {
    if (!dev || state !== "waiting") return;
    const t = setInterval(() => {
      githubApi.devicePoll(dev.id).then((r) => {
        if (r.status === "done") { setDev(null); setState("idle"); onDone(); }
        else if (r.status === "denied" || r.status === "expired") { setDev(null); setState(r.status); }
      }, () => undefined);
    }, Math.max(5, dev.interval) * 1000);
    return () => clearInterval(t);
  }, [dev, state, onDone]);
  return (
    <div className="space-y-2" aria-live="polite">
      {state !== "waiting" && <Button type="button" variant="primary" size="sm" loading={start.isPending} onClick={() => start.mutate()}>Connect with GitHub</Button>}
      {state === "waiting" && dev && (
        <div className="rounded-lg border border-line p-3 space-y-1.5">
          <div className="text-compact font-medium">1. Open <a className="text-accent" href={dev.verificationUri} target="_blank" rel="noopener noreferrer">{new URL(dev.verificationUri).host}/login/device</a></div>
          <div className="text-compact font-medium">2. Enter this code</div>
          <div className="font-mono text-title tracking-code select-all">{dev.userCode}</div>
          <p className="text-xs text-ink-3">This page notices when you approve. Nothing is pasted, and the token never appears here.</p>
        </div>
      )}
      {state === "denied" && <p role="alert" className="text-compact text-critical">GitHub says you declined. You can start again.</p>}
      {state === "expired" && <p role="alert" className="text-compact text-critical">The code ran out. Start again.</p>}
      {start.error && <p role="alert" className="text-compact text-critical">{errorText(start.error)}</p>}
    </div>
  );
}

/** Connect GitHub, or change the token or the repositories. A blank token keeps the saved one. */
export function ConnectGithub({ status, onDone }: { status: GithubStatus | undefined; onDone?: () => void }) {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [repos, setRepos] = useState((status?.repos ?? []).join("\n"));
  const save = useMutation({
    mutationFn: () => githubApi.connect({ ...(token.trim() ? { token: token.trim() } : {}), repos: parseRepos(repos) }),
    onSuccess: (s) => { qc.setQueryData(STATUS_KEY, s); void qc.invalidateQueries({ queryKey: PRS_KEY }); setToken(""); onDone?.(); },
  });
  const ready = (status?.connected || token.trim()) && parseRepos(repos).length > 0;
  const viaGithub = !!status?.oauth && !status?.connected;
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(); }}>
      {viaGithub && <GithubSignIn onDone={() => { void qc.invalidateQueries({ queryKey: STATUS_KEY }); }} />}
      {!viaGithub && (
        <Field label={status?.connected ? `Connected${status.login ? ` as ${status.login}` : ""} (ending ${status.last4}). Paste a token to replace it, or leave blank to keep it` : "GitHub token"} htmlFor="gh-token" hint={status?.connected ? undefined : "Signing in with GitHub isn't set up on this device, so paste a fine-grained token with read access to pull requests and checks."}>
          <Input id="gh-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" />
        </Field>
      )}
      <Field label="Repositories" htmlFor="gh-repos" hint="owner/name, one per line, up to 12.">
        <Textarea id="gh-repos" rows={3} spellCheck={false} value={repos} onChange={(e) => setRepos(e.target.value)} className="font-mono" placeholder="opensourcx/papercliped-engine" />
      </Field>
      {save.error && <p role="alert" className="text-compact text-critical">{errorText(save.error)}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!ready} loading={save.isPending}>{status?.connected ? "Save" : "Connect GitHub"}</Button>
        {onDone && status?.connected && <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>}
      </div>
    </form>
  );
}

const ICON = {
  open: <GitPullRequest className="h-4 w-4 text-good" aria-label="Open" />,
  merged: <GitMerge className="h-4 w-4 text-accent" aria-label="Merged" />,
  closed: <GitPullRequestClosed className="h-4 w-4 text-ink-3" aria-label="Closed" />,
};
const CHECKS = {
  success: <CircleCheck className="h-3.5 w-3.5 text-good" aria-label="Checks passed" />,
  failure: <CircleX className="h-3.5 w-3.5 text-critical" aria-label="Checks failed" />,
  pending: <CircleDot className="h-3.5 w-3.5 text-warning" aria-label="Checks running" />,
};
const age = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

/** One pull request per line: state, title, where it lives, its checks, and a link out to GitHub. */
export function PullRequestList({ prs, limit }: { prs: PullRequest[]; limit?: number }) {
  const shown = limit ? prs.slice(0, limit) : prs;
  return (
    <ul className="space-y-0.5 -mx-1">
      {shown.map((p) => {
        return (
          <li key={`${p.repo}#${p.number}`}>
            <a href={httpUrl(p.url) ?? undefined} target="_blank" rel="noopener noreferrer" className="transition-control group flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
              <span className="mt-0.5 shrink-0">{ICON[p.state]}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5"><span className={cn("text-compact truncate", p.draft && "text-ink-3")}>{p.title}</span>{p.checks && <span className="shrink-0">{CHECKS[p.checks]}</span>}</span>
                <span className="block text-xs text-ink-3 truncate">{p.repo}#{p.number} · {p.author} · {age(p.updatedAt)}{p.draft ? " · draft" : ""}</span>
              </span>
              <ExternalLink className="h-3.5 w-3.5 mt-1 text-ink-3 opacity-0 group-hover:opacity-100 shrink-0" aria-hidden />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** The Changes card: a one-line summary and the newest pull requests, or the way to connect GitHub. */
export function ChangesBody({ onShowAll, editing, onEdited }: { onShowAll: () => void; editing: boolean; onEdited: () => void }) {
  const { status, prs } = useGithub();
  const { live } = useEngine();
  if (!live) return <p className="text-compact text-ink-3 text-pretty">On a device, an administrator connects GitHub here and the pull requests of the repositories you follow show with their checks.</p>;
  if (status.isPending) return <p className="text-compact text-ink-3 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Checking GitHub…</p>;
  if (status.error) return <p className="text-compact text-ink-3">{errorText(status.error)}</p>;
  const s = status.data!;
  if (!s.connected || editing) {
    if (!s.canManage) return <p className="text-compact text-ink-3 text-pretty">Pull requests show here once a Proxmox administrator connects GitHub.</p>;
    return (
      <>
        {!s.connected && <p className="text-compact text-ink-2 text-pretty">Follow your repositories' pull requests and their checks here, next to your conversations.</p>}
        <ConnectGithub status={s} onDone={editing ? onEdited : undefined} />
      </>
    );
  }
  if (prs.isPending) return <p className="text-compact text-ink-3 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Loading pull requests…</p>;
  const list = prs.data?.prs ?? [];
  const open = list.filter((p) => p.state === "open");
  const failing = open.filter((p) => p.checks === "failure").length;
  return (
    <>
      <p className="text-compact text-ink-2">{open.length} open{failing ? <span className="text-critical"> · {failing} failing</span> : ""} · {s.repos.length} repositor{s.repos.length === 1 ? "y" : "ies"}{s.login ? <span className="text-ink-3"> · as {s.login}</span> : null}</p>
      {(prs.data?.errors ?? []).map((e) => <p key={e.repo} className="text-xs text-warning"><span className="font-mono">{e.repo}</span>: {e.message}</p>)}
      {prs.error && <p className="text-xs text-warning">{errorText(prs.error)}</p>}
      {list.length === 0 ? <p className="text-compact text-ink-3">No pull requests yet.</p> : <PullRequestList prs={list} limit={5} />}
      {list.length > 5 && <button type="button" onClick={onShowAll} className="text-compact text-accent hover:underline">Show all {list.length}</button>}
    </>
  );
}
