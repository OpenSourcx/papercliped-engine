import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FeatureCtx } from "./index.ts";
import { runtimeFor, type PinRuntime } from "./pin-core.ts";
import { pushNotice } from "./pin-notify.ts";

/**
 * Update awareness. The host service reads the project's public release feed (one plain HTTPS GET from the server,
 * never from a browser; nothing about this device is sent) and shows the installed version next to the latest one. An
 * administrator can then start a guided update.
 *
 * The host service itself is unprivileged and sandboxed, so it can't install anything, and it must not be able to.
 * Instead it writes a small request file; a separate root-owned unit (deploy/epaperclip-update.*) picks it up,
 * downloads that exact release, checks its published SHA-256, and runs the installer's own staged install, which
 * test-starts the new version, swaps it in and rolls back by itself if it doesn't come up healthy. A "go back" button asks
 * the same helper to run the installer's `--rollback`. The installer is not changed in what it checks or promises.
 */

export const FEED = "https://api.github.com/repos/OpenSourcx/papercliped-engine/releases/latest";
export const RELEASE_PAGE = "https://github.com/OpenSourcx/papercliped-engine/";
const TTL_MS = 6 * 3600_000;
const MAX_FEED = 1024 * 1024;
const MAX_NOTES = 4000;
const SEMVER = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?$/;

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}
export function parseVersion(v: unknown): Version | null {
  const m = typeof v === "string" ? SEMVER.exec(v.trim()) : null;
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null } : null;
}
/** Negative when a is older than b. A pre-release is older than its release. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}
const text = (v: Version) => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}`;

export interface Latest {
  version: string;
  notes: string;
  url: string;
  publishedAt: string | null;
}
interface Cache {
  checkedAt: number;
  latest: Latest | null;
  error?: string;
}

/** The release feed's answer, reduced to what is safe to show: plain text, our own repository's links, a bounded size. */
export function readFeed(raw: string): Latest {
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (j.draft === true || j.prerelease === true) throw new Error("The newest entry in the release feed isn't a final release.");
  const v = parseVersion(j.tag_name);
  if (!v || v.pre) throw new Error("The release feed's newest version isn't one this page can read.");
  const url = typeof j.html_url === "string" && j.html_url.startsWith(RELEASE_PAGE) ? j.html_url : `${RELEASE_PAGE}releases`;
  return {
    version: text(v),
    notes: (typeof j.body === "string" ? j.body : "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, MAX_NOTES),
    url,
    publishedAt: typeof j.published_at === "string" && !Number.isNaN(Date.parse(j.published_at)) ? j.published_at : null,
  };
}

const paths = (rt: PinRuntime) => {
  const versionFile = rt.opts.update?.versionFile ?? "/opt/epaperclip/VERSION";
  const prefix = dirname(versionFile);
  return {
    versionFile,
    helper: join(rt.opts.update?.helperDir ?? join(prefix, "update"), "run.sh"),
    prev: `${prefix}.prev`,
    dir: rt.state.dir ? join(rt.state.dir, "update") : null,
  };
};

const readTrim = (f: string): string | null => {
  try {
    return readFileSync(f, "utf8").trim().slice(0, 100) || null;
  } catch {
    return null;
  }
};

/** What the helper last wrote: KEY=VALUE lines. */
export interface UpdateStatus {
  phase: string;
  message: string;
  version: string | null;
  at: number | null;
}
export function readStatus(file: string | null): UpdateStatus | null {
  if (!file) return null;
  let t: string;
  try {
    t = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const o: Record<string, string> = {};
  for (const line of t.split("\n").slice(0, 20)) {
    const i = line.indexOf("=");
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const phases = ["queued", "downloading", "verifying", "installing", "done", "failed", "rolled_back"];
  if (!phases.includes(o.phase)) return null;
  return { phase: o.phase, message: (o.message ?? "").slice(0, 400), version: parseVersion(o.version) ? o.version : null, at: Number.isFinite(Number(o.at)) ? Number(o.at) * 1000 : null };
}

const TERMINAL = new Set(["done", "failed", "rolled_back"]);

async function check(rt: PinRuntime, force: boolean): Promise<Cache> {
  const cached = rt.state.getSetting<Cache>("pin.update.cache");
  if (!force && cached && rt.now() - cached.checkedAt < TTL_MS) return cached;
  const f = rt.opts.fetch ?? ((u, i) => fetch(u, i));
  let next: Cache;
  try {
    const r = await f(rt.opts.update?.feedUrl ?? FEED, { method: "GET", headers: { Accept: "application/vnd.github+json", "User-Agent": "epaperclip-update-check" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    const body = await r.text();
    if (!r.ok) throw new Error(r.status === 404 ? "No release has been published yet." : r.status === 403 || r.status === 429 ? "The release feed is rate-limiting this address. Try again later." : `The release feed answered ${r.status}.`);
    if (body.length > MAX_FEED) throw new Error("The release feed's answer was too large.");
    next = { checkedAt: rt.now(), latest: readFeed(body) };
  } catch (e) {
    const name = (e as Error).name;
    next = { checkedAt: rt.now(), latest: cached?.latest ?? null, error: name === "TimeoutError" || name === "AbortError" ? "The release feed didn't answer within 10 seconds." : (e instanceof SyntaxError ? "The release feed's answer couldn't be read." : e instanceof TypeError ? "Couldn't reach the release feed." : (e as Error).message).slice(0, 200) };
  }
  rt.state.setSetting("pin.update.cache", next);
  return next;
}

function summary(rt: PinRuntime, cache: Cache | undefined, enabled: boolean, canManage: boolean) {
  const p = paths(rt);
  const raw = readTrim(p.versionFile);
  const installed = parseVersion(raw);
  const latest = cache?.latest ? parseVersion(cache.latest.version) : null;
  const state = !enabled ? "off" : !cache ? "unchecked" : !latest ? "unknown" : !installed ? "unknown" : compareVersions(installed, latest) < 0 ? "available" : "current";
  const helper = existsSync(p.helper);
  const status = readStatus(p.dir ? join(p.dir, "status") : null);
  const prevVersion = readTrim(join(p.prev, "VERSION"));
  return {
    installed: installed ? text(installed) : raw,
    latest: cache?.latest ?? null,
    state,
    checkedAt: cache?.checkedAt ?? null,
    error: cache?.error ?? null,
    checkEnabled: enabled,
    canManage,
    /** Whether the one-click path exists on this host: the root-owned helper from the installer, and a state folder to hand requests over in. */
    canUpdate: helper && p.dir !== null,
    previous: existsSync(p.prev) ? (prevVersion ?? "previous version") : null,
    status,
    inProgress: !!status && !TERMINAL.has(status.phase) && status.at !== null && rt.now() - status.at < 30 * 60_000,
    manual: "sudo ./deploy/install.sh (or: curl -fsSL https://github.com/OpenSourcx/papercliped-engine/releases/latest/download/get.sh | bash) from the host's shell",
  };
}

export async function updateRoutes(ctx: FeatureCtx): Promise<boolean> {
  if (!ctx.path.startsWith("/api/pin/update")) return false;
  const { HttpError, method, path } = ctx;
  const rt = runtimeFor(ctx.state);
  const s = ctx.session();
  const isAdmin = await ctx.asUser((pve) => ctx.isNodeAdmin(pve));
  const enabled = rt.state.getSetting<boolean>("pin.update.enabled") !== false;

  if (path === "/api/pin/update" && method === "GET") {
    // Looking is allowed for everyone signed in; only an administrator makes the first (or a forced) request to the feed.
    const cache = enabled ? (isAdmin ? await check(rt, false) : rt.state.getSetting<Cache>("pin.update.cache")) : undefined;
    if (cache?.latest && isAdmin) {
      const inst = parseVersion(readTrim(paths(rt).versionFile));
      const lat = parseVersion(cache.latest.version);
      if (inst && lat && compareVersions(inst, lat) < 0) pushNotice(rt, s.username, { key: `update:${cache.latest.version}`, kind: "update", level: "info", title: `ePaperclip ${cache.latest.version} is available`, body: `You have ${text(inst)}. Open Pin's Updates tab to review it.`, link: "pin?tab=updates" });
    }
    return ctx.json(200, summary(rt, cache, enabled, isAdmin)), true;
  }

  if (path === "/api/pin/update/check" && method === "POST") {
    ctx.sameSite();
    if (!isAdmin) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can check for updates");
    if (!enabled) throw new HttpError(409, "off", "Update checks are switched off.");
    return ctx.json(200, summary(rt, await check(rt, true), enabled, isAdmin)), true;
  }

  if (path === "/api/pin/update/settings" && method === "PUT") {
    ctx.sameSite();
    if (!isAdmin) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can change this");
    const b = await ctx.readJson();
    if (Object.keys(b).some((k) => k !== "check") || typeof b.check !== "boolean") throw new HttpError(400, "bad_request", "Send {check: true or false}");
    rt.state.setSetting("pin.update.enabled", b.check);
    rt.audit(s.username, "pin.update.check", undefined, b.check ? "on" : "off");
    return ctx.json(200, summary(rt, rt.state.getSetting<Cache>("pin.update.cache"), b.check, isAdmin)), true;
  }

  if (path === "/api/pin/update" && method === "POST") {
    ctx.sameSite();
    if (s.apiToken) throw new HttpError(403, "ticket_only", "Updates are started in the console, by a signed-in administrator.");
    if (!isAdmin) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can update ePaperclip");
    const b = await ctx.readJson();
    if (Object.keys(b).some((k) => k !== "action" && k !== "confirm")) throw new HttpError(400, "bad_request", "Send {action, confirm}");
    const p = paths(rt);
    const sum = summary(rt, rt.state.getSetting<Cache>("pin.update.cache"), enabled, true);
    if (!sum.canUpdate || !p.dir) throw new HttpError(409, "no_helper", "This host doesn't have the update helper. Update from the host's shell instead; the Updates tab shows the command.");
    if (sum.inProgress) throw new HttpError(409, "in_progress", "An update is already running.");
    let version: string;
    if (b.action === "update") {
      if (sum.state !== "available" || !sum.latest) throw new HttpError(409, "nothing_to_do", "There is no newer release to install. Check for updates first.");
      version = sum.latest.version;
      if (b.confirm !== `update ${version}`) throw new HttpError(409, "confirm", `Type "update ${version}" to confirm.`);
    } else if (b.action === "rollback") {
      if (!sum.previous) throw new HttpError(409, "nothing_to_do", "There is no previous version to go back to.");
      if (b.confirm !== "rollback") throw new HttpError(409, "confirm", 'Type "rollback" to confirm.');
      version = "previous";
    } else throw new HttpError(400, "bad_request", "action is update or rollback");
    if (!/^[\w.@-]{1,100}$/.test(s.username)) throw new HttpError(400, "bad_request", "This account name can't be recorded in an update request.");
    mkdirSync(p.dir, { recursive: true, mode: 0o770 });
    // Plain KEY=VALUE lines with fixed shapes, written whole then renamed, so the helper never reads half a request.
    const tmp = join(p.dir, `.request.${process.pid}.tmp`);
    writeFileSync(tmp, `action=${b.action}\nversion=${version}\nrequestedBy=${s.username}\nat=${Math.floor(rt.now() / 1000)}\n`, { mode: 0o640 });
    renameSync(tmp, join(p.dir, "request"));
    rt.audit(s.username, `pin.update.${b.action}`, undefined, version);
    return ctx.json(202, { requested: true, action: b.action, version }), true;
  }
  throw new HttpError(405, "method", "Method not allowed");
}
