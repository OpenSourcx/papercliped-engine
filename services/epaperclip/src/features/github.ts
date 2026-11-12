import type { StateStore } from "../state.ts";
import type { FeatureCtx, FeatureHandler } from "./index.ts";

/**
 * Pull-request tracking (PinView's Changes). An administrator connects a GitHub token and a few repositories; everyone
 * signed in can then see those repositories' recent pull requests with their checks. The token is stored sealed, is
 * write-only (only its last four characters come back) and is sent to api.github.com and nowhere else.
 *
 *   GET    /api/github        { connected, login, last4, repos, canManage }
 *   PUT    /api/github        { token?, repos? }   administrators; a new token is checked with GitHub first
 *   POST   /api/github/device/start   sign in with GitHub (OAuth device flow): { id, userCode, verificationUri, interval, expiresIn }
 *   POST   /api/github/device/poll     { id } -> { status: "pending" | "done" | "denied" | "expired" }; on "done" the token is saved sealed
 *   DELETE /api/github        disconnect (administrators)
 *   GET    /api/github/prs    { prs, errors }      recent pull requests of the connected repositories (cached for a minute)
 */

const API = "https://api.github.com";
const SECRET = "github.token";
const SETTING = "github";
/** GitHub OAuth device flow: a person signs in on github.com and types a short code; no client secret and no pasted token. */
const OAUTH = "https://github.com";
const SCOPE = "repo read:user";
/** The OAuth app's public client id (a device-flow app registered by whoever runs this device). */
const clientId = (state: StateStore): string => (process.env.EPC_GITHUB_CLIENT_ID ?? state.getSetting<string>("githubClientId") ?? "").trim();
interface Device { deviceCode: string; user: string; expiresAt: number; nextAt: number; interval: number }
const devices = new Map<string, Device>();
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,255}$/;
const MAX_REPOS = 12;
const TTL = 60_000;

interface Record_ { login: string; last4: string; repos: string[]; updatedAt: number; updatedBy: string }

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  branch: string;
  updatedAt: string;
  url: string;
  /** The newest commit's checks: all passed, one failed, still running, or none reported. */
  checks: "success" | "failure" | "pending" | null;
}

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "epaperclip" });
const cache = new Map<string, { at: number; value: { prs: PullRequest[]; errors: { repo: string; message: string }[] } }>();

async function gh(token: string, path: string): Promise<Response> {
  return fetch(API + path, { headers: headers(token), signal: AbortSignal.timeout(10_000) });
}

function problem(status: number, text: string): string {
  if (status === 401) return "GitHub refused the token. Connect a new one.";
  if (status === 403 && /rate limit/i.test(text)) return "GitHub's rate limit was reached. Try again in a few minutes.";
  if (status === 403) return "The token can't read this repository.";
  if (status === 404) return "GitHub doesn't know this repository, or the token can't see it.";
  return `GitHub answered ${status}.`;
}

function checksOf(runs: { status?: string; conclusion?: string | null }[]): PullRequest["checks"] {
  if (runs.length === 0) return null;
  if (runs.some((r) => r.status && r.status !== "completed")) return "pending";
  if (runs.some((r) => ["failure", "cancelled", "timed_out", "action_required"].includes(r.conclusion ?? ""))) return "failure";
  return "success";
}

async function repoPrs(token: string, repo: string): Promise<PullRequest[]> {
  const r = await gh(token, `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=15`);
  const text = r.ok ? "" : await r.text();
  if (!r.ok) throw new Error(problem(r.status, text));
  const list = (await r.json()) as { number: number; title: string; state: string; draft?: boolean; merged_at?: string | null; user?: { login?: string }; head?: { ref?: string; sha?: string }; updated_at: string; html_url: string }[];
  const out: PullRequest[] = [];
  for (const p of Array.isArray(list) ? list : []) {
    // Only addresses on github.com become links.
    if (typeof p.html_url !== "string" || !p.html_url.startsWith("https://github.com/")) continue;
    const open = p.state === "open";
    let checks: PullRequest["checks"] = null;
    if (open && p.head?.sha && /^[0-9a-f]{40}$/.test(p.head.sha) && out.filter((x) => x.state === "open").length < 8) {
      const c = await gh(token, `/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=50`).catch(() => null);
      if (c?.ok) checks = checksOf(((await c.json()) as { check_runs?: { status?: string; conclusion?: string | null }[] }).check_runs ?? []);
    }
    out.push({ repo, number: p.number, title: String(p.title).slice(0, 200), state: p.merged_at ? "merged" : open ? "open" : "closed", draft: !!p.draft, author: String(p.user?.login ?? "unknown").slice(0, 60), branch: String(p.head?.ref ?? "").slice(0, 120), updatedAt: p.updated_at, url: p.html_url, checks });
  }
  return out;
}

/** The connected repositories' recent pull requests, from GitHub or from the minute-long cache. */
export async function listPullRequests(state: StateStore, now: number): Promise<{ connected: boolean; prs: PullRequest[]; errors: { repo: string; message: string }[] }> {
  const r = state.getSetting<Record_>(SETTING);
  const t = state.getSecret(SECRET);
  if (!r || !t) return { connected: false, prs: [], errors: [] };
  const stamp = `${r.updatedAt}:${r.repos.join(",")}`;
  const hit = cache.get(stamp);
  if (hit && now - hit.at < TTL) return { ...hit.value, connected: true };
  const errors: { repo: string; message: string }[] = [];
  const prs: PullRequest[] = [];
  for (const repo of r.repos) {
    try {
      prs.push(...(await repoPrs(t, repo)));
    } catch (e) {
      errors.push({ repo, message: e instanceof Error ? e.message : "GitHub didn't answer." });
    }
  }
  prs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const value = { prs, errors };
  cache.set(stamp, { at: now, value });
  return { ...value, connected: true };
}

/** Pin's read-only view of the same list, so it can answer "how are my pull requests doing". */
export const GITHUB_TOOLS = [
  {
    name: "list_pull_requests",
    description: "Recent pull requests of the GitHub repositories this device follows (PinView → Changes), with state (open, merged, closed), draft, author, branch and checks (success, failure, pending). Optionally only one repository (owner/name) or only open ones.",
    parameters: { type: "object", properties: { repo: { type: "string" }, open_only: { type: "boolean" } }, additionalProperties: false },
  },
] as const;

export async function pullRequestsTool(state: StateStore, args: Record<string, unknown>, now = Date.now()): Promise<unknown> {
  const all = await listPullRequests(state, now);
  if (!all.connected) return { connected: false, note: "GitHub isn't connected on this device. An administrator connects it in PinView → Details → Changes." };
  const repo = typeof args.repo === "string" ? args.repo.trim().toLowerCase() : "";
  const prs = all.prs.filter((p) => (!repo || p.repo.toLowerCase() === repo) && (!args.open_only || p.state === "open")).slice(0, 40);
  return { prs, errors: all.errors };
}

export const handleGithub: FeatureHandler = async (ctx: FeatureCtx) => {
  if (ctx.path !== "/api/github" && ctx.path !== "/api/github/prs" && ctx.path !== "/api/github/device/start" && ctx.path !== "/api/github/device/poll") return false;
  const { HttpError, method, state } = ctx;
  const s = ctx.session();
  if (s.apiToken) throw new HttpError(403, "ticket_only", "GitHub is connected in the console by a signed-in administrator.");
  const rec = () => state.getSetting<Record_>(SETTING);
  const token = () => state.getSecret(SECRET);

  if (ctx.path === "/api/github/prs") {
    if (method !== "GET") throw new HttpError(405, "method", "Method not allowed");
    return ctx.json(200, await listPullRequests(state, ctx.now())), true;
  }

  const isAdmin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));

  if (ctx.path === "/api/github/device/start" || ctx.path === "/api/github/device/poll") {
    if (method !== "POST") throw new HttpError(405, "method", "Method not allowed");
    ctx.sameSite();
    if (!isAdmin) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can connect GitHub.");
    const cid = clientId(state);
    if (!cid) throw new HttpError(409, "oauth_not_configured", "Signing in with GitHub isn't set up on this device yet: it needs a GitHub OAuth app with device flow turned on (docs/GITHUB-OAUTH.md). You can paste a token instead.");
    const form = (o: Record<string, string>) => ({ method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "epaperclip" }, body: new URLSearchParams(o).toString(), signal: AbortSignal.timeout(10_000) });
    for (const [k, d] of devices) if (d.expiresAt < ctx.now()) devices.delete(k);
    if (ctx.path === "/api/github/device/start") {
      const r = await fetch(`${OAUTH}/login/device/code`, form({ client_id: cid, scope: SCOPE })).catch(() => null);
      if (!r) throw new HttpError(502, "github_unreachable", "GitHub didn't answer. Check the host's internet access and try again.");
      const j = (await r.json().catch(() => ({}))) as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string };
      if (!r.ok || !j.device_code || !j.user_code || !j.verification_uri) throw new HttpError(502, "github_refused", `GitHub refused the sign-in${j.error_description ? `: ${j.error_description}` : j.error ? `: ${j.error}` : ""}. Check that the OAuth app has device flow turned on.`);
      const id = `dv_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const interval = Math.max(5, Number(j.interval) || 5);
      devices.set(id, { deviceCode: j.device_code, user: s.username, expiresAt: ctx.now() + Math.min(900, Number(j.expires_in) || 900) * 1000, nextAt: 0, interval });
      return ctx.json(200, { id, userCode: j.user_code, verificationUri: /^https:\/\/github\.com\//.test(j.verification_uri) ? j.verification_uri : "https://github.com/login/device", interval, expiresIn: Math.min(900, Number(j.expires_in) || 900) }), true;
    }
    const b = await ctx.readJson(1024);
    const d = typeof b.id === "string" ? devices.get(b.id) : undefined;
    if (!d || d.user !== s.username) throw new HttpError(404, "not_found", "That sign-in isn't running any more. Start again.");
    if (d.expiresAt < ctx.now()) { devices.delete(b.id as string); return ctx.json(200, { status: "expired" }), true; }
    if (ctx.now() < d.nextAt) return ctx.json(200, { status: "pending" }), true;
    d.nextAt = ctx.now() + d.interval * 1000;
    const r = await fetch(`${OAUTH}/login/oauth/access_token`, form({ client_id: cid, device_code: d.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })).catch(() => null);
    if (!r) return ctx.json(200, { status: "pending" }), true;
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string; interval?: number };
    if (j.error === "slow_down") { d.interval = Math.max(d.interval + 5, Number(j.interval) || 0); return ctx.json(200, { status: "pending" }), true; }
    if (j.error === "authorization_pending") return ctx.json(200, { status: "pending" }), true;
    if (j.error === "access_denied") { devices.delete(b.id as string); return ctx.json(200, { status: "denied" }), true; }
    if (j.error === "expired_token") { devices.delete(b.id as string); return ctx.json(200, { status: "expired" }), true; }
    if (!j.access_token || !TOKEN.test(j.access_token)) throw new HttpError(502, "github_refused", "GitHub answered, but not with a token. Start again.");
    const t = j.access_token;
    const me = await gh(t, "/user").catch(() => null);
    if (!me || !me.ok) throw new HttpError(502, "github_refused", "GitHub gave a token it then refused. Start again.");
    const login = String(((await me.json()) as { login?: string }).login ?? "").slice(0, 60);
    devices.delete(b.id as string);
    state.setSecret(SECRET, t);
    const cur = rec();
    state.setSetting(SETTING, { login, last4: t.slice(-4), repos: cur?.repos ?? [], updatedAt: ctx.now(), updatedBy: s.username } satisfies Record_);
    cache.clear();
    return ctx.json(200, { status: "done", login }), true;
  }

  if (method === "GET") {
    const r = rec();
    return ctx.json(200, { connected: !!r && token() !== null, login: r?.login ?? null, last4: r?.last4 ?? null, repos: r?.repos ?? [], canManage: isAdmin, oauth: clientId(state) !== "" }), true;
  }
  if (method !== "PUT" && method !== "DELETE") throw new HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  if (!isAdmin) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can connect GitHub.");

  if (method === "DELETE") {
    state.deleteSecret(SECRET);
    state.setSetting(SETTING, null);
    cache.clear();
    return ctx.json(200, { connected: false, login: null, last4: null, repos: [], canManage: true }), true;
  }

  const body = await ctx.readJson(4096);
  const current = rec();
  let login = current?.login ?? "";
  let last4 = current?.last4 ?? "";
  if (body.token !== undefined && body.token !== "") {
    if (typeof body.token !== "string" || !TOKEN.test(body.token.trim())) throw new HttpError(400, "bad_request", "That doesn't look like a GitHub token.");
    const t = body.token.trim();
    const r = await gh(t, "/user").catch(() => null);
    if (!r) throw new HttpError(502, "github_unreachable", "GitHub didn't answer. Check the host's internet access and try again.");
    if (!r.ok) throw new HttpError(400, "bad_token", problem(r.status, await r.text()));
    login = String(((await r.json()) as { login?: string }).login ?? "").slice(0, 60);
    last4 = t.slice(-4);
    state.setSecret(SECRET, t);
  } else if (!current || token() === null) {
    throw new HttpError(400, "bad_request", "Paste a GitHub token to connect.");
  }
  let repos = current?.repos ?? [];
  if (body.repos !== undefined) {
    if (!Array.isArray(body.repos) || body.repos.length > MAX_REPOS || !body.repos.every((x) => typeof x === "string" && REPO.test(x.trim()))) throw new HttpError(400, "bad_request", `Repositories are written owner/name, up to ${MAX_REPOS}.`);
    repos = [...new Set(body.repos.map((x: string) => x.trim()))];
  }
  state.setSetting(SETTING, { login, last4, repos, updatedAt: ctx.now(), updatedBy: s.username } satisfies Record_);
  cache.clear();
  return ctx.json(200, { connected: true, login, last4, repos, canManage: true }), true;
};
