import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Capabilities } from "./protocol.ts";
import { b64u, edPublicFromRaw, privateKeyOf, rawPublic, unb64u, verifyRaw, xPublicFromRaw, type Identity } from "./identity.ts";

/**
 * The worker channel's security layer. It sits between a WebSocket and the JSON messages, so the channel is encrypted
 * and authenticated on any network (tailnet, LAN, internet), with or without TLS:
 *
 *   1. hello      worker -> host   fresh X25519 key + nonce            (plain)
 *   2. challenge  host -> worker   fresh X25519 key + nonce, host Ed25519 key and a signature over both  (plain)
 *      The worker checks the host key against the one it pinned at pairing: a wrong host is refused before any secret is sent.
 *   3. both sides derive two ChaCha20-Poly1305 keys (HKDF of the X25519 secret, salted with both nonces).
 *   4. auth       worker -> host   (encrypted) worker Ed25519 key + signature over the whole transcript (+ pairing proof)
 *
 * Each direction counts messages and uses the count as the AEAD nonce, so a replayed, dropped, duplicated or
 * reordered message fails its tag and the connection is closed. Nothing here depends on the network being private.
 */

const te = (s: string) => Buffer.from(s, "utf8");
const lp = (b: Uint8Array) => Buffer.concat([Buffer.from([(b.length >> 8) & 255, b.length & 255]), b]);
const X_RAW_LEN = 32;

export interface HelloMsg { t: "hello"; v: 1; mode: "auth" | "adopt"; workerId?: string; eph: string; nc: string }
export interface ChallengeMsg { t: "challenge"; eph: string; ns: string; hostPub: string; sig: string }
export interface AuthPayload { pub: string; sig: string; pairing?: { id: string; secret: string }; name?: string; caps?: Capabilities }

function transcript(hello: HelloMsg, ns: string, ephS: string, hostPub: string): Buffer {
  return createHash("sha256")
    .update(Buffer.concat([te("epw1"), lp(te(hello.mode)), lp(te(hello.workerId ?? "")), lp(unb64u(hello.eph)), lp(unb64u(hello.nc)), lp(unb64u(ephS)), lp(unb64u(ns)), lp(unb64u(hostPub))]))
    .digest();
}

function xKeypair(): { priv: KeyObject; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { priv: privateKey, pub: rawPublic(publicKey) };
}

function deriveKeys(shared: Buffer, nc: string, ns: string): { c2s: Buffer; s2c: Buffer } {
  const salt = createHash("sha256").update(unb64u(nc)).update(unb64u(ns)).digest();
  const out = Buffer.from(hkdfSync("sha256", shared, salt, te("epw1 keys"), 64));
  return { c2s: out.subarray(0, 32), s2c: out.subarray(32, 64) };
}

/** Encrypts one direction. The message counter is the nonce; both ends advance in lockstep. */
export class Cipher {
  private n = 0n;
  private readonly key: Buffer;
  private readonly label: string;
  constructor(key: Buffer, label: string) {
    this.key = key;
    this.label = label;
  }
  private nonce(): Buffer {
    const b = Buffer.alloc(12);
    b.writeBigUInt64BE(this.n, 4);
    return b;
  }
  seal(value: unknown): string {
    const pt = te(JSON.stringify(value));
    const c = createCipheriv("chacha20-poly1305", this.key, this.nonce(), { authTagLength: 16 });
    c.setAAD(te(this.label), { plaintextLength: pt.length });
    const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    this.n += 1n;
    return `d.${b64u(ct)}`;
  }
  open<T = unknown>(frame: string): T {
    if (!frame.startsWith("d.")) throw new Error("channel: not an encrypted frame");
    const raw = unb64u(frame.slice(2));
    if (raw.length < 17) throw new Error("channel: short frame");
    const d = createDecipheriv("chacha20-poly1305", this.key, this.nonce(), { authTagLength: 16 });
    d.setAAD(te(this.label), { plaintextLength: raw.length - 16 });
    d.setAuthTag(raw.subarray(raw.length - 16));
    let pt: Buffer;
    try {
      pt = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
    } catch {
      throw new Error("channel: frame failed authentication");
    }
    this.n += 1n;
    return JSON.parse(pt.toString("utf8")) as T;
  }
}

export interface SecureSession {
  /** Seals a message for the peer. */
  seal(value: unknown): string;
  /** Opens a message from the peer; throws if it was altered, replayed or reordered. */
  open<T = unknown>(frame: string): T;
}

export class ClientHandshake {
  private readonly eph = xKeypair();
  private readonly nc = b64u(randomBytes(16));
  private hello_: HelloMsg | null = null;
  private readonly identity: Identity;
  private readonly pinnedHostKey: string;
  constructor(identity: Identity, pinnedHostKey: string) {
    this.identity = identity;
    this.pinnedHostKey = pinnedHostKey;
  }
  hello(mode: "auth" | "adopt", workerId?: string): string {
    this.hello_ = { t: "hello", v: 1, mode, ...(workerId ? { workerId } : {}), eph: this.eph.pub, nc: this.nc };
    return JSON.stringify(this.hello_);
  }
  /** Verifies the host and returns the session plus the encrypted `auth` frame to send. */
  finish(challengeText: string, extra: { pairing?: { id: string; secret: string }; name?: string; caps?: Capabilities } = {}): { session: SecureSession; authFrame: string } {
    const hello = this.hello_;
    if (!hello) throw new Error("channel: hello first");
    const ch = JSON.parse(challengeText) as ChallengeMsg;
    if (ch.t !== "challenge" || typeof ch.eph !== "string" || typeof ch.ns !== "string" || typeof ch.hostPub !== "string" || typeof ch.sig !== "string") throw new Error("channel: bad challenge");
    // The pinned key decides who the host is; whatever key the peer announces must be that one.
    if (ch.hostPub !== this.pinnedHostKey) throw new Error("channel: the host's key is not the one this worker was paired with");
    const tr = transcript(hello, ch.ns, ch.eph, ch.hostPub);
    if (!verifyRaw(ch.hostPub, Buffer.concat([te("epw1-host"), tr]), ch.sig)) throw new Error("channel: the host's signature is invalid");
    if (unb64u(ch.eph).length !== X_RAW_LEN) throw new Error("channel: bad key");
    const keys = deriveKeys(diffieHellman({ privateKey: this.eph.priv, publicKey: xPublicFromRaw(ch.eph) }), hello.nc, ch.ns);
    const out = new Cipher(keys.c2s, "c2s");
    const inn = new Cipher(keys.s2c, "s2c");
    const auth: AuthPayload = {
      pub: this.identity.publicKey,
      sig: b64u(sign(null, Buffer.concat([te("epw1-worker"), tr]), privateKeyOf(this.identity))),
      ...(extra.pairing ? { pairing: extra.pairing } : {}),
      ...(extra.name ? { name: extra.name } : {}),
      ...(extra.caps ? { caps: extra.caps } : {}),
    };
    return { session: { seal: (v) => out.seal(v), open: (f) => inn.open(f) }, authFrame: out.seal(auth) };
  }
}

export class ServerHandshake {
  private readonly eph = xKeypair();
  private readonly ns = b64u(randomBytes(16));
  private hello_: HelloMsg | null = null;
  private keys: { c2s: Buffer; s2c: Buffer } | null = null;
  private tr: Buffer | null = null;
  private readonly host: Identity;
  constructor(hostIdentity: Identity) {
    this.host = hostIdentity;
  }
  /** Parses the worker's hello; returns the challenge frame. */
  onHello(text: string): { hello: HelloMsg; challenge: string } {
    let h: HelloMsg;
    try {
      h = JSON.parse(text) as HelloMsg;
    } catch {
      throw new Error("channel: bad hello");
    }
    if (h.t !== "hello" || h.v !== 1 || (h.mode !== "auth" && h.mode !== "adopt") || typeof h.eph !== "string" || typeof h.nc !== "string") throw new Error("channel: bad hello");
    if (h.workerId !== undefined && (typeof h.workerId !== "string" || h.workerId.length > 80)) throw new Error("channel: bad hello");
    if (unb64u(h.eph).length !== X_RAW_LEN || unb64u(h.nc).length < 16) throw new Error("channel: bad hello");
    this.hello_ = h;
    this.tr = transcript(h, this.ns, this.eph.pub, this.host.publicKey);
    this.keys = deriveKeys(diffieHellman({ privateKey: this.eph.priv, publicKey: xPublicFromRaw(h.eph) }), h.nc, this.ns);
    const ch: ChallengeMsg = {
      t: "challenge",
      eph: this.eph.pub,
      ns: this.ns,
      hostPub: this.host.publicKey,
      sig: b64u(sign(null, Buffer.concat([te("epw1-host"), this.tr]), privateKeyOf(this.host))),
    };
    return { hello: h, challenge: JSON.stringify(ch) };
  }
  /** Opens the worker's `auth` frame and checks it proves possession of the key it names. */
  onAuth(frame: string): { session: SecureSession; auth: AuthPayload } {
    if (!this.keys || !this.tr || !this.hello_) throw new Error("channel: hello first");
    const inn = new Cipher(this.keys.c2s, "c2s");
    const out = new Cipher(this.keys.s2c, "s2c");
    const auth = inn.open<AuthPayload>(frame);
    if (typeof auth.pub !== "string" || typeof auth.sig !== "string") throw new Error("channel: bad auth");
    try {
      edPublicFromRaw(auth.pub);
    } catch {
      throw new Error("channel: bad auth");
    }
    if (!verifyRaw(auth.pub, Buffer.concat([te("epw1-worker"), this.tr]), auth.sig)) throw new Error("channel: the worker's signature is invalid");
    return { session: { seal: (v) => out.seal(v), open: (f) => inn.open(f) }, auth };
  }
}
