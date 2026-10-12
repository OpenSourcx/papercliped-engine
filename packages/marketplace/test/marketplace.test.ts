import { describe, expect, it } from "vitest";
import { MarketplaceError, generateSigningKey, signIndex, trustedKey, verifyIndex, type Index } from "../src/index.ts";

const key = generateSigningKey();
const keys = [trustedKey(key.publicKeyPem)];
const NOW = Date.parse("2026-10-12T00:00:00Z");
const INTEGRITY = `sha512-${"A".repeat(86)}==`;

const ENTRY = { id: "slack", kind: "connector", connectorKind: "chat", name: "Slack", vendor: "Slack", summary: "Post updates.", version: "1.2.0", source: { type: "npm", name: "@epc/slack", version: "1.2.0", integrity: INTEGRITY }, permissions: ["net.slack.com"] };
const index = (over: Partial<Index> = {}, entries: unknown[] = [ENTRY]) => ({ schema: 1, sequence: 5, generatedAt: "2026-10-11T00:00:00Z", expires: "2026-11-11T00:00:00Z", entries, ...over });
const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const signed = (o: unknown) => ({ b: bytes(o), sig: signIndex(bytes(o), key.privateKeyPem, key.publicKeyPem) });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as MarketplaceError).code; } return null; };

describe("the signed marketplace index", () => {
  it("accepts a correctly signed catalog", () => {
    const { b, sig } = signed(index());
    const got = verifyIndex(b, sig, { keys, now: NOW });
    expect(got.entries[0]).toMatchObject({ id: "slack", source: { type: "npm", name: "@epc/slack" } });
  });

  it("refuses a catalog changed after signing", () => {
    const { sig } = signed(index());
    expect(code(() => verifyIndex(bytes(index({ sequence: 6 })), sig, { keys, now: NOW }))).toBe("bad_signature");
  });

  it("refuses a key it doesn't trust, and works with none pinned", () => {
    const other = generateSigningKey();
    const b = bytes(index());
    expect(code(() => verifyIndex(b, signIndex(b, other.privateKeyPem, other.publicKeyPem), { keys, now: NOW }))).toBe("unknown_key");
    expect(code(() => verifyIndex(b, signIndex(b, key.privateKeyPem, key.publicKeyPem), { keys: [], now: NOW }))).toBe("unknown_key");
  });

  it("refuses an expired catalog and a rollback to an older one", () => {
    const { b, sig } = signed(index());
    expect(code(() => verifyIndex(b, sig, { keys, now: Date.parse("2027-01-01") }))).toBe("expired");
    expect(code(() => verifyIndex(b, sig, { keys, now: NOW, lastSequence: 9 }))).toBe("rollback");
    expect(code(() => verifyIndex(b, sig, { keys, now: NOW, lastSequence: 5 }))).toBeNull();
  });

  it("refuses unpinned or malformed sources and duplicate ids, even when signed", () => {
    const loose = signed(index({}, [{ ...ENTRY, source: { type: "npm", name: "@epc/slack", version: "^1.0.0", integrity: INTEGRITY } }]));
    expect(code(() => verifyIndex(loose.b, loose.sig, { keys, now: NOW }))).toBe("malformed");
    const noHash = signed(index({}, [{ ...ENTRY, source: { type: "npm", name: "@epc/slack", version: "1.2.0", integrity: "sha1-abc" } }]));
    expect(code(() => verifyIndex(noHash.b, noHash.sig, { keys, now: NOW }))).toBe("malformed");
    const dup = signed(index({}, [ENTRY, ENTRY]));
    expect(code(() => verifyIndex(dup.b, dup.sig, { keys, now: NOW }))).toBe("malformed");
    const markup = signed(index({}, [{ ...ENTRY, name: "<script>" }]));
    expect(code(() => verifyIndex(markup.b, markup.sig, { keys, now: NOW }))).toBe("malformed");
  });

  it("refuses a garbled signature file", () => {
    expect(code(() => verifyIndex(bytes(index()), "nonsense", { keys, now: NOW }))).toBe("malformed");
  });
});
