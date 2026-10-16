// Run with: node --test scripts/release-signing.test.mjs
// Covers the key generator, the signer and the shared library, including that openssl (what the installers use) accepts what node signs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST, SIGNATURE, buildGetSh, buildManifest, fingerprint, generateReleaseKey, isPrerelease, normalizeVersion, privateKeyFrom, signManifest, verifyManifest } from "./release-lib.mjs";

const root = new URL("../", import.meta.url).pathname;
const script = (n) => `${root}scripts/${n}`;
const tmp = () => mkdtempSync(join(tmpdir(), "relsign-"));
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.CI; if (!("RELEASE_SIGNING_KEY" in extra)) delete e.RELEASE_SIGNING_KEY; return e; };

/** A release folder with a real (tiny) tarball whose VERSION is the given one. */
function fakeRelease(version) {
  const d = tmp(); mkdirSync(`${d}/src/epaperclip`, { recursive: true }); mkdirSync(`${d}/release`);
  writeFileSync(`${d}/src/epaperclip/VERSION`, `${version}\n`);
  execFileSync("tar", ["-czf", `${d}/release/epaperclip.tar.gz`, "-C", `${d}/src`, "epaperclip"]);
  return d;
}

test("version helpers", () => {
  assert.equal(normalizeVersion("v1.2.3\n"), "1.2.3");
  assert.equal(isPrerelease("v1.0.0-rc1"), true);
  assert.equal(isPrerelease("1.0.0"), false);
});

test("the manifest has a fixed shape, a hash and a size, and rejects non-versions", () => {
  const m = JSON.parse(buildManifest({ version: "v1.0.0-rc1", tarball: Buffer.from("abc") }));
  assert.deepEqual(m, { format: 1, name: "epaperclip.tar.gz", version: "1.0.0-rc1", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", size: 3 });
  assert.throws(() => buildManifest({ version: "dev", tarball: Buffer.from("x") }), /not a release version/);
  assert.throws(() => buildManifest({ version: "v1.2.3-4-gabc1234$(x)", tarball: Buffer.from("x") }), /not a release version/);
});

test("sign and verify; a changed manifest or another key fails", () => {
  const a = generateReleaseKey(), b = generateReleaseKey();
  const man = buildManifest({ version: "1.0.0", tarball: Buffer.from("x") });
  const sig = signManifest(man, privateKeyFrom(a.privatePem));
  assert.ok(verifyManifest(man, sig, a.publicPem));
  assert.ok(!verifyManifest(man.replace("1.0.0", "1.0.1"), sig, a.publicPem));
  assert.ok(!verifyManifest(man, sig, b.publicPem));
  assert.ok(!verifyManifest(man, "not base64 !!", a.publicPem));
  assert.equal(fingerprint(a.publicPem).length, 16);
  assert.ok(privateKeyFrom(a.privatePem.replace(/\n/g, "\\n")), "a secret whose newlines were escaped still loads");
});

test("openssl, the verifier the installers use, accepts the signature node made", () => {
  const k = generateReleaseKey(), d = tmp();
  const man = buildManifest({ version: "1.0.0", tarball: Buffer.from("x") });
  writeFileSync(`${d}/m`, man); writeFileSync(`${d}/pub`, k.publicPem);
  writeFileSync(`${d}/sig`, Buffer.from(signManifest(man, privateKeyFrom(k.privatePem)), "base64"));
  const r = spawnSync("openssl", ["pkeyutl", "-verify", "-pubin", "-inkey", `${d}/pub`, "-rawin", "-in", `${d}/m`, "-sigfile", `${d}/sig`]);
  assert.equal(r.status, 0, String(r.stderr));
  rmSync(d, { recursive: true });
});

test("keygen writes the public key, prints the private key once, refuses to overwrite, and --set-secret never prints it", () => {
  const d = tmp(), pub = `${d}/release-signing.pub`;
  const r = spawnSync(process.execPath, [script("release-keygen.mjs"), "--public-out", pub], { env: cleanEnv(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^-----BEGIN PRIVATE KEY-----/);
  assert.ok(!r.stderr.includes("PRIVATE KEY-----\n"), "the private key is only on stdout");
  assert.match(readFileSync(pub, "utf8"), /^-----BEGIN PUBLIC KEY-----/);
  assert.ok(verifyManifest("m", signManifest("m", privateKeyFrom(r.stdout)), readFileSync(pub, "utf8")), "the printed key is the pair of the written one");
  const again = spawnSync(process.execPath, [script("release-keygen.mjs"), "--public-out", pub], { env: cleanEnv(), encoding: "utf8" });
  assert.notEqual(again.status, 0); assert.match(again.stderr, /already exists/); assert.equal(again.stdout, "");
  // --set-secret with a fake gh on PATH: the key reaches gh's stdin and appears nowhere in our output.
  mkdirSync(`${d}/bin`); writeFileSync(`${d}/bin/gh`, `#!/bin/sh\ncat > "${d}/gh.stdin"\necho "args: $*" > "${d}/gh.args"\n`, { mode: 0o755 });
  const pub2 = `${d}/second.pub`;
  const s = spawnSync(process.execPath, [script("release-keygen.mjs"), "--set-secret", "--public-out", pub2], { env: cleanEnv({ PATH: `${d}/bin:${process.env.PATH}` }), encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.ok(!s.stdout.includes("PRIVATE") && !s.stderr.includes("PRIVATE KEY-----"), "nothing secret was shown");
  const sent = readFileSync(`${d}/gh.stdin`, "utf8");
  assert.match(sent, /^-----BEGIN PRIVATE KEY-----/);
  assert.match(readFileSync(`${d}/gh.args`, "utf8"), /secret set RELEASE_SIGNING_KEY/);
  assert.ok(verifyManifest("m", signManifest("m", privateKeyFrom(sent)), readFileSync(pub2, "utf8")));
  // a failing gh writes no public key
  writeFileSync(`${d}/bin/gh`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const pub3 = `${d}/third.pub`;
  const f = spawnSync(process.execPath, [script("release-keygen.mjs"), "--set-secret", "--public-out", pub3], { env: cleanEnv({ PATH: `${d}/bin:${process.env.PATH}` }), encoding: "utf8" });
  assert.notEqual(f.status, 0); assert.ok(!existsSync(pub3));
  // never in CI
  const ci = spawnSync(process.execPath, [script("release-keygen.mjs"), "--public-out", `${d}/ci.pub`], { env: { ...process.env, CI: "true" }, encoding: "utf8" });
  assert.notEqual(ci.status, 0); assert.match(ci.stderr, /not in CI/);
  rmSync(d, { recursive: true });
});

test("sign-release writes a manifest and signature that verify; it fails closed without the key or with the wrong one", () => {
  const d = fakeRelease("v1.0.0-rc1"), k = generateReleaseKey(), other = generateReleaseKey();
  writeFileSync(`${d}/pub`, k.publicPem);
  const run = (env, extra = []) => spawnSync(process.execPath, [script("sign-release.mjs"), "--dir", `${d}/release`, "--public", `${d}/pub`, ...extra], { env: cleanEnv(env), encoding: "utf8" });
  const none = run({}); assert.notEqual(none.status, 0); assert.match(none.stderr, /RELEASE_SIGNING_KEY is not set/); assert.ok(!existsSync(`${d}/release/${SIGNATURE}`));
  const junk = run({ RELEASE_SIGNING_KEY: "hunter2" }); assert.notEqual(junk.status, 0); assert.ok(!junk.stderr.includes("hunter2"));
  const wrong = run({ RELEASE_SIGNING_KEY: other.privatePem }); assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /not the private half/); assert.ok(!existsSync(`${d}/release/${MANIFEST}`));
  const mismatch = run({ RELEASE_SIGNING_KEY: k.privatePem, EPC_RELEASE_VERSION: "v9.9.9" }); assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /was expected/);
  const ok = run({ RELEASE_SIGNING_KEY: k.privatePem }); assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!ok.stdout.includes("PRIVATE") && !ok.stderr.includes("PRIVATE"));
  const man = readFileSync(`${d}/release/${MANIFEST}`, "utf8");
  assert.equal(JSON.parse(man).version, "1.0.0-rc1");
  assert.ok(verifyManifest(man, readFileSync(`${d}/release/${SIGNATURE}`, "utf8"), k.publicPem));
  const nopub = spawnSync(process.execPath, [script("sign-release.mjs"), "--dir", `${d}/release`, "--public", `${d}/missing.pub`], { env: cleanEnv({ RELEASE_SIGNING_KEY: k.privatePem }), encoding: "utf8" });
  assert.notEqual(nopub.status, 0); assert.match(nopub.stderr, /release-keygen/);
  rmSync(d, { recursive: true });
});

test("get.sh is built with the verifier and the key; the template and a no-key build stay fail-closed", () => {
  const k = generateReleaseKey();
  const withKey = buildGetSh(root, k.publicPem);
  assert.ok(withKey.includes("epc_verify_release()") && withKey.includes(k.publicPem.trim()) && !withKey.includes("@@EPC_"));
  const noKey = buildGetSh(root, "");
  assert.ok(noKey.includes("epc_verify_release()") && !noKey.includes("BEGIN PUBLIC KEY"));
  assert.throws(() => buildGetSh(root, "-----BEGIN PUBLIC KEY-----\n'; rm -rf / #\n-----END PUBLIC KEY-----\n"), /not a PEM public key/);
  const sh = spawnSync("bash", ["-n"], { input: withKey }); assert.equal(sh.status, 0, String(sh.stderr));
});

test("the repository holds no private key material", () => {
  const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of out) assert.ok(!/\.(pem|key)$/.test(f) || f.endsWith("-keyring.asc"), `${f} looks like key material`);
  const body = /BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{40,}/;
  for (const f of out) {
    let t; try { t = readFileSync(`${root}${f}`, "utf8"); } catch { continue; }
    if (f !== "scripts/release-signing.test.mjs") assert.ok(!body.test(t), `${f} contains a private key`);
  }
});
