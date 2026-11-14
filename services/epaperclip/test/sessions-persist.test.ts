import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDLE_MS, MAX_MS, PERSIST_TOUCH_MS, SessionStore, type SessionPersistence } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";

const KEY = "sessions.v1";
const persistenceOver = (state: StateStore): SessionPersistence => ({ load: () => state.getSecret(KEY), save: (v) => state.setSecret(KEY, v) });
const dir = () => mkdtempSync(join(tmpdir(), "epc-sess-"));

/** Two "processes" over one state directory, with a shared fake clock. */
function boot(d: string, clock: { t: number }) {
  const state = new StateStore(d);
  return new SessionStore(() => clock.t, persistenceOver(state));
}

describe("sessions survive a restart", () => {
  it("keeps a signed-in session, its Proxmox ticket and its engine login across a restart", () => {
    const d = dir();
    const clock = { t: 1_000_000 };
    const a = boot(d, clock);
    const s = a.create("ana@pve", "PVE:ticket", "csrf-1", { ip: "10.0.0.5", via: "password" });
    s.engine = { cookie: "paperclip.session_token=abc", userId: "u1", at: clock.t };
    a.renew(s, "PVE:ticket2", "csrf-2"); // a structural change writes the engine login too

    clock.t += 5 * 60_000;
    const b = boot(d, clock);
    const back = b.get(s.id);
    expect(back).toMatchObject({ username: "ana@pve", ticket: "PVE:ticket2", csrf: "csrf-2", via: "password" });
    expect(back?.engine?.cookie).toBe("paperclip.session_token=abc");
  });

  it("does not write the ticket to disk in the clear", () => {
    const d = dir();
    const clock = { t: 5_000 };
    boot(d, clock).create("ana@pve", "PVE:SECRET-TICKET-VALUE", "SECRET-CSRF-VALUE");
    const raw = readFileSync(join(d, "state.json"), "utf8");
    expect(raw).not.toContain("SECRET-TICKET-VALUE");
    expect(raw).not.toContain("SECRET-CSRF-VALUE");
    expect(raw).toContain(KEY);
  });

  it("still ends a session that idled out, or hit its total or federated cap, while the host was down", () => {
    const d = dir();
    const clock = { t: 10_000_000 };
    const a = boot(d, clock);
    const idle = a.create("idle@pve", "t", "c");
    const old = a.create("old@pve", "t", "c");
    const fed = a.create("fed@pve", "t", "c", { maxAt: clock.t + 8 * 3600_000, via: "openid" });
    // keep "old" alive but past its total cap by touching it every hour
    for (let i = 0; i < 12; i++) {
      clock.t += 3600_000;
      a.get(old.id);
      a.get(fed.id);
    }
    expect(clock.t - old.createdAt).toBeGreaterThan(MAX_MS - 1);
    a.flush();
    clock.t += 60_000;
    const b = boot(d, clock);
    expect(b.get(idle.id)).toBeNull(); // idle for 12 h
    expect(b.get(old.id)).toBeNull(); // past 12 h in total
    expect(b.get(fed.id)).toBeNull(); // past its 8 h federated cap
  });

  it("an idle session does not come back after the idle limit passes during the restart", () => {
    const d = dir();
    const clock = { t: 0 };
    const a = boot(d, clock);
    const s = a.create("ana@pve", "t", "c");
    clock.t += IDLE_MS + 1; // the host was down for longer than the idle limit
    expect(boot(d, clock).get(s.id)).toBeNull();
  });

  it("keeps revocation: ending a person's sessions, one session, or a link stays ended after a restart", () => {
    const d = dir();
    const clock = { t: 1 };
    const a = boot(d, clock);
    const x = a.create("x@pve", "t", "c");
    const y = a.create("y@pve", "t", "c");
    const l1 = a.create("l@pve", "t", "c", { link: "link-1" });
    const keep = a.create("keep@pve", "t", "c");
    a.destroyUser("x@pve");
    a.destroy(y.id);
    a.destroyLink("link-1");
    const b = boot(d, clock);
    expect(b.get(x.id)).toBeNull();
    expect(b.get(y.id)).toBeNull();
    expect(b.get(l1.id)).toBeNull();
    expect(b.get(keep.id)).not.toBeNull();
    // the epoch that makes API-token principals re-check also survives
    expect(b.epoch("x@pve")).toBe(1);
  });

  it("writes plain use to disk at most once a minute, but writes the last use on flush", () => {
    const d = dir();
    const clock = { t: 100 };
    const a = boot(d, clock);
    const s = a.create("ana@pve", "t", "c");
    clock.t += 10_000;
    a.get(s.id); // within a minute of the last write: memory only
    expect(boot(d, clock).peek(s.id)?.lastSeen).toBe(100);
    clock.t += PERSIST_TOUCH_MS;
    a.get(s.id); // a minute on: written
    expect(boot(d, clock).peek(s.id)?.lastSeen).toBe(clock.t);
    clock.t += 1_000;
    a.get(s.id);
    a.flush();
    expect(boot(d, clock).peek(s.id)?.lastSeen).toBe(clock.t);
  });

  it("starts empty, and does not throw, when the saved value is damaged or unreadable", () => {
    const clock = { t: 1 };
    for (const load of [() => "not json", () => JSON.stringify({ v: 2, sessions: [] }), () => JSON.stringify({ v: 1, sessions: [{ id: 5 }, null, "x"] }), () => { throw new Error("vault"); }]) {
      const st = new SessionStore(() => clock.t, { load, save: () => {} });
      expect(st.size).toBe(0);
    }
  });

  it("a failing write never breaks sign-in", () => {
    const st = new SessionStore(() => 1, { load: () => null, save: () => { throw new Error("disk full"); } });
    const s = st.create("ana@pve", "t", "c");
    expect(st.get(s.id)?.username).toBe("ana@pve");
  });

  it("never saves an API-token principal", () => {
    let saved = "";
    const st = new SessionStore(() => 1, { load: () => null, save: (v) => { saved = v; } });
    const s = st.create("ana@pve", "t", "c");
    s.apiToken = { id: "tok", name: "n", readOnly: true, privsep: true, pveTokenId: "a@pve!n", pveSecret: "SUPER-SECRET" };
    st.destroy("nothing"); // no-op
    st.renew(s, "t2", "c2"); // forces a write
    expect(saved).not.toContain("SUPER-SECRET");
    expect(JSON.parse(saved).sessions).toHaveLength(0);
  });
});
