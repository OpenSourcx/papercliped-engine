import { describe, it, expect } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import { PaperclipedDeviceIdentity, pairingApprovalUrl } from "../src/paperclipedAccount.ts";
import { StateStore } from "../src/state.ts";

const token = Buffer.alloc(32,7).toString("base64url");
const pairingId="b3b5b205-dab1-410f-8acb-1bb16d34d8d3";
const accountId="acct_existing";
describe("Managed Papercliped account connector device identity",()=>{
  it("persists one local vault key and exports only an enrollment public key",()=>{
    const state=new StateStore(null);
    const one=new PaperclipedDeviceIdentity(state);
    const first=one.publicIdentity();
    const second=new PaperclipedDeviceIdentity(state).publicIdentity();
    expect(first.deviceKeyThumbprint).toEqual(second.deviceKeyThumbprint);
    expect(first.publicKeyJwk).toEqual(second.publicKeyJwk);
    expect(first.deviceKeyThumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.publicKeyJwk.d).toBeUndefined();
    expect(state.getSetting("papercliped.connect.deviceKey")).toBeUndefined();
    expect(state.getSecret("papercliped.connect.deviceKey")).toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(first)).not.toContain("PRIVATE");
  });
  it("signs the exact Connect enrollment and account confirmation context",()=>{
    const signer=new PaperclipedDeviceIdentity(new StateStore(null));
    const pub=createPublicKey({key:signer.publicIdentity().publicKeyJwk,format:"jwk"});
    const signature=Buffer.from(signer.signChallenge(token),"base64url");
    expect(signature).toHaveLength(64);
    expect(verify("sha256",Buffer.from("papercliped-connect:pairing:v1:"+token),{key:pub,dsaEncoding:"ieee-p1363"},signature)).toBe(true);
    const finalSignature=Buffer.from(signer.signAccountConfirmation(pairingId,accountId,token),"base64url");
    const msg=Buffer.from("papercliped-connect:completion:v1:"+pairingId+":"+accountId+":"+token);
    expect(verify("sha256",msg,{key:pub,dsaEncoding:"ieee-p1363"},finalSignature)).toBe(true);
    expect(verify("sha256",Buffer.from("papercliped-connect:completion:v1:"+pairingId+":acct_attacker:"+token),{key:pub,dsaEncoding:"ieee-p1363"},finalSignature)).toBe(false);
  });
  it("rejects forged challenge, pairing id and account id without making a URL with tokens",()=>{
    const signer=new PaperclipedDeviceIdentity(new StateStore(null));
    expect(()=>signer.signChallenge("../bad")).toThrow();
    expect(()=>signer.signAccountConfirmation("bad",accountId,token)).toThrow();
    expect(()=>signer.signAccountConfirmation(pairingId,"../bad",token)).toThrow();
    const url=pairingApprovalUrl(pairingId);
    expect(url).toContain("https://console.papercliped.co/devices/pair?pairing_id=");
    expect(url).not.toContain(token);
    expect(()=>pairingApprovalUrl("https://evil.example/")).toThrow();
  });
});
