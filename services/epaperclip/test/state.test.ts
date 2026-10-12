import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.ts";
import { Vault } from "../src/vault.ts";

const dir = () => mkdtempSync(join(tmpdir(), "epc-state-"));

describe("vault", () => {
  it("seals and opens a secret, with a fresh IV each time", () => {
    const v = Vault.ephemeral();
    const a = v.seal("k", "s3cret-value");
    const b = v.seal("k", "s3cret-value");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(a).toMatchObject({ v: 1, kid: v.kid });
    expect(v.open("k", a)).toBe("s3cret-value");
  });

  it("refuses tampered ciphertext, a swapped name, or another key", () => {
    const v = Vault.ephemeral();
    const s = v.seal("engine.user.a", "pw");
    const flipped = Buffer.from(s.ct, "base64");
    flipped[0] ^= 1;
    expect(() => v.open("engine.user.a", { ...s, ct: flipped.toString("base64") })).toThrow("integrity");
    expect(() => v.open("engine.user.b", s)).toThrow("integrity");
    expect(() => v.open("engine.user.a", { ...s, tag: Buffer.alloc(16).toString("base64") })).toThrow("integrity");
    expect(() => Vault.ephemeral().open("engine.user.a", s)).toThrow("another vault key");
  });

  it("creates vault.key once, 0600 and 32 bytes, and fixes a loosened mode", () => {
    const d = dir();
    const v1 = Vault.open(d);
    const st = statSync(join(d, "vault.key"));
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.size).toBe(32);
    chmodSync(join(d, "vault.key"), 0o644);
    const v2 = Vault.open(d);
    expect(v2.kid).toBe(v1.kid);
    expect(statSync(join(d, "vault.key")).mode & 0o777).toBe(0o600);
    writeFileSync(join(d, "vault.key"), "short");
    expect(() => Vault.open(d)).toThrow("not a vault key");
  });
});

describe("state", () => {
  it("keeps settings and secrets across restarts, with secrets never in plain text", () => {
    const d = dir();
    const s = new StateStore(d);
    s.setSecret("connector.openai.apiKey", "sk-very-secret-key-123456");
    s.setSetting("connectors", { openai: { last4: "3456" } });
    const text = readFileSync(join(d, "state.json"), "utf8");
    expect(text).not.toContain("very-secret");
    expect(statSync(join(d, "state.json")).mode & 0o777).toBe(0o600);
    const again = new StateStore(d);
    expect(again.getSecret("connector.openai.apiKey")).toBe("sk-very-secret-key-123456");
    expect(again.getSetting("connectors")).toEqual({ openai: { last4: "3456" } });
    again.deleteSecret("connector.openai.apiKey");
    again.setSetting("connectors", undefined);
    expect(new StateStore(d).getSecret("connector.openai.apiKey")).toBeNull();
    expect(new StateStore(d).getSetting("connectors")).toBeUndefined();
  });

  it("writes atomically: no temporary files left, and a failed write keeps the old state on disk and in memory", () => {
    const d = dir();
    let fail = false;
    const s = new StateStore(d, {
      beforeRename: () => {
        if (fail) throw new Error("disk full");
      },
    });
    s.setSetting("a", 1);
    expect(readdirSync(d).sort()).toEqual(["state.json", "vault.key"]);
    fail = true;
    expect(() => s.setSetting("a", 2)).toThrow("disk full");
    expect(readdirSync(d).sort()).toEqual(["state.json", "vault.key"]);
    expect(s.getSetting("a")).toBe(1);
    expect(new StateStore(d).getSetting("a")).toBe(1);
  });

  it("hands out copies, refuses odd names, and won't overwrite a damaged file", () => {
    const s = new StateStore(null);
    s.setSetting("obj", { list: [1] });
    s.getSetting<{ list: number[] }>("obj")!.list.push(2);
    expect(s.getSetting("obj")).toEqual({ list: [1] });
    expect(() => s.setSecret("../etc", "x")).toThrow("bad state key");
    const d = dir();
    writeFileSync(join(d, "state.json"), "{not json");
    expect(() => new StateStore(d)).toThrow();
    expect(readFileSync(join(d, "state.json"), "utf8")).toBe("{not json");
  });
});
