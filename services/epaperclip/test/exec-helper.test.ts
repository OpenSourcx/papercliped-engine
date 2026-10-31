import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createServer } from 'node:https';
import { spawnSync } from 'node:child_process';
// The installed program is plain JavaScript so the bundled Node can run it without host dependencies.
// @ts-expect-error standalone deployment program has no declaration file
import { run, serve, permissions, REQUEST_MAX } from '../../../deploy/epaperclip-exec.mjs';

const req = { vmid: 100, node: 'pve', script: 'echo hi', timeoutMs: 1000, auth: { ticket: 'PVE:sam@pam:fixture' } };
const deps = { node: 'pve', permissions: async () => {}, readConfig: () => '', capture: async () => 'status: running\n', acquireLock: async () => () => {}, log: () => {} };
describe('independent root helper boundary', () => {
  it('refuses authorization, non-LXC guests, wrong nodes and malformed vmids before attaching', async () => {
    expect(await run(req, { ...deps, permissions: async () => { throw new Error('VM.Console denied'); } })).toEqual({ error: 'VM.Console denied' });
    expect(await run(req, { ...deps, readConfig: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } })).toMatchObject({ error: expect.stringMatching(/not an LXC/) });
    expect(await run({ ...req, node: 'remote' }, deps)).toMatchObject({ error: expect.stringMatching(/node that hosts/) });
    for (const vmid of ['100;whoami', 0, -1, 1.2]) expect(await run({ ...req, vmid }, deps)).toMatchObject({ error: expect.stringMatching(/positive integer/) });
    expect(await run({ ...req, timeoutMs: 300001 }, deps)).toMatchObject({ error: expect.stringMatching(/timeoutMs/) });
    expect(await run(req, { ...deps, capture: async () => 'status: stopped' })).toMatchObject({ error: expect.stringMatching(/running LXC/) });
  });
  it('caps request bytes before parsing or executing', async () => {
    let body = '';
    const out = new Writable({ write(b, _encoding, cb) { body += b; cb(); } });
    await serve(Readable.from([Buffer.alloc(REQUEST_MAX + 1)]), out, deps);
    expect(JSON.parse(body).error).toMatch(/exceeds 1 MiB/);
  });
  it('fails closed if the local permissions API cannot authenticate the credential', async () => {
    await expect(permissions(req.auth, 100, { api: 'https://127.0.0.1:1', ca: '', servername: 'fixture' })).rejects.toThrow(/verify VM.Console/);
  });
  it('uses a verified local permissions API for both tickets and API tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epc-permissions-'));
    const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-days', '1'], { stdio: 'ignore' });
    expect(generated.status).toBe(0);
    let permitted = true;
    const headers: Array<Record<string, unknown>> = [];
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
      expect(request.url).toBe('/api2/json/access/permissions?path=/vms/100');
      headers.push(request.headers);
      response.end(JSON.stringify({ data: { '/vms/100': permitted ? { 'VM.Console': 1 } : { 'VM.Audit': 1 } } }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const options = { api: `https://127.0.0.1:${port}`, ca: readFileSync(cert), servername: 'localhost' };
    try {
      await permissions(req.auth, 100, options);
      await permissions({ tokenId: 'sam@pam!fixture', tokenSecret: 'test-only' }, 100, options);
      expect(headers[0].cookie).toBe('PVEAuthCookie=PVE%3Asam%40pam%3Afixture');
      expect(headers[1].authorization).toBe('PVEAPIToken=sam@pam!fixture=test-only');
      permitted = false;
      await expect(permissions(req.auth, 100, options)).rejects.toThrow(/needs VM.Console/);
      await expect(permissions(req.auth, 100, { ...options, servername: 'wrong-node' })).rejects.toThrow(/verify VM.Console/);
    } finally { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
  });
  it('passes scripts only on stdin, caps output, kills on timeout and logs metadata only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epc-helper-'));
    const original = process.env.PATH;
    const argv = join(dir, 'args');
    writeFileSync(join(dir, 'lxc-attach'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\nexec /bin/sh -s\n`);
    chmodSync(join(dir, 'lxc-attach'), 0o755);
    writeFileSync(join(dir, 'pct'), '#!/bin/sh\nprintf "status: running\\n"\n');
    chmodSync(join(dir, 'pct'), 0o755);
    process.env.PATH = `${dir}:${original}`;
    let pid = 0, killed = 0;
    const logs: string[] = [];
    const d = { ...deps, capture: undefined, isolate: async (_attach: number, guest: number) => { pid = guest; return { kill: () => { killed++; try { process.kill(pid, 'SIGKILL'); } catch {} }, dispose() {} }; }, log: (s: string) => logs.push(s) };
    try {
      const r = await run({ ...req, script: "printf '%300000s' secret; exit 7" }, d);
      expect(r).toMatchObject({ exitCode: 7, timedOut: false, truncated: true });
      expect(Buffer.byteLength(r.output)).toBe(65536);
      expect(readFileSync(argv, 'utf8')).toBe('--clear-env\n-n\n100\n--\n/bin/sh\n-s\n');
      expect(logs.join('')).not.toMatch(/secret|fixture/);
      expect(JSON.parse(logs[0])).toMatchObject({ user: 'sam@pam', receivedBytes: 300000, returnedBytes: 65536 });
      const timeout = await run({ ...req, script: 'while :; do :; done', timeoutMs: 100 }, d);
      expect(timeout).toMatchObject({ timedOut: true, exitCode: null });
      expect(killed).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { process.env.PATH = original; rmSync(dir, { recursive: true, force: true }); }
  });
});
