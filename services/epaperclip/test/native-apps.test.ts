import { describe, expect, it, vi } from "vitest";
import { nativeAppRoutes } from "../src/features/native-apps.ts";
import type { FeatureCtx } from "../src/features/index.ts";
import { HttpError } from "../src/http.ts";

function context(path: string, method = "GET", body: unknown = {}) {
  const url = new URL(path, "https://device.example");
  const user = { username: "sam@pve" };
  const ctx = {
    path: url.pathname, url, method, HttpError,
    session: vi.fn(() => user), sameSite: vi.fn(), readJson: vi.fn(async () => body), json: vi.fn(),
    res: { writeHead: vi.fn(), end: vi.fn() },
    gateway: { publicUrl: "https://device.example", userCall: vi.fn(async () => ({ status: 200, data: { credential: "must-not-leave-engine" } })), oauthClientMetadata: vi.fn(async () => ({ client_name: "Paperclip" })) },
  };
  return { ctx, run: () => nativeAppRoutes(ctx as unknown as FeatureCtx), user };
}

describe("native provider callbacks", () => {
  it("lands without a session and carries only expected fields in a same-origin fragment", async () => {
    const { ctx, run } = context("/api/tools/oauth/callback?state=s1&code=one-time&redirect_uri=https://bad.example&error_description=ignored");
    await run();
    expect(ctx.session).not.toHaveBeenCalled();
    expect(ctx.res.writeHead).toHaveBeenCalledWith(303, expect.objectContaining({ Location: "/provider-callback#state=s1&code=one-time", "Referrer-Policy": "no-referrer" }));
    expect(ctx.gateway.userCall).not.toHaveBeenCalled();
  });
  it("refuses ambiguous callback parameters", async () => {
    const { run } = context("/api/tools/oauth/callback?state=a&state=b");
    await expect(run()).rejects.toMatchObject({ status: 400 });
  });
  it("completes under the caller's identity after CSRF verification and returns no engine payload", async () => {
    const { ctx, run, user } = context("/api/native-apps/complete", "POST", { state: "s1", code: "code&other=value" });
    await run();
    expect(ctx.sameSite).toHaveBeenCalledOnce();
    expect(ctx.gateway.userCall).toHaveBeenCalledWith(user, "GET", "/api/tools/oauth/callback?state=s1&code=code%26other%3Dvalue");
    expect(ctx.json).toHaveBeenCalledWith(200, { ok: true }, { "Cache-Control": "no-store" });
  });
  it("does not call the engine for invalid input or a cross-site completion", async () => {
    for (const body of [{ code: "code" }, { state: "s", code: "c", error: "denied" }, { state: "s", code: "c", target: "other" }]) {
      const { ctx, run } = context("/api/native-apps/complete", "POST", body);
      await expect(run()).rejects.toMatchObject({ status: 400 });
      expect(ctx.gateway.userCall).not.toHaveBeenCalled();
    }
    const { ctx, run } = context("/api/native-apps/complete", "POST", { state: "s", code: "c" });
    ctx.sameSite.mockImplementation(() => { throw new HttpError(403, "cross_site", "Not allowed"); });
    await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(ctx.gateway.userCall).not.toHaveBeenCalled();
  });
  it("does not claim success when the engine rejects state or provider consent", async () => {
    const { ctx, run } = context("/api/native-apps/complete", "POST", { state: "s", error: "access_denied" });
    ctx.gateway.userCall.mockResolvedValue({ status: 303, data: { credential: "not-returned" } });
    await expect(run()).rejects.toMatchObject({ status: 400, code: "oauth_failed" });
    expect(ctx.json).not.toHaveBeenCalled();
  });
});
