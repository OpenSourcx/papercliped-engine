# Unified Papercliped account connector for ePaperclip

**Status: security and protocol foundation, not live enrollment.**

## Product goal

A customer has one Papercliped product account for:
- MCP app connections and grants managed at the hosted Papercliped gateway
- Papercliped Connect subscriptions, device names, remote access status and billing
- ePaperclip device ownership, local settings and pairing status
- Future PinOS installations using the same identity model

A customer's central login (email code, Windows Hello/phone/hardware passkey, optionally Google OAuth) happens at the planned `auth.papercliped.co` portal. The issuer is Supabase Auth in the existing shared Paperclipped project. We must **not** add a second cloud account system inside ePaperclip.

## Device pairing

ePaperclip's existing `StateStore` vault is the trusted device-side key store. `services/epaperclip/src/paperclipedAccount.ts` creates an ECDSA P-256 device private key and seals it locally, returning only the public key and an SHA-256 SPKI thumbprint. The initial and final pairing signature formats match Connect's `device-crypto.mjs`.

**This foundation alone does not enroll a device.** The future local admin-only feature needs to:
1. Verify a live Proxmox administrator using `ctx.asUser()` and `ctx.isNodeAdmin()`, and require the same-site mutation CSRF header.
2. Generate/load the local device key and ask the Connect backend for a short-lived, one-time pairing challenge.
3. Prove device possession by signing the challenge (never exporting key material).
4. Show a **pairing ID** / QR link to `https://console.papercliped.co/devices/pair`, never embedding a raw challenge or a privileged token.
5. Have the customer independently authenticate with the SAME Papercliped account, verify email/passkey as required, explicitly approve device ownership, and optionally assign the device to their account.
6. Show the selected canonical account ID to the local admin; the device signs a second confirmation bound to the account and pairing ID.
7. Atomically consume the challenge and then provision/rotate the Cloudflare tunnel if entitled.

Hosted account ownership NEVER automatically creates Proxmox credentials, IAM roles, or full-control MCP grants. Device login and existing Proxmox WebAuthn or OIDC realms remain in place. An administrator can separately configure an OIDC realm that trusts the central identity provider, but that mapping must be locally approved and does not bypass Proxmox privileges.

## Connection modes

- **Managed Connect:** one Papercliped account, hosted subscription, service-managed Cloudflare tunnel. No Cloudflare account/token required from customer.
- **Self-managed Cloudflare:** existing ePaperclip Publishing feature and device-owned Cloudflare token. Do not remove or automatically migrate it.
- **Local-only:** Proxmox-backed console and MCP remain functional without Connect or any hosted subscription.

## Next integration work

Build admin-only host APIs and functional Settings → Remote Access → Papercliped Connect panel after Connect's public pairing API, session validation, and trusted database credentials exist. UI refinement follows working authorization, not before.

Current code does **not** enable a hosted browser sign-in, activate tunnels or modify Proxmox user permissions.

## Pairing and remote-access mode (device side)

Administrator-only API under `/api/papercliped/connect/`: `GET status`; `POST mode`, `pairing/start`, `pairing/poll`, `pairing/confirm`, `pairing/cancel`, `unpair`. Base URL: `EPC_CONNECT_URL` (default `https://connect.papercliped.co`, https only).

1. `pairing/start`: gets a one-time challenge from Connect and proves possession of this machine's device key. The response carries only the approval page address, never the challenge.
2. The account owner signs in at Connect and approves that page.
3. `pairing/poll` shows which account approved. The administrator must confirm that exact account in `pairing/confirm`; the device then signs a message naming that account and pairing id, and Connect binds the device to it. Any other account is refused.

Exactly one remote-access mode is active: `local` (default), `cloudflare-self` or `connect`. Switching between the two remote modes goes through `local`. While `connect` is active the Cloudflare self-management endpoints return 409, so the two can't share the tunnel service, token file or public URL. If Connect is unreachable the API answers 502 and nothing local changes.

## The managed tunnel (device side)

When the mode is `connect` and the machine is paired, `ConnectLink` (`services/epaperclip/src/connectLink.ts`) keeps this machine's tunnel in line with Connect:

1. It signs `papercliped-connect:tunnel:v1:<deviceId lowercase>:<unix seconds>` with the device key (`PaperclipedDeviceIdentity.signTunnelRequest`, ECDSA P-256 SHA-256, ieee-p1363, base64url) and posts `{publicKeyJwk, ts, signature}` to `POST /api/v1/devices/:deviceId/tunnel-credentials`. The device clock must be within about a minute of Connect's.
2. Answers:

| Connect says | Device does |
|---|---|
| 200 `{hostname, tunnelToken, origin: "https://127.0.0.1:443"}` | validates it (hostname shape, token charset, the exact origin), hands the token to the root helper, re-checks in 15 minutes |
| 409 `not_ready` (provisioning or paused) | keeps polling, 5 s doubling to 5 min; nothing is changed meanwhile |
| 403 `no_entitlement` | stops and removes the tunnel; status says "Subscription needed"; the OAuth address falls back to the local one; keeps checking every 10 minutes and comes back by itself |
| 403 `not_available` | counted; the tunnel is stopped after 3 in a row (a skewed clock looks identical to a removed device); status says Connect doesn't recognise the machine |
| network error, 429, 5xx | keeps the last known state (a running tunnel keeps running); backoff 10 s doubling to 10 min, plus up to 20% jitter |
| anything else | `invalid`: reported, nothing changed |

A Connect or helper failure only changes the reported state; sign-in, the console and local MCP never depend on it.

**One helper owns the tunnel.** `deploy/epaperclip-publish.mjs` (socket `/run/epaperclip-publish/publish.sock`, root) is the only writer of `epaperclip-cloudflared.service` and `/etc/epaperclip/cloudflared.env`. Operations: `install {owner, token}`, `remove {owner}`, `status`. The owner, `self` (own Cloudflare account) or `connect`, is recorded in `/etc/epaperclip/cloudflared.owner`; installing for one owner while the other holds the service is refused, and `remove` only removes the caller's own tunnel. An install from before owners existed counts as `self`. The token file is root-owned `0600`, is only ever sent over the private socket, and is never logged, stored in the host's state, or returned by `status` or any API. `--uninstall` deletes the token file and owner marker even without `--purge`.

**Status** (`GET /api/papercliped/connect/status`) includes `tunnel` while in Connect mode: `state` (`connecting`, `waiting`, `running`, `stopped`, `subscription_needed`, `unavailable`, `offline`, `error`), a plain-language `message`, `hostname`, `lastResult`, `lastCheckedAt`, `lastOkAt`, `nextCheckAt`, and `helper` (`{owner, installed, active}` read live from the helper, or `{error}` if the helper can't be reached). `running` requires the helper to report the service active.

**Public address.** In `connect` mode with a hostname, the OAuth issuer, protected-resource metadata and MCP URL become `https://<hostname>`; in any other mode (or after the subscription ends) they revert to `EPC_PUBLIC_URL` or the request's Host. Apps that registered against the old address re-discover on their next sign-in.

**Internet exposure.** Tunnel traffic reaches the host service from cloudflared on loopback, so nothing is trusted because it is local: sign-in, the CSRF header plus same-origin check, the bearer-token checks on `/mcp`, and consent are unchanged. While in `connect` mode, and only for a loopback peer, `CF-Connecting-IP` is used as the client address (IPv6 by /64) for login lockouts, token-failure counters, rate limits and the audit trail; otherwise every internet client would share one address bucket and one attacker could lock everyone out. Added for exposure: a cap of 100 registered-but-never-approved apps, 120 registrations per hour across all addresses (besides 10 per address), and a per-address limit on `/mcp` attempts before authentication. Still true: anyone on the internet can reach `/api/login`, so use Proxmox two-factor for administrators; a username can be locked out for 15 minutes by failed guesses (the same as on the LAN).

**Leaving Connect.** Switching mode, unpairing or uninstalling removes the Connect token and service through the helper. If the helper can't be reached the mode still changes and removal is retried until it succeeds (at start and on every re-check).

### Missing on the Connect side
Unpairing is local only. Connect has no owner or device route to retire a device, so its tunnel, DNS record and seat remain until the owner removes them in the console (or an admin revokes them). Contract needed: `POST /api/v1/devices/:deviceId/revoke` with the same `{publicKeyJwk, ts, signature}` body, signed over `papercliped-connect:revoke:v1:<deviceId lowercase>:<ts>`, answering 200 `{ok: true}` (idempotent), 403 `not_available`; it enqueues the provisioning `revoke` job (tunnel and DNS removal) and releases the seat. Once it exists, `ConnectLink.unpair()` should call it before forgetting the device and keep a retry record if Connect is unreachable.

### Verified only against fakes
The Connect credentials endpoint (real signature and freshness checks, but not Connect's code), the privileged helper (real program, fake `systemctl`, temporary directories, a real unix socket) and every `cloudflared`/systemd effect. Nothing here has run against live Connect, a real tunnel token or a real `cloudflared`.

Unpair also removes the machine on the Connect side: `POST /api/v1/devices/:deviceId/device-revoke` with `{publicKeyJwk, ts, signature}` (signature over `papercliped-connect:revoke:v1:<id>:<ts>`). Local unpair always happens immediately; if Connect is unreachable the removal stays pending and is retried at the next reconcile or start.
