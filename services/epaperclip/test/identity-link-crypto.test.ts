import { describe, expect, it } from "vitest";
import { canonicalIdentityMessage, challengeOf, newVerifier, sessionBinding } from "../src/identityLinkCrypto.ts";

describe("identity-link primitives (contract sections 5.2 and 5.3)", () => {
  it("S256 challenge matches the RFC 7636 test vector", () => {
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("makes 43-character base64url verifiers from the platform random source, each with its own challenge", () => {
    const a = newVerifier(); const b = newVerifier();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(challengeOf(a.verifier)).toBe(a.challenge);
    expect(newVerifier(() => new Uint8Array(32)).verifier).toBe("A".repeat(43));
  });
  it("builds the canonical message exactly as specified: prefix line, one base64url field per line, order kept, empty values present", () => {
    const m = canonicalIdentityMessage("confirm", [["deviceId", "d1"], ["linkId", "l1"], ["replaceLinkId", ""], ["ts", 1730000000]]);
    expect(m).toBe(`papercliped-connect:identity:confirm:v1\ndeviceId=ZDE\nlinkId=bDE\nreplaceLinkId=\nts=${Buffer.from("1730000000").toString("base64url")}\n`);
  });
  it("cannot be confused by values that contain newlines or equals signs, and rejects bad names and unknown actions", () => {
    const a = canonicalIdentityMessage("start", [["a", "x\nb=eQ"], ["c", "1"]]);
    const b = canonicalIdentityMessage("start", [["a", "x"], ["b", "y"], ["c", "1"]]);
    expect(a.split("\n")).toHaveLength(4);
    expect(a).not.toBe(b);
    expect(() => canonicalIdentityMessage("start", [["a=b", "x"]])).toThrow();
    expect(() => canonicalIdentityMessage("tunnel" as never, [])).toThrow();
    expect(canonicalIdentityMessage("poll", [["x", "é"]])).toContain(`x=${Buffer.from("é", "utf8").toString("base64url")}`);
  });
  it("binds to link and session: any change of either changes the binding, and it is deterministic", () => {
    const x = sessionBinding("link1", "sess1");
    expect(sessionBinding("link1", "sess1")).toBe(x);
    expect(sessionBinding("link2", "sess1")).not.toBe(x);
    expect(sessionBinding("link1", "sess2")).not.toBe(x);
    expect(x).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
