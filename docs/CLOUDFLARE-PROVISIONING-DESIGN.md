# Self-managed Cloudflare: provisioning design (not implemented)

Status: design only. Today the host stores a Cloudflare API token in the device vault, verifies it, lists active zones (read only) and returns an address plan; **it creates no tunnel, no DNS record and no Worker**. A privileged helper (`deploy/epaperclip-publish.mjs`) can run a tunnel from a run token an administrator supplies, and in Connect mode installs the Connect-issued token. This document says what building the missing part involves so the owner can decide; no Cloudflare operation has been requested or run, and no Cloudflare or Render key is held by any agent (`tool-request` is needed only when a real Cloudflare operation is wanted).

## What "worker system" should mean
Cloudflare Tunnel (cloudflared) is the path: an outbound connection from the device to Cloudflare, with a DNS record pointing a hostname at the tunnel. A Cloudflare Worker is code that runs at Cloudflare and is not needed to publish a device; do not build or promise one unless a responsibility is defined (for example an authentication gate in front of the tunnel) and approved.

## Flow to build (in order, each step visible in the Access page and reversible)
1. **Credential.** The administrator creates an API token in their own Cloudflare account with at least: Account, Cloudflare Tunnel: Edit; Zone, DNS: Edit on the chosen zone; Zone: Read. The page shows these scopes before the token is accepted and reports any that are missing (verified by calling what each permission allows). A token with more permissions is accepted: ePaperclip only rejects a token that lacks a required permission, and only ever uses these three. A narrowly scoped token is still recommended. Stored in the vault; never returned; never available to organization agents.
2. **Plan.** Choose zone and one subdomain label (existing validation). Show the exact hostname, the origin (`https://127.0.0.1:443`) and the three objects that will be created.
3. **Create (administrator confirms).** Host service, as the administrator: `POST /accounts/{id}/cfd_tunnel` (name `epaperclip-<device>`, `config_src: cloudflare`), `PUT .../configurations` (one ingress rule to the local HTTPS origin, `noTLSVerify` only for the loopback certificate), `POST /zones/{zone}/dns_records` (proxied CNAME to `<tunnel-id>.cfargotunnel.com`). The tunnel run token (`GET .../token`) is passed to the privileged helper over its existing private socket with owner `self`; it never touches the browser or logs.
4. **Verify.** Helper `status` (service active), then a signed health probe: an HTTPS GET to the hostname must reach this host's `/api/health` through Cloudflare. Show "Connected" only after that succeeds; otherwise show which step failed.
5. **Lifecycle.** Remove (delete DNS record, tunnel, helper service), rotate (new token), and recover (re-run create idempotently by name). Mode exclusivity with Connect is already enforced (`ConnectLink`).
6. **Authorization.** Only Proxmox administrators; every step audited; sign-in, CSRF, consent and permissions are unchanged by a public address (see `docs/PAPERCLIPED-ACCOUNT.md`).

## What cannot be verified without an account
Everything in 3 and 4 needs a real Cloudflare account and zone and a real `cloudflared`; the unit tests would use a fake API. The honest evidence level for a first build is "tested against a fake Cloudflare API"; "works" needs an approved disposable Cloudflare account (request through the broker: `tool-request new papercliped-engine cloudflare "<what and why>"`) and a Proxmox host with `cloudflared` installed.

## Open decisions for the owner
* Token model: user-supplied scoped token (above) versus an OAuth-style connect (Cloudflare offers no end-user OAuth for tunnels today).
* Whether the device needs an authentication gate at Cloudflare (Access) in front of the tunnel, or relies on ePaperclip's own login (current behaviour).
* Quick Tunnels (`trycloudflare.com`): out of scope (ephemeral, no stability), unless the owner wants a "preview" mode.
