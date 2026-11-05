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
