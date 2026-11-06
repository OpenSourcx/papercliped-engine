// Socket-activated root boundary for machine-wide publishing. It accepts only a
// Cloudflare Tunnel runtime token; the Cloudflare API token stays in the host
// service's encrypted vault and is never written here.
//
// This helper is the ONLY owner of epaperclip-cloudflared.service and its token file. The tunnel has exactly one
// owner at a time, recorded in cloudflared.owner: "self" (the administrator's own Cloudflare account) or "connect"
// (managed Papercliped Connect). Installing for one owner while the other holds the tunnel is refused, so the two
// modes can never both run. The token is never logged and never returned by any operation.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REQUEST_MAX = 8192;
const ETC = '/etc/epaperclip';
const ENV = `${ETC}/cloudflared.env`;
const OWNER = `${ETC}/cloudflared.owner`;
const OWNERS = ['self', 'connect'];
const UNIT = '/etc/systemd/system/epaperclip-cloudflared.service';
const BIN = ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
// Tunnel tokens are base64 (padding and +/ allowed); nothing here can break out of an EnvironmentFile line.
const TOKEN = /^[A-Za-z0-9_.+/=-]{20,4096}$/;

const unit = (bin) => `[Unit]
Description=ePaperclip Cloudflare Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV}
ExecStart=${bin} tunnel --no-autoupdate run --token \${TUNNEL_TOKEN}
Restart=on-failure
RestartSec=5
User=root
Group=root
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/etc/epaperclip
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
LockPersonality=true
RestrictRealtime=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
`;

function run(command, args, deps) {
  const result = (deps.spawnSync ?? spawnSync)(command, args, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error('Could not activate the Cloudflare connector.');
}

const paths = (deps) => ({ etc: deps.etc ?? ETC, env: deps.env ?? ENV, owner: deps.owner ?? OWNER, service: deps.unit ?? UNIT });
function currentOwner(p, deps) {
  try { const v = String((deps.read ?? readFileSync)(p.owner, 'utf8')).trim(); return OWNERS.includes(v) ? v : null; } catch { /* no marker */ }
  // A unit from before owners existed was always the administrator's own.
  try { (deps.read ?? readFileSync)(p.env, 'utf8'); return 'self'; } catch { return null; }
}
const askOwner = (request) => {
  const owner = request.owner ?? 'self';
  if (!OWNERS.includes(owner)) throw new Error('Invalid publishing request.');
  return owner;
};

/** Install or rotate the runtime token. Input never becomes a shell command or a log entry. */
export function install(request, deps = {}) {
  if (!request || request.operation !== 'install' || typeof request.token !== 'string' || !TOKEN.test(request.token)) throw new Error('Invalid publishing request.');
  const owner = askOwner(request), p = paths(deps);
  const held = currentOwner(p, deps);
  if (held && held !== owner) throw new Error(held === 'connect' ? 'Papercliped Connect is managing the tunnel. Switch to local-only first.' : 'Your own Cloudflare tunnel is running. Switch to local-only first.');
  const bin = (deps.bins ?? BIN).find((file) => (deps.exists ?? (() => true))(file));
  if (!bin) throw new Error('cloudflared is not installed on this device. Install it before publishing.');
  (deps.mkdir ?? mkdirSync)(p.etc, { recursive: true, mode: 0o700 });
  // Owner first: a crash between the two writes leaves a marker with no token, never a token nobody owns.
  (deps.write ?? writeFileSync)(p.owner, owner + '\n', { mode: 0o600 });
  (deps.write ?? writeFileSync)(p.env, `TUNNEL_TOKEN=${request.token}\n`, { mode: 0o600 });
  (deps.chmod ?? chmodSync)(p.env, 0o600);
  (deps.write ?? writeFileSync)(p.service, unit(bin), { mode: 0o644 });
  run('systemctl', ['daemon-reload'], deps);
  run('systemctl', ['enable', '--now', 'epaperclip-cloudflared.service'], deps);
  return { ok: true };
}

/** Stop the tunnel and delete its token, but only for the owner that holds it (anything else is already gone for them). */
export function remove(request, deps = {}) {
  const owner = askOwner(request), p = paths(deps);
  if (currentOwner(p, deps) !== owner) return { ok: true, removed: false };
  const spawn = deps.spawnSync ?? spawnSync;
  spawn('systemctl', ['disable', '--now', 'epaperclip-cloudflared.service'], { encoding: 'utf8', timeout: 30_000 });
  for (const f of [p.env, p.owner, p.service]) (deps.rm ?? ((x) => rmSync(x, { force: true })))(f);
  spawn('systemctl', ['daemon-reload'], { encoding: 'utf8', timeout: 30_000 });
  return { ok: true, removed: true };
}

export function status(deps = {}) {
  const p = paths(deps), owner = currentOwner(p, deps);
  const active = owner !== null && (deps.spawnSync ?? spawnSync)('systemctl', ['is-active', '--quiet', 'epaperclip-cloudflared.service'], { timeout: 10_000 }).status === 0;
  return { ok: true, owner, installed: owner !== null, active };
}

export function handle(request, deps = {}) {
  if (!request || typeof request !== 'object') throw new Error('Invalid publishing request.');
  if (request.operation === 'install') return install(request, deps);
  if (request.operation === 'remove') return remove(request, deps);
  if (request.operation === 'status') return status(deps);
  throw new Error('Invalid publishing request.');
}

export async function serve(input, output, deps = {}) {
  let text = '';
  try {
    for await (const chunk of input) { text += chunk; if (Buffer.byteLength(text) > REQUEST_MAX) throw new Error('Publishing request is too large.'); }
    output.end(JSON.stringify(handle(JSON.parse(text), deps)));
  } catch (e) { output.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Publishing request failed.' })); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve(process.stdin, process.stdout);
