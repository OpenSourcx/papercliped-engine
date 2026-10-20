import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FeatureCtx } from "./index.ts";
import { runtimeFor, type PinRuntime } from "./pin-core.ts";
import { pushNotice } from "./pin-notify.ts";
import { aptHistory, kernelState } from "./pin-update-system.ts";
import { applyPolicy, failedBefore, inWindow, isPaused, isSnoozed, nextWindow, readHistory, readPolicy, setPending, syncHistory, watch, watchers } from "./pin-update-policy.ts";

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

/**
 * The signed update feed: every release with its channel, notes and whether it was withdrawn, signed with the release key
 * that every installation pins. It is what lets a bad release be pulled; GitHub's own list is the fallback.
 */
export const SIGNED_FEED = "https://opensourcx.github.io/papercliped-engine/updates/feed.json";

/** Every published release, newest first, so the final releases and the release candidates come from one request. */
export const FEED = "https://api.github.com/repos/OpenSourcx/papercliped-engine/releases?per_page=30";
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
/** Which releases a device follows: only final ones, or release candidates too. */
export type Channel = "stable" | "rc";
export interface Release extends Latest {
  channel: Channel;
  /** Set (with the reason) when the project pulled this release; it is never offered and a device running it is told to move on. */
  withdrawn?: string;
}
interface Cache {
  checkedAt: number;
  /** Newest first. Empty when nothing has been published. */
  releases: Release[];
  /** Where the list came from. */
  source?: "feed" | "github";
  /** Set when the signed feed was ignored, and why. */
  feedNote?: string;
  error?: string;
}

const cleanNotes = (v: unknown) => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, MAX_NOTES);

/** One feed entry, reduced to what is safe to show: plain text, our own repository's links, a bounded size. Null when it isn't a published release we can read. */
function readEntry(j: Record<string, unknown>): Release | null {
  if (j.draft === true) return null;
  const v = parseVersion(j.tag_name);
  if (!v) return null;
  const url = typeof j.html_url === "string" && j.html_url.startsWith(RELEASE_PAGE) ? j.html_url : `${RELEASE_PAGE}releases`;
  return {
    version: text(v),
    channel: j.prerelease === true || v.pre ? "rc" : "stable",
    notes: cleanNotes(j.body),
    url,
    publishedAt: typeof j.published_at === "string" && !Number.isNaN(Date.parse(j.published_at)) ? j.published_at : null,
  };
}

/** The feed's answer: a list of releases (GitHub's list), or one release object. Newest first; unreadable entries are skipped. */
export function readReleases(raw: string): Release[] {
  const j = JSON.parse(raw) as unknown;
  const entries = Array.isArray(j) ? j : j && typeof j === "object" ? [j] : [];
  const out: Release[] = [];
  for (const e of entries.slice(0, 100)) {
    const r = e && typeof e === "object" ? readEntry(e as Record<string, unknown>) : null;
    if (r) out.push(r);
  }
  return out.sort((a, b) => compareVersions(parseVersion(b.version)!, parseVersion(a.version)!));
}

/** The newest final release in a feed answer. Throws when there is none. */
export function readFeed(raw: string): Latest {
  const r = readReleases(raw).find((x) => x.channel === "stable");
  if (!r) throw new Error("The newest entry in the release feed isn't a final release.");
  const { channel: _channel, ...latest } = r;
  return latest;
}

/** The release a channel offers: the newest final release, or for release candidates the newest of everything. */
export function offered(releases: Release[], channel: Channel): Release | null {
  const live = releases.filter((r) => !r.withdrawn);
  return (channel === "rc" ? live : live.filter((r) => r.channel === "stable"))[0] ?? null;
}

/** The signed feed's answer, after its signature checked out: reduced to our own Release shape. Channels are decided here, not taken on trust. */
export function readSignedFeed(raw: string): Release[] {
  const j = JSON.parse(raw) as { format?: unknown; releases?: unknown };
  if (j.format !== 1 || !Array.isArray(j.releases)) throw new Error("The update feed isn't in a format this version understands.");
  const out: Release[] = [];
  for (const e of j.releases.slice(0, 100)) {
    const o = e && typeof e === "object" ? (e as Record<string, unknown>) : null;
    if (!o) continue;
    const r = readEntry({ tag_name: o.version, body: o.notes, html_url: o.url, published_at: o.publishedAt, prerelease: false, draft: false });
    if (!r) continue;
    if (o.withdrawn === true) r.withdrawn = (typeof o.withdrawnReason === "string" ? o.withdrawnReason : "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "This release was withdrawn.";
    out.push(r);
  }
  return out.sort((a, b) => compareVersions(parseVersion(b.version)!, parseVersion(a.version)!));
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

/** Reads the signed feed and checks it against the release key installed with this version (root's copy, not anything downloaded). */
async function readSigned(rt: PinRuntime, f: NonNullable<PinRuntime["opts"]["fetch"]>, url: string): Promise<Release[]> {
  const keyFile = rt.opts.update?.pubKeyFile ?? join(dirname(paths(rt).versionFile), "update", "release-signing.pub");
  let pem: string;
  try {
    pem = readFileSync(keyFile, "utf8");
  } catch {
    throw new Error("This device has no release key pinned, so the signed feed can't be checked.");
  }
  const get = async (u: string) => {
    const r = await f(u, { method: "GET", headers: { Accept: "application/json", "User-Agent": "epaperclip-update-check" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!r.ok) throw new Error(`The update feed answered ${r.status}.`);
    const t = await r.text();
    if (t.length > MAX_FEED) throw new Error("The update feed's answer was too large.");
    return t;
  };
  const [body, sig] = await Promise.all([get(url), get(url.replace(/feed\.json$/, "feed.sig"))]);
  let ok = false;
  try {
    ok = verify(null, Buffer.from(body), createPublicKey(pem), Buffer.from(sig.trim(), "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("The update feed's signature didn't check out, so it was ignored.");
  return readSignedFeed(body);
}

export async function check(rt: PinRuntime, force: boolean): Promise<Cache> {
  const cached = rt.state.getSetting<Cache & { latest?: unknown }>("pin.update.cache");
  const usable = cached && Array.isArray(cached.releases) ? cached : undefined;
  if (!force && usable && rt.now() - usable.checkedAt < TTL_MS) return usable;
  const f = rt.opts.fetch ?? ((u, i) => fetch(u, i));
  let next: Cache;
  // The signed feed first, when this device uses the project's own feed (a different feed address is read as GitHub's list).
  let feedNote: string | undefined;
  const signedUrl = rt.opts.update?.signedFeedUrl ?? (rt.opts.update?.feedUrl ? null : SIGNED_FEED);
  if (signedUrl) {
    try {
      const releases = await readSigned(rt, f, signedUrl);
      next = { checkedAt: rt.now(), releases: releases.slice(0, 60), source: "feed" };
      rt.state.setSetting("pin.update.cache", next);
      return next;
    } catch (e) {
      const m = (e as Error).message;
      // An unreachable feed is ordinary; a feed that fails its signature is worth saying.
      if (/signature|format|key/i.test(m)) feedNote = m.slice(0, 200);
    }
  }
  try {
    const r = await f(rt.opts.update?.feedUrl ?? FEED, { method: "GET", headers: { Accept: "application/vnd.github+json", "User-Agent": "epaperclip-update-check" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    const body = await r.text();
    if (!r.ok) throw new Error(r.status === 404 ? "The release feed wasn't found (404)." : r.status === 403 || r.status === 429 ? "The release feed is rate-limiting this address. Try again later." : `The release feed answered ${r.status}.`);
    if (body.length > MAX_FEED) throw new Error("The release feed's answer was too large.");
    next = { checkedAt: rt.now(), releases: readReleases(body).slice(0, 30), source: "github", ...(feedNote ? { feedNote } : {}) };
  } catch (e) {
    const name = (e as Error).name;
    next = { checkedAt: rt.now(), releases: usable?.releases ?? [], ...(feedNote ? { feedNote } : {}), error: name === "TimeoutError" || name === "AbortError" ? "The release feed didn't answer within 10 seconds." : (e instanceof SyntaxError ? "The release feed's answer couldn't be read." : e instanceof TypeError ? "Couldn't reach the release feed." : (e as Error).message).slice(0, 300) };
  }
  rt.state.setSetting("pin.update.cache", next);
  return next;
}

/** Following release candidates is opt-in, but a device already on one follows them until told otherwise. */
function channelOf(rt: PinRuntime, installed: Version | null): Channel {
  const set = rt.state.getSetting<string>("pin.update.channel");
  return set === "stable" || set === "rc" ? set : installed?.pre ? "rc" : "stable";
}

export function summary(rt: PinRuntime, cache: Cache | undefined, enabled: boolean, canManage: boolean) {
  const p = paths(rt);
  const raw = readTrim(p.versionFile);
  const installed = parseVersion(raw);
  const channel = channelOf(rt, installed);
  const releases = cache && Array.isArray(cache.releases) ? cache.releases : [];
  const latest = offered(releases, channel);
  const latestV = latest ? parseVersion(latest.version) : null;
  // "Nothing final yet" and "nothing at all" are facts about the project, not failures of the feed.
  const state = !enabled ? "off" : !cache ? "unchecked" : cache.error && !latest ? "unknown" : !latest ? (releases.length ? "no_stable" : "no_release") : !installed || !latestV ? "unknown" : compareVersions(installed, latestV) < 0 ? "available" : "current";
  const helper = existsSync(p.helper);
  const status = readStatus(p.dir ? join(p.dir, "status") : null);
  const prevVersion = readTrim(join(p.prev, "VERSION"));
  // A newer release candidate than what this device is on, for a device that follows final releases only.
  const preview = channel === "stable" ? offered(releases, "rc") : null;
  const previewV = preview ? parseVersion(preview.version) : null;
  const policy = readPolicy(rt);
  const now = rt.now();
  return {
    policy,
    /** Whether Proxmox has installed a kernel that isn't running yet: a restart is needed to finish updating. */
    system: kernelState(rt),
    paused: isPaused(policy, now),
    snoozed: isSnoozed(policy, now),
    /** When the maintenance window next opens, for devices set to install by themselves. */
    nextWindowAt: policy.mode === "window" ? nextWindow(policy, now) : null,
    installed: installed ? text(installed) : raw,
    channel,
    latest: latest ? { version: latest.version, notes: latest.notes, url: latest.url, publishedAt: latest.publishedAt } : null,
    preview: preview && previewV && preview.channel === "rc" && (!installed || compareVersions(installed, previewV) < 0) ? { version: preview.version, publishedAt: preview.publishedAt } : null,
    state,
    source: cache?.source ?? null,
    feedNote: cache?.feedNote ?? null,
    /** The project pulled the release this device is running: it should move on. */
    installedWithdrawn: installed ? (releases.find((r) => r.version === text(installed) && r.withdrawn)?.withdrawn ?? null) : null,
    checkedAt: cache?.checkedAt ?? null,
    error: cache?.error ?? null,
    checkEnabled: enabled,
    canManage,
    /** Whether the one-click path exists on this host: the root-owned helper from the installer, and a state folder to hand requests over in. */
    canUpdate: helper && p.dir !== null,
    previous: existsSync(p.prev) ? (prevVersion ?? "previous version") : null,
    status,
    inProgress: !!status && !TERMINAL.has(status.phase) && status.at !== null && rt.now() - status.at < 30 * 60_000,
    manual: "epaperclip update, as root in the host's shell (or: curl -fsSL https://github.com/OpenSourcx/papercliped-engine/releases/latest/download/get.sh | bash)",
  };
}

/** Leaves the root helper a request. Plain KEY=VALUE lines with fixed shapes, written whole then renamed, so it never reads half of one. */
export function writeRequest(rt: PinRuntime, r: { action: "update" | "rollback"; version: string; by: string; from: string | null; previous?: string | null }) {
  const p = paths(rt);
  if (!p.dir) throw new Error("There is no folder to leave the request in.");
  mkdirSync(p.dir, { recursive: true, mode: 0o770 });
  const tmp = join(p.dir, `.request.${process.pid}.tmp`);
  writeFileSync(tmp, `action=${r.action}\nversion=${r.version}\nrequestedBy=${r.by}\nat=${Math.floor(rt.now() / 1000)}\n`, { mode: 0o640 });
  renameSync(tmp, join(p.dir, "request"));
  setPending(rt, { action: r.action, from: r.from, to: r.action === "rollback" ? (r.previous ?? null) : r.version, by: r.by, at: rt.now() });
  rt.audit(r.by, `pin.update.${r.action}`, undefined, r.version);
}

/**
 * The background half, run on the runner's tick: write down what the helper finished, look for a new release, remind
 * administrators once a day (unless snoozed or paused), and, when the device is set to, install it inside the
 * maintenance window. An update that failed on schedule is not tried again by itself.
 */
export async function updateTick(rt: PinRuntime): Promise<void> {
  if (rt.state.getSetting<boolean>("pin.update.enabled") === false) return;
  const cache = await check(rt, false);
  const sum = summary(rt, cache, true, true);
  syncHistory(rt, sum.installed, sum.status);
  const now = rt.now();
  const policy = readPolicy(rt);
  // A new Proxmox kernel only takes effect after a reboot. Reminders ignore "pause" (it holds back installs), not "snooze".
  if (sum.system.rebootRequired && sum.system.newestInstalled && !isSnoozed(policy, now)) {
    const k = sum.system.newestInstalled;
    for (const u of watchers(rt)) {
      const told = pushNotice(rt, u, { key: `reboot:${k}:first`, kind: "update", level: "warning", title: "Proxmox needs a restart to finish updating", body: `Kernel ${k} is installed but ${sum.system.running ?? "the old one"} is still running. Restart when no one is relying on this device.`, link: "pin?tab=updates" });
      const today = new Date(now).toISOString().slice(0, 10);
      const firstAt = rt.store.inbox(u).find((x) => x.key === `reboot:${k}:first`)?.at;
      if (!told && firstAt !== undefined && new Date(firstAt).toISOString().slice(0, 10) !== today) pushNotice(rt, u, { key: `reboot:${k}:${today}`, kind: "update", level: "info", title: "Reminder: Proxmox is waiting for a restart", body: `Kernel ${k} is installed; ${sum.system.running ?? "the old one"} is still running.`, link: "pin?tab=updates" });
    }
  }
  if (sum.installedWithdrawn && sum.installed) for (const u of watchers(rt)) pushNotice(rt, u, { key: `withdrawn:${sum.installed}`, kind: "update", level: "critical", title: `ePaperclip ${sum.installed} was withdrawn`, body: `${sum.installedWithdrawn} Open Updates to move to a newer version.`, link: "pin?tab=updates" });
  if (sum.state !== "available" || !sum.latest || sum.inProgress) return;
  if (isPaused(policy, now)) return;
  const version = sum.latest.version;
  const day = new Date(now).toISOString().slice(0, 10);
  if (policy.mode === "window") {
    if (failedBefore(rt, version)) {
      for (const u of watchers(rt)) pushNotice(rt, u, { key: `update:${version}:failed`, kind: "update", level: "warning", title: `The scheduled update to ${version} didn't finish`, body: "It won't be tried again on its own. Open Updates to see what happened and try again.", link: "pin?tab=updates" });
      return;
    }
    if (sum.canUpdate && inWindow(policy, now)) {
      writeRequest(rt, { action: "update", version, by: "schedule", from: sum.installed, previous: sum.previous });
      return;
    }
  }
  if (isSnoozed(policy, now)) return;
  const when = policy.mode === "window" ? `It installs by itself ${new Date(nextWindow(policy, now)).toLocaleString()}.` : "Open Updates to review it and install when it suits you.";
  for (const u of watchers(rt)) pushNotice(rt, u, { key: `update:${version}:${policy.mode === "window" ? "scheduled" : day}`, kind: "update", level: "info", title: `ePaperclip ${version} is available`, body: `You have ${sum.installed ?? "an unknown version"}. ${when}`, link: "pin?tab=updates" });
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
    const sum = summary(rt, cache, enabled, isAdmin);
    if (isAdmin) {
      watch(rt, s.username);
      syncHistory(rt, sum.installed, sum.status);
    }
    if (isAdmin && sum.state === "available" && sum.latest) pushNotice(rt, s.username, { key: `update:${sum.latest.version}`, kind: "update", level: "info", title: `ePaperclip ${sum.latest.version} is available`, body: `You have ${sum.installed ?? "an unknown version"}. Open Pin's Updates tab to review it.`, link: "pin?tab=updates" });
    return ctx.json(200, sum), true;
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
    const KEYS = new Set(["check", "channel", "mode", "window", "pauseDays", "snoozeHours"]);
    if (!Object.keys(b).length || Object.keys(b).some((k) => !KEYS.has(k))) throw new HttpError(400, "bad_request", "Send any of: check, channel, mode, window, pauseDays, snoozeHours.");
    if (b.check !== undefined && typeof b.check !== "boolean") throw new HttpError(400, "bad_request", "check is true or false.");
    if (b.channel !== undefined && b.channel !== "stable" && b.channel !== "rc") throw new HttpError(400, "bad_request", 'channel is "stable" or "rc".');
    try {
      applyPolicy(rt, b);
    } catch (e) {
      throw new HttpError(400, "bad_request", (e as Error).message);
    }
    for (const k of ["mode", "window", "pauseDays", "snoozeHours"]) if (b[k] !== undefined) rt.audit(s.username, `pin.update.${k}`, undefined, JSON.stringify(b[k]).slice(0, 120));
    if (b.channel !== undefined) {
      rt.state.setSetting("pin.update.channel", b.channel);
      rt.audit(s.username, "pin.update.channel", undefined, String(b.channel));
    }
    if (b.check !== undefined) {
      rt.state.setSetting("pin.update.enabled", b.check);
      rt.audit(s.username, "pin.update.check", undefined, b.check ? "on" : "off");
    }
    const on = rt.state.getSetting<boolean>("pin.update.enabled") !== false;
    return ctx.json(200, summary(rt, rt.state.getSetting<Cache>("pin.update.cache"), on, isAdmin)), true;
  }

  if (path === "/api/pin/update/history" && method === "GET") {
    if (!isAdmin) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can see the update history");
    const sum = summary(rt, rt.state.getSetting<Cache>("pin.update.cache"), enabled, true);
    syncHistory(rt, sum.installed, sum.status);
    return ctx.json(200, { entries: readHistory(rt), system: aptHistory(rt) }), true;
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
    writeRequest(rt, { action: b.action as "update" | "rollback", version, by: s.username, from: sum.installed, previous: sum.previous });
    return ctx.json(202, { requested: true, action: b.action, version }), true;
  }
  throw new HttpError(405, "method", "Method not allowed");
}
