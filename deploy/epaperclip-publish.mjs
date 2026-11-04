// Socket-activated root boundary for machine-wide publishing. It accepts only a
// Cloudflare Tunnel runtime token; the Cloudflare API token stays in the host
// service's encrypted vault and is never written here.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REQUEST_MAX = 4096;
const ETC = '/etc/epaperclip';
const ENV = `${ETC}/cloudflared.env`;
const UNIT = '/etc/systemd/system/epaperclip-cloudflared.service';
const BIN = ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
const TOKEN = /^[A-Za-z0-9_.-]{20,4096}$/;

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

/** Install or rotate the runtime token. Input never becomes a shell command or a log entry. */
export function install(request, deps = {}) {
  if (!request || request.operation !== 'install' || typeof request.token !== 'string' || !TOKEN.test(request.token)) throw new Error('Invalid publishing request.');
  const bin = (deps.bins ?? BIN).find((file) => (deps.exists ?? (() => true))(file));
  if (!bin) throw new Error('cloudflared is not installed on this device. Install it before publishing.');
  const etc = deps.etc ?? ETC, env = deps.env ?? ENV, service = deps.unit ?? UNIT;
  (deps.mkdir ?? mkdirSync)(etc, { recursive: true, mode: 0o700 });
  (deps.write ?? writeFileSync)(env, `TUNNEL_TOKEN=${request.token}\n`, { mode: 0o600 });
  (deps.chmod ?? chmodSync)(env, 0o600);
  (deps.write ?? writeFileSync)(service, unit(bin), { mode: 0o644 });
  run('systemctl', ['daemon-reload'], deps);
  run('systemctl', ['enable', '--now', 'epaperclip-cloudflared.service'], deps);
  return { ok: true };
}

export async function serve(input, output, deps = {}) {
  let text = '';
  try {
    for await (const chunk of input) { text += chunk; if (Buffer.byteLength(text) > REQUEST_MAX) throw new Error('Publishing request is too large.'); }
    output.end(JSON.stringify(install(JSON.parse(text), deps)));
  } catch (e) { output.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Publishing request failed.' })); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve(process.stdin, process.stdout);
