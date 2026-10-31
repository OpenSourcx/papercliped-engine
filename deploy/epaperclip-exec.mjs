// Socket-activated root helper. No application code, dependencies or configuration from writable service state.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmdirSync, openSync, closeSync, constants } from 'node:fs';
import { hostname } from 'node:os';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const REQUEST_MAX = 1024 * 1024;
export const COLLECT_MAX = 256 * 1024;
export const OUTPUT_MAX = 64 * 1024;
export const TIMEOUT_MAX = 300_000;
const RUN_DIR = '/run/epaperclip-exec';

export function permissions(auth, vmid, { api = 'https://127.0.0.1:8006', ca = readFileSync('/etc/pve/pve-root-ca.pem'), servername = hostname().split('.')[0] } = {}) {
  return new Promise((resolve, reject) => {
    const headers = auth.ticket ? { Cookie: `PVEAuthCookie=${encodeURIComponent(auth.ticket)}` } : { Authorization: `PVEAPIToken=${auth.tokenId}=${auth.tokenSecret}` };
    const req = request(`${api}/api2/json/access/permissions?path=/vms/${vmid}`, { ca, servername, headers, timeout: 5000 }, res => {
      let body = '';
      res.on('data', b => { body += b; if (body.length > 65536) req.destroy(); });
      res.on('end', () => {
        try {
          const data = JSON.parse(body).data;
          if (res.statusCode !== 200 || !(data?.[`/vms/${vmid}`]?.['VM.Console'] === 1)) throw new Error();
          resolve();
        } catch { reject(new Error('Your Proxmox account needs VM.Console on this container; execution refused.')); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(new Error('Could not verify VM.Console with the local Proxmox API; execution refused.')));
    req.end();
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Guest status check timed out.')); }, 5000);
    p.stdout.on('data', b => { if (out.length < 65536) out += b; });
    p.on('error', () => { clearTimeout(timer); reject(new Error('Guest status check failed.')); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error('Guest is not a running LXC container on this node.')); });
  });
}

// Move only the attached shell (before it receives user code) into its own cgroup within the container's cgroup.
// cgroup.kill includes reparented/setsid descendants; killing the lxc-attach process group alone does not.
export async function isolate(attachPid, guestPid) {
  const descendants = pid => {
    let children = [];
    try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { /* exited */ }
    return children.flatMap(c => [c, ...descendants(c)]);
  };
  const pid = descendants(attachPid).find(p => {
    try { const ids = readFileSync(`/proc/${p}/status`, 'utf8').match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/); return ids?.length > 1 && Number(ids.at(-1)) === guestPid; } catch { return false; }
  });
  if (!pid) throw new Error('Could not isolate the container command; execution refused.');
  const rel = readFileSync(`/proc/${pid}/cgroup`, 'utf8').match(/^0::(.+)$/m)?.[1];
  if (!rel || rel.includes('..')) throw new Error('A unified cgroup hierarchy is required for private container commands.');
  const dir = `/sys/fs/cgroup${rel}/epaperclip-${randomUUID()}`;
  mkdirSync(dir);
  try { writeFileSync(`${dir}/cgroup.procs`, String(pid)); }
  catch (e) { rmdirSync(dir); throw e; }
  return {
    kill() { writeFileSync(`${dir}/cgroup.kill`, '1'); },
    dispose() { try { rmdirSync(dir); return true; } catch { return false; } },
  };
}

function lock(vmid) {
  // One accepted connection = one service process. Exclusive, root-owned slot files enforce a global per-guest cap.
  for (let slot = 0; slot < 2; slot++) {
    const path = `${RUN_DIR}/${vmid}-${slot}.lock`;
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      // flock is held by a separate child for the complete run, including cleanup. See acquireLock below.
      closeSync(fd);
      return path;
    } catch { /* try next */ }
  }
  throw new Error('Cannot create the execution lock.');
}

async function acquireLock(vmid) {
  const base = lock(vmid);
  for (let slot = 0; slot < 2; slot++) {
    const path = base.replace(/-\d.lock$/, `-${slot}.lock`);
    const p = spawn('flock', ['-n', path, '/bin/sh', '-c', 'printf READY; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const ready = await new Promise(resolve => { p.stdout.once('data', () => resolve(true)); p.once('error', () => resolve(false)); p.once('close', () => resolve(false)); });
    if (ready) return () => p.stdin.end();
  }
  throw new Error('This container already has two commands running; try again when one finishes.');
}

export async function run(req, deps = {}) {
  const started = Date.now();
  let release, group, proc, bytes = 0, result, user = 'unverified', authorized = false;
  try {
    if (!req || !Number.isSafeInteger(req.vmid) || req.vmid <= 0) throw new Error('vmid must be a positive integer.');
    if (typeof req.node !== 'string' || req.node !== (deps.node ?? hostname().split('.')[0])) throw new Error(`Commands in containers must run on the node that hosts the container (${String(req.node).slice(0,63)}).`);
    if (typeof req.script !== 'string' || Buffer.byteLength(req.script) > REQUEST_MAX - 16384) throw new Error('Script is too large.');
    if (!Number.isInteger(req.timeoutMs) || req.timeoutMs < 1 || req.timeoutMs > TIMEOUT_MAX) throw new Error(`timeoutMs must be between 1 and ${TIMEOUT_MAX}.`);
    const a = req.auth;
    if (!a || !(typeof a.ticket === 'string' && a.ticket.length > 0 && a.ticket.length < 16384 || typeof a.tokenId === 'string' && typeof a.tokenSecret === 'string' && a.tokenId.length > 0 && a.tokenId.length < 1024 && a.tokenSecret.length > 0 && a.tokenSecret.length < 16384)) throw new Error('A Proxmox ticket or API token is required.');
    user = (a.ticket ? (a.ticket.match(/^PVE:([^:]+):/)?.[1] ?? 'ticket-user') : a.tokenId).slice(0, 256);
    await (deps.permissions ?? permissions)(a, req.vmid);
    authorized = true;
    // This path is local-node specific; /etc/pve/lxc is a symlink to this node, not the cluster-wide guest index.
    (deps.readConfig ?? (id => readFileSync(`/etc/pve/lxc/${id}.conf`)))(req.vmid);
    if (!/^status: running\s*$/.test(await (deps.capture ?? capture)('pct', ['status', String(req.vmid)]))) throw new Error('Guest is not a running LXC container on this node.');
    release = await (deps.acquireLock ?? acquireLock)(req.vmid);
    result = await new Promise((resolve, reject) => {
      proc = spawn('lxc-attach', ['--clear-env', '-n', String(req.vmid), '--', '/bin/sh', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let chunks = [], collected = 0, ready = false, prefix = '', timedOut = false, failed;
      const finishGroup = () => { try { group?.kill(); } catch { failed = new Error('Could not clean up the private command cgroup.'); } };
      const stop = () => {
        finishGroup();
        if (!group) {
          // User code has not been sent yet. Reap the waiting bootstrap and attach workers as well.
          const killChildren = pid => {
            let children = [];
            try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { /* exited */ }
            for (const child of children) { killChildren(child); try { process.kill(child, 'SIGKILL'); } catch { /* exited */ } }
          };
          if (proc.pid) killChildren(proc.pid);
        }
        proc.stdin.destroy(); proc.kill('SIGKILL');
      };
      const onTerminate = () => { stop(); };
      process.once('SIGTERM', onTerminate);
      const timer = setTimeout(() => { timedOut = true; stop(); }, req.timeoutMs);
      const collect = b => { bytes += b.length; if (collected < COLLECT_MAX) { const part = b.subarray(0, COLLECT_MAX - collected); chunks.push(part); collected += part.length; } };
      proc.stdout.on('data', async b => {
        if (ready) return collect(b);
        prefix += b.toString();
        const m = /^EPC_READY:(\d+)\n/.exec(prefix);
        if (!m) { if (prefix.length > 128) { failed = new Error('Private exec handshake failed.'); proc.kill('SIGKILL'); } return; }
        ready = true;
        try {
          group = await (deps.isolate ?? isolate)(proc.pid, Number(m[1]));
          if (timedOut) { finishGroup(); return; }
          proc.stdin.end(req.script);
        } catch { failed = new Error('Could not isolate the container command; execution refused.'); stop(); }
      });
      proc.stderr.on('data', collect);
      proc.stdin.on('error', () => {});
      proc.on('error', () => { process.removeListener('SIGTERM', onTerminate); clearTimeout(timer); reject(new Error('Could not start lxc-attach.')); });
      proc.on('exit', () => { finishGroup(); });
      proc.on('close', code => {
        process.removeListener('SIGTERM', onTerminate);
        clearTimeout(timer); finishGroup();
        if (failed) return reject(failed);
        const out = Buffer.from(Buffer.concat(chunks).toString('utf8'));
        const output = new TextDecoder().decode(out.subarray(0, OUTPUT_MAX), { stream: true });
        resolve({ exitCode: timedOut ? null : code, output, timedOut, truncated: bytes > OUTPUT_MAX || out.length > OUTPUT_MAX });
      });
      proc.stdin.write('printf "EPC_READY:%s\\n" "$$"\n');
    });
    return result;
  } catch (e) {
    // Never expose spawn errors, paths, credentials, script text or subprocess stderr.
    return { error: e?.code === 'ENOENT' ? 'Guest is not an LXC container on this node, or the exec helper prerequisites are missing.' : e.message };
  } finally {
    if (group) {
      for (let i = 0; i < 50; i++) {
        if (group.dispose() !== false) break;
        await new Promise(r => setTimeout(r, 20));
      }
    }
    release?.();
    (deps.log ?? console.error)(JSON.stringify({ user, authorized, vmid: Number.isSafeInteger(req?.vmid) ? req.vmid : null, durationMs: Date.now() - started, exitCode: result?.exitCode ?? null, receivedBytes: bytes, returnedBytes: Buffer.byteLength(result?.output ?? '') }));
  }
}

export async function serve(input, output, deps = {}) {
  let size = 0, chunks = [];
  const timer = setTimeout(() => input.destroy(), 10_000);
  try {
    for await (const b of input) {
      size += b.length;
      if (size > REQUEST_MAX) throw new Error('Exec request exceeds 1 MiB.');
      chunks.push(b);
    }
    clearTimeout(timer);
    let req;
    try { req = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('Exec request must be JSON.'); }
    output.end(JSON.stringify(await run(req, deps)));
  } catch (e) { clearTimeout(timer); output.end(JSON.stringify({ error: e.message })); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve(process.stdin, process.stdout);
