#!/usr/bin/env node
// epaperclip login | logout | whoami
//
// Links this computer to a Papercliped account from the command line, the same pairing the web console's "Link to Papercliped" button
// does (docs: papercliped-connect docs/LINK-PROTOCOL.md). It shows a short code; the owner opens https://link.papercliped.co, signs in
// and enters it; then THIS command shows which account approved and asks the local administrator to confirm before anything is linked.
//
// It talks to the running ePaperclip service over its control socket (/var/lib/epaperclip/ctl.sock, mode 0600), so it must run as root
// on the Proxmox host, like every other epaperclip command that changes the machine. No password is typed and no token is stored here.
// Plain Node, no dependencies: it runs with the private Node.js the installer ships.
import { request } from "node:http";
import { createInterface } from "node:readline";
import { hostname } from "node:os";

const USAGE = `usage: epaperclip login [--name <device name>] [--yes]
       epaperclip logout [--yes]
       epaperclip whoami

  login    link this computer to your Papercliped account: shows a code to enter at https://link.papercliped.co,
           waits for you to approve it there, then asks you to confirm the account here
  logout   unlink this computer (its public address stops working; local use is unaffected)
  whoami   show the account and device name this computer is linked as (exit status 1 when it is not linked)

  --yes    do not ask; for scripts (login still needs the owner to approve on the website)
  --name   what this computer is called on your account (default: its host name)`;

export class CtlError extends Error {
  constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; }
}

/** One JSON call over the control socket. Failures become CtlError with a sentence a person can act on. */
export function call(socketPath, method, path, body, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath, path, method, headers: { "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}) }, timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; if (text.length > 64 * 1024) req.destroy(); });
      res.on("end", () => {
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
        if (res.statusCode && res.statusCode >= 400) return reject(new CtlError(typeof json.error === "string" ? json.error : "failed", typeof json.message === "string" ? json.message : "ePaperclip could not do that.", res.statusCode));
        resolve(json);
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") return reject(new CtlError("not_running", `ePaperclip isn't running here (nothing is listening at ${socketPath}). Start it with: systemctl start epaperclip`));
      if (e.code === "EACCES" || e.code === "EPERM") return reject(new CtlError("not_root", "Run this as root (on Proxmox you already are; elsewhere put sudo in front)."));
      reject(new CtlError("unreachable", "ePaperclip didn't answer. Check it with: epaperclip status"));
    });
    req.end(data);
  });
}

const POLL_FIRST_MS = 3000, POLL_MAX_MS = 10_000, MAX_CONSECUTIVE_FAILURES = 8;

function parse(argv) {
  const o = { yes: false, name: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--name") { o.name = argv[++i] ?? ""; }
    else if (a.startsWith("--name=")) o.name = a.slice(7);
    else o.rest.push(a);
  }
  return o;
}
const yes = (s) => /^\s*y(es)?\s*$/i.test(s ?? "");

/**
 * @param {string[]} argv  [command, ...options]
 * @param {{ out:(s:string)=>void, err:(s:string)=>void, ask:(q:string)=>Promise<string|null>, isTTY:boolean, sleep:(ms:number)=>Promise<void>,
 *           now:()=>number, socketPath:string, hostname:()=>string, signal?:AbortSignal, call?:typeof call }} io
 * @returns {Promise<number>} the exit status
 */
export async function run(argv, io) {
  const [cmd, ...args] = argv;
  const o = parse(args);
  const api = (method, path, body) => (io.call ?? call)(io.socketPath, method, path, body);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { io.out(USAGE); return cmd ? 0 : 2; }
  if (!["login", "logout", "whoami"].includes(cmd) || o.rest.length) { io.err(`epaperclip: unknown option or command\n${USAGE}`); return 2; }
  try {
    if (cmd === "whoami") return await whoami();
    if (cmd === "logout") return await logout();
    return await login();
  } catch (e) {
    if (e instanceof CtlError) { io.err(`epaperclip: ${e.message}`); return 1; }
    throw e;
  }

  async function whoami() {
    const s = await api("GET", "/v1/connect/status");
    if (s.paired && s.device) {
      io.out(`Linked as "${s.device.name}" to Papercliped account ${s.device.accountId}`);
      io.out(`Remote access: ${s.mode === "connect" ? "Papercliped Connect" : s.mode === "cloudflare-self" ? "your own Cloudflare account" : "local only"}${s.tunnel?.hostname ? ` (https://${s.tunnel.hostname})` : ""}`);
      return 0;
    }
    if (s.pairing && s.pairing.state === "pending" && s.pairing.userCode) io.out(`Not linked yet. A request is waiting: enter ${s.pairing.userCode} at https://link.papercliped.co`);
    else io.out("This computer is not linked to a Papercliped account. Run: epaperclip login");
    return 1;
  }

  async function logout() {
    const s = await api("GET", "/v1/connect/status");
    if (!s.paired) { io.out("This computer isn't linked to a Papercliped account."); return 0; }
    if (!o.yes) {
      if (!io.isTTY) { io.err("epaperclip: add --yes to unlink without a terminal to ask in."); return 2; }
      const a = await io.ask(`Unlink "${s.device?.name ?? "this computer"}" from Papercliped account ${s.device?.accountId ?? ""}? Its public address stops working; local use is unaffected. [y/N] `);
      if (!yes(a)) { io.out("Nothing changed."); return 1; }
    }
    await api("POST", "/v1/connect/unpair", {});
    io.out("Unlinked. This computer is back to local only; Papercliped is removing its address and seat.");
    return 0;
  }

  async function login() {
    if (o.name !== null && !(o.name.trim().length >= 1 && o.name.trim().length <= 100)) { io.err("epaperclip: --name must be 1 to 100 characters."); return 2; }
    if (!o.yes && !io.isTTY) { io.err("epaperclip: login needs a terminal to confirm the account in. In a script, use: epaperclip login --yes"); return 2; }
    const before = await api("GET", "/v1/connect/status");
    if (before.paired && before.device) {
      io.out(`Already linked as "${before.device.name}" to Papercliped account ${before.device.accountId}. To link a different account, run: epaperclip logout`);
      return 0;
    }
    if (before.pairing) await api("POST", "/v1/connect/pairing/cancel", {}); // an earlier attempt that was never finished
    const started = await api("POST", "/v1/connect/pairing/start", {});
    const p = started.pairing;
    if (!p) { io.err("epaperclip: Papercliped didn't start a link. Try again in a moment."); return 1; }
    io.out("");
    io.out("  Link this computer to your Papercliped account");
    io.out("");
    if (p.userCode) {
      io.out(`    1. Open   ${String(p.linkUrl).split("?")[0]}`);
      io.out(`    2. Enter  ${p.userCode}`);
      io.out("");
      io.out("  Sign in there if asked. The code works for 10 minutes.");
    } else {
      io.out(`    Open ${p.approvalUrl} and approve this computer.`);
    }
    io.out("");
    io.out("  Waiting for you to approve it…");

    let delay = POLL_FIRST_MS, failures = 0, approved = null;
    for (;;) {
      await io.sleep(delay);
      if (io.signal?.aborted) { try { await api("POST", "/v1/connect/pairing/cancel", {}); } catch { /* best effort */ } io.err("\nCancelled. Nothing was linked."); return 130; }
      let s;
      try { s = await api("POST", "/v1/connect/pairing/poll", {}); failures = 0; }
      catch (e) {
        if (!(e instanceof CtlError) || ++failures >= MAX_CONSECUTIVE_FAILURES) throw e;
        delay = Math.min(delay * 2, POLL_MAX_MS); continue;
      }
      const cur = s.pairing;
      if (!cur || cur.state === "expired" || (cur.expiresAt && io.now() > cur.expiresAt)) { io.err("epaperclip: the code expired before it was approved. Run epaperclip login again."); try { await api("POST", "/v1/connect/pairing/cancel", {}); } catch { /* best effort */ } return 1; }
      if (cur.state === "denied") { io.err("epaperclip: the request was declined on the website. Nothing was linked."); return 1; }
      if (cur.state === "approved" && cur.selectedOwner) { approved = cur.selectedOwner; break; }
      delay = Math.min(Math.round(delay * 1.25), POLL_MAX_MS);
    }

    io.out("");
    io.out(`  Approved by Papercliped account ${approved}.`);
    io.out("  Linking gives that account a record of this computer. It does not change any Proxmox permission.");
    if (!o.yes) {
      const a = await io.ask(`  Link this computer to account ${approved}? [y/N] `);
      if (!yes(a)) { await api("POST", "/v1/connect/pairing/cancel", {}); io.out("Nothing was linked."); return 1; }
    }
    const name = (o.name ?? io.hostname()).trim().slice(0, 100) || "ePaperclip";
    const done = await api("POST", "/v1/connect/pairing/confirm", { accountId: approved, deviceName: name });
    io.out("");
    io.out(`  Linked as "${done.device?.name ?? name}" to Papercliped account ${done.device?.accountId ?? approved}.`);
    io.out("  Manage it at https://console.papercliped.co/devices");
    io.out("  To give it a public address, choose Papercliped Connect under Access, Remote access in ePaperclip.");
    return 0;
  }
}

// Run only when started as a program (the tests import run()).
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const ctl = new AbortController();
  process.on("SIGINT", () => ctl.abort());
  const rl = () => createInterface({ input: process.stdin, output: process.stderr });
  const io = {
    out: (s) => console.log(s), err: (s) => console.error(s), isTTY: !!process.stdin.isTTY,
    ask: (q) => new Promise((resolve) => { const r = rl(); r.question(q, (a) => { r.close(); resolve(a); }); r.on("close", () => resolve(null)); }),
    sleep: (ms) => new Promise((r) => { const t = setTimeout(r, ms); ctl.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); }),
    now: Date.now, hostname, signal: ctl.signal,
    socketPath: process.env.EPC_CTL_SOCKET || `${process.env.EPC_STATE_DIR || "/var/lib/epaperclip"}/ctl.sock`,
  };
  run(process.argv.slice(2), io).then((code) => process.exit(code), (e) => { console.error(`epaperclip: ${e?.message ?? e}`); process.exit(1); });
}
