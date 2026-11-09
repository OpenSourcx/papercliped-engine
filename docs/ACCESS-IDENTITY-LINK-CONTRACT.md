# Identity linking contract (PROPOSED, device side implemented)

Status: proposal for the Connect/identity agent. Nothing here changes an existing shape; every endpoint is new and additive to `docs/PAPERCLIPED-ACCOUNT.md` (device side) and Connect `docs/DEVICE-PROTOCOL.md` (cloud side). Source docs: ADR-001 (`bridge.accounts.id` is the only customer identity), DEVICE-PROTOCOL v0.1, `connectLink.ts`.

## Implementation status on the device (2026-11-09)

Implemented on `v1/connect-access` against revision 2.1 of this contract
(`origin/docs/identity-link-contract`), in `services/epaperclip/src/identityLinks.ts` with routes under
`/api/papercliped/connect/identity/` in `app.ts` and a fake Connect that verifies every signature in
`test/fakes-papercliped.ts`:

- `link/start` (association and federated), `link/{id}`, `link/{id}/poll`, `link/{id}/confirm`,
  `link/{id}/cancel`, `links`, `links/{id}` (unlink), `link-requests`, `link/{id}/admin-approve`,
  `link/{id}/admin-deny`, `preapprovals` (+ delete), `reconcile`, `security/revoke-principal-access`.
- A device-held PKCE-style verifier sealed in the `StateStore` vault and deleted on every terminal path;
  a session-bound confirm; the exact approved account shown and checked before confirm; local-admin
  approval and device-local, single-use pre-approvals.
- Linking is independent of the remote-access mode and of any tunnel or entitlement. Unlink is local
  first with `pendingRevoke` retried by a 15-minute reconciler; unpair revokes every link while the
  device registration still exists.
- "Sign in with Papercliped": `oidc/enable|disable` register one confidential client per device with
  Connect and create only the agreed `papercliped` Proxmox OpenID realm. The local link gate refuses a
  ticket for an `<id>@papercliped` principal with no active federated link, tags the session with the
  link (8 h absolute cap), and refuses to take over a realm with different settings. The permissionless
  `<accountId>@papercliped` user gets no group, role or ACL. Federated unlink ends exactly the sessions
  and OAuth/MCP grants carrying that link.
- Tests use fakes only: `test/identity-links.test.ts`, `test/identity-oidc.test.ts`, and the route
  cases in `test/app.test.ts`. Nothing ran against live Connect or a real Proxmox host.
- The device does not claim `iss`/`aud`/`nonce`/JWKS validation of an `id_token`: Proxmox is the OIDC
  client that receives and validates it, as section 10.7 of revision 2.1 requires.
- Deviation required by revision 2.1's start table: the start message has no link id, yet the userCode
  hash and session binding need one. The device generates `linkId` (a UUID) and includes it as a signed
  `start` field/body value; Connect stores it as the row id. The remaining fields follow 5.3's order.

Still absent everywhere: the Connect-side routes/tables, the real OIDC issuer, and real-host PVE
validation.


## Goals and non-goals
- Link one Papercliped account (`bridge.accounts.id`) to one **local Proxmox principal** (`userid@realm`, for example `alice@pam`) **on one paired device**, so a person has an explicit account on that machine.
- Multi-user: a device holds many links, each between a different principal and a different account.
- **Non-goals / invariants.** A link grants nothing by itself. Cloud login, device ownership and subscription never create or raise Proxmox permissions. Proxmox passwords, tickets, API tokens and execution authority never leave the device; Connect never sees or relays customer MCP calls. No second identity database: Connect stores only the link record against the existing account id. Never link by email equality.

## Principals kept separate
Cloud account (`bridge.accounts.id`), device key (ECDSA P-256, already used for pairing), Proxmox principal. The link is a signed statement binding the first and third on a device identified by the second.

## Device-side API (host service, `/api/papercliped/connect/identity/`)
All require a live local session for the principal being linked, the CSRF header, and same-origin. The device is in `connect` mode and paired.

| Method and path | Who | Body / result |
|---|---|---|
| `POST link/start` | the local principal linking itself | `{ returnTo }` -> `{ linkId, approvalUrl, expiresAt }` |
| `GET link/{linkId}` | same session | `{ state: pending/approved/denied/expired/confirmed, account?: { id, displayName, emailMasked } }` |
| `POST link/{linkId}/confirm` | same session | `{ accountId }` -> `{ ok, principal, account }` |
| `POST link/{linkId}/cancel` | same session | `{ ok }` |
| `GET links` | principal: own links; node admin: all | `[ { linkId, principal, accountId, displayName, linkedAt, state } ]` |
| `DELETE links/{linkId}` | the linked principal or a node admin | `{ ok, remote: "revoked"/"pending" }` |

Rules:
- `link/start` generates a 256-bit random `nonce`; the device stores only its SHA-256 `nonceHash`, the local session id, the principal, `returnTo`, and `expiresAt` (10 minutes). State is single use: `confirm`/`cancel`/expiry consumes it atomically.
- `returnTo` must be the device's own console origin: the registered Connect hostname (`https://<device>.connect.papercliped.co`) or the exact origin the session started on. Path must be `/` or `/access`. Anything else is rejected with 400 `bad_return`. Connect receives and re-validates it against the device's registered hostname; it never redirects elsewhere.
- `confirm` is accepted only from the same local session that started the link, and only for the `accountId` Connect reported as approved. The UI shows, before the button: the cloud account (display name, masked email, id suffix) and the local principal with realm, and the sentence "This lets <account> sign in as <principal> on this machine. It does not give any new permissions."
- Constraints enforced on the device and mirrored by Connect: a principal links to at most one account; an account links to at most one principal per device. A second attempt returns 409 `already_linked` and requires an explicit unlink first, so nobody can take over another person's identity.
- Multi-user: each user links their own principal from their own session. A node admin may view and revoke any link but cannot create one on behalf of someone else (the account holder must approve in their own browser).

## Connect-side API (new, device-signed like the existing tunnel and revoke routes)
Body of every device call: `{ publicKeyJwk, ts, signature }`, ECDSA P-256 SHA-256 ieee-p1363 base64url, device clock within about a minute.

| Method and path | Signed message | Notes |
|---|---|---|
| `POST /api/v1/devices/{deviceId}/identity-links` body also `{ nonceHash, principal: { userid, realm }, returnTo }` | `papercliped-connect:identity-link:v1:<deviceId>:<ts>:<nonceHash>:<userid@realm>` | creates `pending` link, 10 min expiry, rate limited. 201 `{ linkId, approvalPath }`. `returnTo` validated against the device's registered hostname. |
| `GET /devices/link?lid=<linkId>` (browser) | Papercliped session (HttpOnly cookie, CSRF) | Signed-in **account owner of the device** sees device name, principal and realm, approves or denies. Account must own or be an invited member of the device's seat; otherwise 403. Step-up (passkey/email code) before approve. |
| `POST /api/v1/devices/{deviceId}/identity-links/{linkId}/poll` | `...:identity-poll:v1:<deviceId>:<linkId>:<ts>` | `{ state, account?: { id, displayName, emailMasked } }` |
| `POST /api/v1/devices/{deviceId}/identity-links/{linkId}/confirm` body `{ accountId }` | `...:identity-confirm:v1:<deviceId>:<linkId>:<accountId>:<userid@realm>:<ts>` | atomically consumes the link when `accountId` equals the approver. 200 `{ ok }`; 409 `already_linked`; 410 `expired`; 403 `not_available`. Idempotent for the same payload. |
| `POST /api/v1/devices/{deviceId}/identity-links/{linkId}/revoke` | `...:identity-revoke:v1:<deviceId>:<linkId>:<ts>` | idempotent `{ ok: true }`. Also callable by the account owner from the Console (cloud-initiated unlink): the device learns via its next reconcile and removes the link locally. |
| `POST /api/v1/devices/{deviceId}/identity-links/reconcile` | `...:identity-reconcile:v1:<deviceId>:<ts>` | returns `{ links: [ { linkId, accountId, state } ] }` so the device can drop revoked links and Connect can drop ones the device removed. |

Replay and binding: the approval binds `(accountId, deviceId, nonceHash, principal)`; confirm requires the device to reveal the pre-image `nonce` over TLS only at confirm time so a leaked `approvalUrl` cannot complete a link. Consumed, expired and denied links cannot be approved. Account A cannot approve a link for a device account B owns. Audit events never contain the nonce, signatures or tokens.

## What the link does at sign-in
- Remote console and `/mcp` still authenticate against the **device's** Proxmox realm (password, OIDC realm or WebAuthn) exactly as on the LAN. A link only lets the sign-in page offer "Continue as alice@pam" for a person who arrives with a verified Papercliped session, and it still asks for the realm credential. It never mints a ticket.
- Every machine action, in the console and over `/mcp`, runs with the principal's effective Proxmox permissions, checked on the server per call. A public address never bypasses local sign-in, consent or authorization.
- Unlinking, or removing the Proxmox user, immediately ends sessions and MCP tokens issued to that principal.

## Offline and recovery
- Links live in the device `StateStore`; local sign-in and all local access work with Connect unreachable. Link creation needs Connect (it is the approval path) and fails with 502 without changing local state.
- Unlink always happens locally first; if Connect is unreachable the revoke is kept as a pending record and retried at reconcile, like unpair.
- Recovery: a user who lost their cloud account unlinks locally (their own session or a node admin) and links again with the new account. Device re-pair does not carry links forward unless the device key is the same (reconcile compares by device id and key thumbprint).
- Account deletion in Papercliped must revoke its links (extend the existing deletion reconciliation).

## Error vocabulary
`bad_return` 400, `expired` 410, `already_linked` 409, `not_available` 403 (same as existing), `no_entitlement` 403 is **not** used for linking: linking works without a subscription, since local access and links must not depend on billing, but remote sign-in through the Connect address does depend on the tunnel entitlement.

## Open questions for Connect/identity
1. Do invited members of a device seat exist yet, or is approval owner-only for V1? (Proposal: owner-only first.)
2. Is `emailMasked` allowed to be shown, or only display name?
3. Reconcile cadence and whether Console-initiated unlink is in V1.
4. Rate-limit numbers for `identity-links` creation per device and per account.
