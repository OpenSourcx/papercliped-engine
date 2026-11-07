# Identity linking contract (PROPOSED v2, not implemented)

Status: revision 2 of the proposal for the Connect owners and the ePaperclip device side. Nothing here is implemented or deployed. Every Connect endpoint and table below is new and additive; no existing Connect or device shape changes. Date: 2026-11-07.

Sources of truth used: ADR-001 (`bridge.accounts.id` is the only customer identity), Connect `docs/DEVICE-PROTOCOL.md`, `docs/SECURITY.md`, `docs/architecture/threat-model.md`, `docs/openapi/connect-v1.yaml`, `docs/v1/ACCEPTANCE.md` and `LEDGER.md` (remote `OpenSourcx/papercliped-connect` main at `9837b89`, fetched 2026-11-07), the Connect code (`device-crypto.mjs`, `sessions.mjs`, migrations), and on the device `docs/PAPERCLIPED-ACCOUNT.md`, `connectLink.ts`, `paperclipedAccount.ts`. The original Connect work was recorded in a Claude session that is not reachable; where the repo and the ledger are silent this document says so and asks (see Open questions).

What changed from revision 1 (the five defects it had):

| # | Revision 1 problem | Revision 2 |
|---|---|---|
| 1 | `link/start` kept only `nonceHash`, but confirm needed the original nonce | PKCE-style device-held verifier, sealed on the device, revealed only inside the device-signed confirm; exact signed fields defined (section 5) |
| 2 | Linking implied the managed address was in play | Linking needs only free device registration plus outbound HTTPS to Connect; no tunnel, hostname, seat or entitlement (section 4) |
| 3 | Approval was owner-only | Members via request or local-admin pre-approval, with local administrator approval, separate from paid seats, and no Proxmox permission grant (section 7) |
| 4 | Unlink ended every session of the principal | Unlink revokes only what derives from the link; ending all sessions is a separate explicit security action (section 8) |
| 5 | "Continue as alice@pam" blurred association with sign-in | The limitation is stated plainly; true federation is an optional later phase with a named mechanism (sections 3 and 10) |

## 1. Invariants (unchanged from revision 1, restated because everything depends on them)

1. A link grants nothing. Cloud login, device ownership, a subscription, a link or a membership never creates or raises a Proxmox permission. Effective permissions come only from the local Proxmox principal (`userid@realm`) and its ACLs, checked on the device for every console action and every `/mcp` call.
2. Proxmox passwords, tickets, API tokens and execution authority never leave the device. Connect never sees, relays or inspects customer MCP calls (`docs/SECURITY.md`).
3. No second customer identity database. Connect stores the link against the existing `bridge.accounts.id`. No linking by email equality, ever; emails are display-only.
4. Restricted return URLs. Connect never redirects to a URL the device merely claims (section 5.6).
5. The account and the principal are both shown to the person confirming, on every screen that confirms, before the button works (section 5.7).
6. Local administrators and local users keep working with Connect unreachable, unsubscribed, paused or down.

## 2. Parties and vocabulary

| Term | Meaning |
|---|---|
| Account `A` | Canonical Papercliped account, `bridge.accounts.id` (for example `pcb_a_...`). Proven by a Connect session (server-side, `__Host-` cookie, CSRF) plus step-up for approval. |
| Device `D` | A machine registered with Connect through the existing pairing (`connect.devices.id`). Proven by its ECDSA P-256 key (thumbprint `device_key_thumbprint`). |
| Principal `P` | A local Proxmox user and realm, `userid@realm` (for example `alice@pam`, `bob@ldap`). Proven by a live local session on `D`. |
| Device owner | The account that approved the pairing: `connect.devices.account_id`. Exactly one per device. Owns billing, the seat and the managed address. |
| Link | A signed, mutual association `(D, A, P)`. Table `connect.identity_links` (Connect) and a `StateStore` record (device). |
| Member | An account other than the owner that holds an active link on `D`. A member is not a seat, not an administrator and not a billing party. |
| Local administrator | A session for which the device's existing `ctx.isNodeAdmin()` is true. |

## 3. What a link is, and is not (the honest limitation)

A link is an account association: "this Papercliped account and this Proxmox principal on this machine belong to the same person, and both sides proved it". It lets the console and Connect show who is who, lets the person see the machine in their Papercliped console, and (phase 1b) lets the sign-in page offer a pre-filled username.

It is **not** "sign in with Papercliped". Prefilling `alice@pam` and still requiring her password (or WebAuthn or OIDC realm login) proves nothing new at the machine: the password is still the credential. Do not market it as single sign-on, and do not describe the Phase 1 sign-in hint as authentication. Anything that lets a cloud session replace the local credential is **federation** and is a separate, optional phase (section 10) with its own mechanism, its own local approval and its own threat review. Until that phase exists, no code path may create a device session, an OAuth token or an MCP token from a link alone.

## 4. Reachability, independence from paid tunnels, offline behaviour

Linking works for all three modes (`local`, `cloudflare-self`, `connect`) because it depends on registration, not on remote access:

| Need | Required for linking? | Notes |
|---|---|---|
| Device registered with Connect (existing pairing: `POST /api/v1/pairings` ... `complete`) | **Yes** | Pairing is free and mode-independent today: `ConnectLink.start()` does not check the mode, and `connect.devices` rows exist without any `device_entitlements` row. A `local` or `cloudflare-self` user pairs, links, and never enables managed connectivity. Open question 1 asks Connect to confirm this stays true. |
| Outbound HTTPS from the device to `https://connect.papercliped.co/api/*` | **Yes** | Connect Worker only. No inbound connection to the device is ever needed. |
| The person's browser reaching `auth.papercliped.co` / `connect.papercliped.co` | **Yes** | The approval page. The browser need not be able to reach the device from the internet; it is normally on the same LAN as the device console. |
| Subscription, paid seat (`device_entitlements`), managed hostname, Cloudflare Tunnel, `cloudflared` | **No** | Linking never returns `no_entitlement`. The existing `no_entitlement` (403) stays specific to tunnel credentials. |
| The device console being reachable from the internet | **No** | The return step is a convenience (5.6); the device completes by polling. |
| Device clock | Within about 60 s of Connect | Same rule as the existing device-signed routes (`verifyDeviceRequest` skew). |

Offline behaviour:

- Link creation, confirmation, approval and cloud-initiated revoke need Connect. If Connect is unreachable, `link/start` and `confirm` fail with 502 `connect_unreachable` and change **no** local state; an in-flight link keeps its sealed verifier until it expires and is retried by the same session.
- Everything that already works locally keeps working: local sign-in, console, `/mcp`, local unlink, local administrator approval of a pending request, pre-approvals.
- Unlink is local-first. If Connect is unreachable the revoke is stored as `pendingRevoke` (same shape as unpair's `pendingRevoke`) and retried by reconcile. A cloud-side revoke made while the device is offline reaches it at the next reconcile; until then the device-side record is stale but harmless in Phase 1 because the link grants nothing, and the sign-in hint (section 9) is only issued online and only for an active link.
- Connect being down never blocks a local user from signing in, and nothing in this contract may add a Connect dependency to local authentication.

## 5. Link protocol

### 5.1 Overview

```
 Device console (P's local session)      Device service            Connect Worker            Account holder's browser
 1  Link my account  ----------------->  generate verifier v,
                                         userCode; c = S256(v)
                                         seal v locally
                                         POST identity-links ----> store c, hash(userCode),
                                         (device-signed)           pending, ttl 10 min
                                       <------ linkId ----------
 2  show userCode + approvalUrl
 3                                                                                     open approvalUrl (sign in,
                                                                                       step-up); sees device, P, owner;
                                                                                       types userCode; Approve
                                                                  state=approved, account=A <-------------
 4  poll (device-signed) ------------->                           returns A (display fields)
 5  shows A + P; P clicks Confirm A
    [if P is not a node admin, not pre-approved, and A is not the owner: awaiting_admin, a local admin approves]
 6  confirm -------------------------->  POST .../confirm ------> verify S256(v)==c, signature over
                                         (v + signature)           (D,link,A,P,session,c,...), single use
                                                                  state=active, delete c and code hash
                                       <------ ok, role ---------
 7  linked                                                        console shows device (members: read-only)
```

### 5.2 Verifier retention (PKCE-style)

- At `link/start` the device generates `v` = 32 random bytes from the platform CSPRNG, base64url (43 chars), and `c = base64url(SHA-256(ascii(v)))` (RFC 7636 S256).
- Only `c` is sent to Connect, inside a device-signed request. Connect never sees `v` until confirm. A database leak at Connect exposes `c`, from which `v` cannot be recovered and cannot complete anything: confirm additionally needs the device's private key.
- The device keeps `v` **sealed in the existing `StateStore` vault** (same store as the device key and `TOKEN`), under `identity.link.<linkId>.verifier`, together with the link record. It is never logged, never in a URL, never returned by any device API, never held by the browser. The device API returns only `linkId`, `userCode`, `approvalUrl`.
- `v` is deleted on: successful confirm, 4xx terminal confirm answer, `cancel`, expiry (a sweeper runs at start, at each reconcile, and when the Access page loads), unpair, unlink of a replaced link, and removal of the principal.
- In memory `v` lives only for the duration of the confirm call.

### 5.3 Signed messages

All device-signed identity requests reuse the existing key, algorithm and encoding: ECDSA P-256, SHA-256, IEEE-P1363 signature, base64url, request body `{publicKeyJwk, ts, signature}` plus the fields below. The existing `ACTIONS` allow-list in `device-crypto.mjs` (`tunnel`, `revoke`) is not reused; identity actions use a new, distinct prefix so a signature for one purpose can never be replayed for another.

Canonical form (unambiguous, no delimiter confusion): the message is the UTF-8 text

```
papercliped-connect:identity:<action>:v1\n
<name>=<base64url(utf8(value))>\n      one line per field, in the exact order listed, every field present
```

Signing and verification both rebuild this from parsed values; the signed text is never taken from the request body.

| Action | Route | Fields, in order |
|---|---|---|
| `start` | `POST .../identity-links` | `deviceId`, `ts`, `challenge` (c), `principalUserid`, `principalRealm`, `sessionBinding`, `userCodeHash`, `returnOrigin`, `returnPath`, `confirmWindowSec`, `replaceLinkId` (empty string if none) |
| `poll` | `POST .../{linkId}/poll` | `deviceId`, `linkId`, `ts` |
| `confirm` | `POST .../{linkId}/confirm` | `deviceId`, `linkId`, `ts`, `accountId`, `principalUserid`, `principalRealm`, `sessionBinding`, `challenge` (c), `linkExpiresAt`, `approvedBy`, `membership` |
| `revoke` | `POST .../{linkId}/revoke` | `deviceId`, `linkId`, `ts`, `initiator`, `reason` |
| `reconcile` | `POST .../identity-links/reconcile` | `deviceId`, `ts`, `cursor` |
| `hint` | see section 9 | defined there |

What the confirm signature covers, and why each field is there:

| Field | Prevents |
|---|---|
| `deviceId` | cross-device replay |
| `linkId` | cross-link replay; also ties the message to one row |
| `accountId` | the browser-side approver being swapped after the local person looked at it (the same property as the existing `deviceCompletionMessage`) |
| `principalUserid`, `principalRealm` | linking a different local user than the one displayed. The values are taken from the local session on the device, never from a request body |
| `sessionBinding` | confirm from a different local session than the one that started it. `sessionBinding = base64url(SHA-256("papercliped-connect:identity-session:v1:" + linkId + ":" + localSessionId))`; Connect stores the start-time value and requires equality, and never learns the session id |
| `challenge` (c) | binds confirm to the exact start; Connect also requires `S256(v) == c` for the revealed `v` |
| `linkExpiresAt` (unix seconds) | confirming after the displayed expiry; Connect rejects if its row says otherwise |
| `ts` | stale replay (60 s skew, as today) |
| `approvedBy` | audit of which local consent satisfied the policy: `owner-account`, `self-admin`, `preapproval:<id>`, `admin:<userid@realm>` |
| `membership` | `owner` or `member` as the device believes it; Connect computes its own and rejects a mismatch with 409 `role_mismatch` (fail closed: the device then asks for admin approval) |

The revealed verifier `v` travels in the confirm body next to the signature, over TLS. The signature covers `c`, not `v`; Connect checks `S256(v) == stored c` in constant time. A passive observer of the approval URL, the poll answers or the browser learns nothing that can complete the link.

### 5.4 Single use, replay protection, state deletion

- Confirm is one conditional update in one transaction: `update connect.identity_links set state='active', challenge=null, user_code_hash=null, activated_at=now(), confirm_digest=$d where id=$1 and device_id=$2 and state='approved' and account_id=$3 and challenge=$c and session_binding=$sb and expires_at > now() returning ...`. Zero rows means one of `expired`, `bad_state`, `account_mismatch`, `verifier_mismatch` (distinguished only after the update fails, so the failure path leaks nothing the caller could not already know).
- Idempotent retry: Connect stores `confirm_digest = SHA-256(confirm message)`. A repeat of exactly the same signed message on an `active` row returns the same 200 (so a lost response cannot strand the device); anything else on a non-`approved` row is 409/410.
- Poll, reconcile and revoke are idempotent. A link in a terminal state (`active`, `denied`, `expired`, `canceled`, `revoked`) is never re-opened. Linking again creates a new `linkId`.
- Approval is bound to `(linkId, accountId)` and to the device-chosen `userCodeHash`; `approve` consumes it (`pending` -> `approved`), so one browser approval cannot be replayed onto another link.
- State deletion: `challenge` and `user_code_hash` are nulled the moment the row leaves `pending`/`approved`, including on deny, cancel and expiry (expiry is enforced by a conditional `expires_at`, and the existing cron sweeps stragglers to `expired` and nulls the secrets). Link rows without secrets are kept for audit; retention period is open question 8. Audit events (`connect.audit_events`) never contain `challenge`, `v`, `userCode`, signatures or raw sessions.
- On the device the sealed `v` and the in-flight record are deleted per 5.2; the active link record keeps no secret.

### 5.5 Device-side API (host service, `/api/papercliped/connect/identity/`)

All routes: live local session of the acting user, `X-Requested-With`/CSRF header and same-origin check (as every mutating `/api/papercliped/connect/*` route today), and a paired device. The acting principal is **always derived from the session**, never from a request field.

| Method and path | Who may call | Request -> response |
|---|---|---|
| `POST link/start` | any local user, for themselves | `{ returnTo?: "/" \| "/access", replaceLinkId?: string }` -> `201 { linkId, userCode, approvalUrl, expiresAt, principal: { userid, realm }, needsAdminApproval: boolean }` |
| `GET link/{linkId}` | the starting session | `{ state, principal, expiresAt, account?: { id, displayName, emailMasked?, idSuffix }, role?: "owner"\|"member", needsAdminApproval, approvedBy? }` |
| `POST link/{linkId}/confirm` | the starting session only | `{ accountId }` -> `{ state: "active"\|"awaiting_admin", principal, account, role }` |
| `POST link/{linkId}/cancel` | the starting session | `{ ok: true }` |
| `GET link-requests` | local administrator | `[ { linkId, principal, account, requestedAt, expiresAt } ]` (links in `awaiting_admin`) |
| `POST link/{linkId}/admin-approve` | local administrator (may be the same user when that user is a node admin) | `{ accountId }` -> `{ state: "active" }` |
| `POST link/{linkId}/admin-deny` | local administrator | `{ reason? }` -> `{ ok: true }` |
| `GET preapprovals`, `POST preapprovals`, `DELETE preapprovals/{id}` | local administrator | `POST { principal: { userid, realm }, boundAccountId?: string, ttlHours?: 1..72 }` -> `{ id, expiresAt }` |
| `GET links` | a user: own links; local administrator: all | `[ { linkId, principal, accountId, displayName, role, state, approvedBy, linkedAt } ]` |
| `DELETE links/{linkId}` | the linked principal, or a local administrator | `{ ok, remote: "revoked"\|"pending" }` (this is **unlink**; it does not end other sessions, section 8) |
| `POST security/revoke-principal-access` | the principal itself, or a local administrator | `{ principal, confirm: true }` -> `{ sessionsEnded, tokensRevoked }` (the explicit security action, section 8.3) |
| `POST reconcile` | local administrator, and the internal 15-minute timer | `{ links: [...], changed: number }` |

Rules:

- `returnTo` is a path only (`/` or `/access`); the origin is the origin the console was reached on (5.6). Anything else: 400 `bad_return`.
- A principal has at most one in-flight link. Another `start` returns 409 `link_in_progress` unless `replaceLinkId` names the principal's own active link (account switching, 8.4).
- `link/start` requires only a paired device (409 `not_paired` otherwise). It does not look at `mode`, the tunnel or any entitlement.
- A node admin can list, approve, deny and unlink, but **cannot create a link on behalf of another principal** and cannot choose the account: the account holder approves in their own browser and the principal's own session confirms.

### 5.6 Return URLs

- The device sends `returnOrigin` and `returnPath` in the signed `start`. `returnPath` must be exactly `/` or `/access`. The fragment is `#identity-link=<linkId>` (a non-secret id) added by the device page, never by Connect.
- Connect classifies `returnOrigin` and acts accordingly:
  1. **Managed hostname** of this device (`https://<label>-<hex>.connect.papercliped.co`, equal to the device's registered `connect.hostnames` FQDN): the approval page may redirect automatically.
  2. **Other** `https` origin: a private-network host (RFC 1918, link-local, `.local`, `.lan`, `.internal`) or the device's self-managed public origin as registered by the administrator: the page shows the full origin and a plain "Return to your device" link the person clicks. No automatic redirect, `rel="noopener noreferrer"`, `Referrer-Policy: no-referrer`.
  3. Everything else (userinfo in the URL, a non-`https` origin other than `http://localhost`/loopback for development builds, a query string, a different path, a punycode lookalike of a registered host): 400 `bad_return` at start.
- Open-redirect safety: the URL only ever contains a `linkId`; the link completes by device polling whether or not the person returns. A malicious device that lies about `returnOrigin` can only offer its own site to its own member.

### 5.7 What is displayed before anyone confirms

Approval page (Connect, account holder's browser, after sign-in and step-up): the device name, the device **owner** (masked display name), the local principal and realm exactly as `userid@realm`, "This machine will know you as <account display name> (`...<idSuffix>`)", the userCode field, and the sentence "This associates your Papercliped account with <principal> on this machine. It does not sign you in there and does not give you any new permissions." Approve is disabled until the code matches; five wrong codes lock the link (`denied`).

Device confirm panel (local session): the cloud account that approved (display name, masked email if allowed, id suffix), the local principal with realm, the role that will be recorded (owner or member), and the same sentence. The Confirm button sends exactly the `accountId` shown. If the shown account changes between render and click, the call is rejected (409 `wrong_account`) and the panel re-renders.

Local administrator panel (`awaiting_admin`): the same two identities, who requested it, and for non-owner accounts the explicit line "This account is not the owner of this machine. Approving lets it appear as a member of this machine in Papercliped. It does not grant any Proxmox permission."

userCode: 8 characters from a 32-symbol set without lookalikes (`XXXX-XXXX`, 40 bits), generated by the device, shown only to the starting session; Connect stores `SHA-256("papercliped-connect:link-code:v1:" + linkId + ":" + code)`. The online attempt cap (5) and the 10 minute life are the control; the code defeats a pasted or forwarded approval URL and a login-CSRF "fixation" (an attacker getting a victim to approve the attacker's link). It is not a secret that survives the link.

### 5.8 Connect API (new; all under `/api/v1`)

Browser routes use the existing session cookie, `Origin` allow-list and `X-CSRF-Token`; `approve` also requires step-up (`step_up_required` 403, as `device-revoke` does). Device routes use the signed body of 5.3, and answer 403 `not_available` for an unknown device, removed device, thumbprint mismatch, stale `ts` or bad signature (one uniform answer, as the existing tunnel route does).

| Method and path | Auth | Request -> response |
|---|---|---|
| `POST /devices/{deviceId}/identity-links` | device-signed `start` | `{ publicKeyJwk, ts, signature, challenge, principal: { userid, realm }, sessionBinding, userCodeHash, returnOrigin, returnPath, confirmWindowSec, replaceLinkId? }` -> `201 { linkId, approvalPath: "/devices/link?lid=<linkId>", expiresAt }` |
| `GET /identity-links/{linkId}` | browser session | `{ linkId, state, device: { name, ownerDisplay }, principal: { userid, realm }, returnOrigin?, expiresAt, codeRequired: true }`; 404 `not_found` for an unknown or expired id, uniform |
| `POST /identity-links/{linkId}/approve` | browser session + CSRF + step-up | `{ userCode }` -> `{ ok, state: "approved", role: "owner"\|"member", returnUrl?: string }` |
| `POST /identity-links/{linkId}/deny` | browser session + CSRF | `{}` -> `{ ok }` |
| `POST /devices/{deviceId}/identity-links/{linkId}/poll` | device-signed `poll` | -> `{ state, expiresAt, account?: { id, displayName, emailMasked?, idSuffix }, role? }` (account only from `approved`) |
| `POST /devices/{deviceId}/identity-links/{linkId}/confirm` | device-signed `confirm` | `{ publicKeyJwk, ts, signature, verifier, accountId, linkExpiresAt, approvedBy, membership }` -> `200 { ok, linkId, state: "active", role, replaced?: linkId }` |
| `POST /devices/{deviceId}/identity-links/{linkId}/revoke` | device-signed `revoke` | `{ publicKeyJwk, ts, signature, initiator, reason }` -> `{ ok: true }` (idempotent) |
| `POST /devices/{deviceId}/identity-links/reconcile` | device-signed `reconcile` | `{ cursor? }` -> `{ links: [ { linkId, accountId, principal, state, role, updatedAt } ], serverTime, nextCursor? }` |
| `GET /me/identity-links` | browser session | the caller's own links: `[ { linkId, device: { id, name, role, state }, principal, linkedAt } ]` |
| `DELETE /me/identity-links/{linkId}` | browser session + CSRF + step-up | cloud-initiated unlink by the linked account -> `{ ok }` |
| `GET /devices/{deviceId}/members` | session of the **device owner** | `[ { linkId, accountDisplay, idSuffix, principal, role, linkedAt } ]` |
| `DELETE /devices/{deviceId}/members/{linkId}` | session of the **device owner** + CSRF + step-up | owner removes a member's association -> `{ ok }` |

`GET /me/devices` style read access for members: a member sees, for a device where they hold an active link, only `{ id, name, state, hostname? , role: "member", principal }` (hostname only while a managed connection is `active`). No billing, no seat, no other members, no tunnel actions. The existing `GET /devices` stays owner-only and unchanged.

### 5.9 Error codes

| Code | HTTP | Where | Meaning |
|---|---|---|---|
| `bad_request` | 400 | all | malformed JSON, field shape, unknown field |
| `bad_return` | 400 | start, device | `returnTo`/`returnOrigin`/`returnPath` rejected |
| `signed_out` | 401 | browser | no session (existing) |
| `step_up_required` | 403 | approve, unlink, remove member | fresh sign-in needed (existing) |
| `not_available` | 403 | device-signed | unknown/removed device, key mismatch, stale `ts`, bad signature (uniform) |
| `code_invalid` | 403 | approve | wrong userCode; `attemptsLeft` returned |
| `code_locked` | 423 | approve | five wrong codes; the link is `denied` |
| `not_owner` | 403 | members routes | caller is not the device owner |
| `not_found` | 404 | browser | unknown link or not visible to the caller |
| `already_linked` | 409 | start, confirm | the principal or the account already has an **active** link on this device (the 409 body says which side: `principal` or `account`, without naming the other party) |
| `link_in_progress` | 409 | start | this principal already has a pending link |
| `bad_state` | 409 | any | operation not valid in the link's state |
| `account_mismatch` | 409 | confirm | `accountId` is not the approving account |
| `role_mismatch` | 409 | confirm | device and Connect disagree on owner/member |
| `verifier_mismatch` | 403 | confirm | `S256(v) != c` |
| `session_mismatch` | 409 | confirm | `sessionBinding` differs from the start |
| `expired` | 410 | any | pending/approved window passed |
| `rate_limited` | 429 | all | limits in 5.10 |
| `connect_unreachable` | 502 | device API | Connect cannot be reached; **no local state changed** |
| `connect_unavailable` | 502 | device API | Connect 5xx |
| `not_paired` | 409 | device API | device is not registered with Connect |
| `not_admin` | 403 | device API | administrator-only route |
| `wrong_account` | 409 | device confirm | shown account changed |
| `admin_approval_required` | 409 | device confirm | state is `awaiting_admin` |
| `principal_missing` | 409 | device | the Proxmox user no longer exists or is disabled |

`no_entitlement` is **not** a linking error (section 4).

### 5.10 Rate limits (proposed; Connect owners decide)

Using the existing `connect.rate_limits` store: link creation 10/hour and 30/day per device, 5/hour per principal; approve attempts 10/hour per account and 5 code attempts per link; poll 1 per 2 s per link; reconcile 4/hour per device beyond the timer; `GET /identity-links/{id}` 30/10 min per address. Answers include `Retry-After`.

## 6. State tables

### 6.1 Connect link state (`connect.identity_links.state`)

| State | Entered by | Leaves by | Secrets held |
|---|---|---|---|
| `pending` | device `start` | `approve` -> `approved`; `deny`; `cancel` (device revoke); 10 min -> `expired`; 5 bad codes -> `denied` | `challenge`, `user_code_hash` |
| `approved` | browser `approve` (account bound, role computed) | device `confirm` -> `active`; deny/cancel; `confirmWindowSec` (600 or 86400) -> `expired` | `challenge` |
| `active` | device `confirm` | `revoke` (any initiator) | none |
| `denied` | browser deny or code lock | terminal | none |
| `canceled` | device `revoke` before active | terminal | none |
| `expired` | window passed | terminal | none |
| `revoked` | `revoke`, owner removal, account deletion, device unpair/removal, reconcile | terminal | none |

Uniqueness (partial unique indexes): one `active` link per `(device_id, principal_userid, principal_realm)`; one `active` link per `(device_id, account_id)`; one in-flight (`pending`/`approved`) link per `(device_id, principal)`.

### 6.2 Device-side link state (`StateStore`)

| State | Meaning | Next |
|---|---|---|
| `starting` | verifier sealed, `start` posted | `awaiting_account` or `canceled` |
| `awaiting_account` | waiting for the browser approval | `awaiting_confirm` (poll shows approver), `expired`, `denied` |
| `awaiting_confirm` | approver known; the starting session must confirm that exact account | `awaiting_admin` or `active` (confirm), `canceled` |
| `awaiting_admin` | the principal is not a node admin, has no matching pre-approval, and the account is not the owner | `active` (admin approve), `denied` (admin deny), `expired` (24 h) |
| `active` | linked | `revoked`, `orphaned` |
| `orphaned` | the principal no longer exists or is disabled (found at reconcile); the cloud link is revoked with reason `principal_removed` | removed after 30 days |
| `revoked` / `denied` / `expired` / `canceled` | terminal; record kept only as a one-line audit entry, no secrets | pruned |

### 6.3 When is local administrator approval required?

| Account | Principal | Pre-approval for this principal | Needs another consent? |
|---|---|---|---|
| owner account | any principal | n/a | No (`approvedBy: owner-account`): a local admin already named this account at pairing |
| non-owner | a node admin | n/a | No, but the confirm panel is still shown (`approvedBy: self-admin`) |
| non-owner | non-admin | present, unexpired, and (if `boundAccountId` is set) matching | No (`approvedBy: preapproval:<id>`; the pre-approval is consumed) |
| non-owner | non-admin | none | **Yes**: `awaiting_admin` until a local administrator approves (`approvedBy: admin:<userid@realm>`) |

`confirmWindowSec` is 86400 only when the device expects `awaiting_admin` (non-admin principal, no pre-approval), otherwise 600.

## 7. Multiple users per machine, membership, seats, permissions

- A device has one owner and any number of members. Each member is a separate `(account, principal)` link. Nothing is shared between members except the machine.
- **Becoming a member, two paths, one record.**
  1. **Request**: the person signs in locally as their own principal, chooses "Link my Papercliped account", and completes 5.1. Because they are not the owner they land in `awaiting_admin` and a local administrator approves or denies. Connect itself needs no invitation from the owner.
  2. **Pre-approval (invite)**: a local administrator creates a pre-approval for a named principal, optionally pinned to one `boundAccountId`, valid up to 72 h. The administrator tells the person out of band. When that principal links, the admin step is already satisfied. A pre-approval is device-local (not sent to Connect), single use, listable and revocable.
- The cloud owner is not the arbiter of local access (that would let a cloud login decide who is on a Proxmox host). The owner **can** remove any member's association from Connect (`DELETE /devices/{id}/members/{linkId}`, step-up). That removes the association and the member's cloud-side visibility. It does not touch the Proxmox user or its sessions.
- Members are **not paid seats**. A seat (`connect.device_entitlements`) is per device and pays for the managed address. Adding or removing members never creates, moves or releases a seat, and the pricing in `docs/customer/overview-and-pricing.md` ("per server") is unaffected.
- **No automatic Proxmox permissions**: confirming, approving, pre-approving or being owner creates no Proxmox user, role or ACL. If the principal does not exist, linking fails with `principal_missing`. Giving a person access to the machine is done in Proxmox (Users, Permissions) by someone authorised there, exactly as today.
- One account to one principal and one principal to one account per device. A second attempt gets 409 `already_linked`, which is how nobody takes over someone else's identity: displacing an existing link needs the existing party's own unlink, or a local administrator's unlink.
- Membership changes: a local administrator sees and unlinks all links; a user sees and unlinks their own; an owner sees members in Connect and removes them. Pairing a new owner (unpair, then pair by another account) revokes every link on the device (8.5).

## 8. Unlink, revoke, switching, recovery

### 8.1 What unlink revokes

Unlink (device `DELETE links/{id}`, cloud `DELETE /me/identity-links/{id}`, owner removal, admin unlink) ends **only** what derives from the association:

- the Connect row (`revoked`) and the device record;
- the member's cloud-side visibility of the device;
- any pending sign-in hint for that `(device, account)`;
- in Phase 2 only (section 10): sessions and MCP tokens that were *issued through that link's federated login*. These carry provenance `via: <linkId>` in the session and token records, and only those are revoked.

It does **not** end: a local session that signed in with the principal's own credential, MCP/OAuth tokens the principal obtained by authenticating locally and consenting, or any other principal's sessions. In Phase 1 nothing is derived from a link, so unlink revokes no session and no token. (Revision 1 said unlink "immediately ends sessions and MCP tokens issued to that principal". That is withdrawn: it let a cloud-side action log a local user out, and made unlinking a denial-of-service lever.)

### 8.2 Initiators

| Initiator | Allowed | Where it takes effect |
|---|---|---|
| The linked principal (local session) | yes | local first, then Connect (or `pendingRevoke`) |
| A local administrator | yes, any link | local first |
| The linked account (Connect, step-up) | yes, own links | Connect at once; device at next reconcile (<= 15 min online) |
| The device owner (Connect, step-up) | yes, members only | same |
| The device itself | on unpair, on principal removal, on pairing by a different owner | device-signed `revoke`, `initiator: device` |
| Connect | on account deletion, device removal, account disable | reconcile |

Conflict rule: if either side says `revoked`, the link is revoked on both. A revoked link is never resurrected; the people link again.

### 8.3 The explicit security action

`POST security/revoke-principal-access` (device) is the only operation that ends sessions beyond the link. It is a deliberately named action ("Sign this user out of this machine everywhere"), takes `{ principal, confirm: true }`, is allowed for the principal itself or a local administrator, and ends **all** console sessions and revokes **all** device-issued OAuth/MCP tokens for that principal, regardless of how they were obtained. It also unlinks that principal. It is the answer to "my cloud account or my password was compromised". It never reaches out to Proxmox (changing the password or disabling the user in Proxmox remains a Proxmox action, and removing the Proxmox user already ends sessions today). It has no cloud-triggered form: Connect cannot force a local sign-out.

### 8.4 Account switching

- Different people on one browser: each signs into Papercliped as themselves; Connect shows the links of the signed-in account (`GET /me/identity-links`). Nothing is cached across accounts.
- Changing which account a principal uses: `link/start` with `replaceLinkId` (the principal's own active link). The old link stays active until the new one confirms; then Connect swaps them in the confirm transaction (`replaced: <linkId>` in the answer, audit event for both accounts). This avoids a gap and avoids two links for one principal. The new account holder must pass 5.1 in full; the old account holder is not asked.

### 8.5 Recovery

- Lost cloud account or lost second factor: the principal (or a local administrator) unlinks locally (works offline) and links again with the new account. The owner's own recovery is Connect's account recovery plus re-pairing, not part of this contract.
- Cloud account compromised: the account holder or the device owner unlinks in Connect; a local administrator runs 8.3 for any principal who may have been impersonated.
- Device reinstalled or unpaired: all links on the device are revoked at unpair (`initiator: device`); `pendingRevoke` retries if Connect is down. Re-pairing does not resurrect links, even with the same key (revision 1 allowed this; withdrawn, because ownership may have changed).
- Proxmox user renamed or deleted: the device finds it at reconcile, marks the link `orphaned`, and revokes it in Connect with reason `principal_removed`. A rename is a new principal and needs a new link.
- Papercliped account deletion (ID-10, not started): the deletion workflow must revoke the account's links first; the FK `ON DELETE RESTRICT` already blocks deleting an account that still has devices, and `identity_links.account_id` references `connect.customer_accounts(account_id)` with the same restriction.

## 9. Sign-in hint (Phase 1b, optional) and console/MCP parity

Purpose: when a person arrives at the device's sign-in page and chooses "Continue with Papercliped", the page learns **which principal to pre-fill**. The person still enters the principal's own credential. This is account association (section 3), not authentication.

Flow: the device sign-in page makes `state` and `nonce` (random, bound to that page instance) and sends the browser to `https://connect.papercliped.co/hint?device=<deviceId>&state=<state>&nonce=<nonce>&return=<origin>` (the origin validated as in 5.6). A signed-in Connect session that holds an `active` link on that device receives a 60 s EdDSA JWT `{ iss, aud: "device:<deviceId>", sub: <accountId>, jti, nonce, iat, exp }`, signed with a **dedicated hint key** (not the claim key) published at `/.well-known/jwks.json` with a `kid`. The browser returns to the device page with the JWT in the URL **fragment**; the page posts it to `POST /api/papercliped/connect/identity/hint` (CSRF, same-origin). The device verifies signature, `aud`, `exp`, `nonce`, consumes `jti` (replay cache until `exp`), looks up the active link for `sub`, and returns `{ principal }` for pre-fill. Connect issues nothing when no active link exists and answers identically either way (no account/link oracle). The device ignores the hint if Connect's keys cannot be fetched (offline): the plain sign-in page works.

The hint is never a credential: it creates no session, no token and no permission; it is not accepted by `/mcp`, OAuth consent or any API. If the principal is a node admin that fact changes nothing.

Parity with the console and the remote MCP endpoint: both use the same server-side checks on the device, unchanged by this contract. `/mcp` authorises with the device's own OAuth tokens issued after local sign-in and consent; a request that arrives through a managed hostname, a self-managed Cloudflare hostname or the LAN address meets the same sign-in, consent and Proxmox ACL checks, with the effective permissions of the principal who signed in. A link is invisible to `/mcp` in Phase 1. The same applies to a request carrying a hint: the hint is not a bearer credential.

## 10. Optional later phase: true federation (not part of Phase 1)

Only if the owner wants "sign in with Papercliped" to replace the local credential. Requirements that apply to any mechanism: local administrator opt-in per device, local permission enforcement (Proxmox ACLs on the federated principal), revocable, fully audited, and the device still works with no Connect.

**Recommended mechanism: a locally registered OpenID Connect realm.** The Proxmox administrator adds an OpenID realm (`papercliped`) to the node (Proxmox's native OIDC realm support) whose issuer is the central Papercliped identity provider. Sign-in at the console or `/mcp` consent then goes through the ordinary realm login path that already exists for any Proxmox OIDC realm (the device docs already say an administrator can configure such a realm and that it "does not bypass Proxmox privileges").

- The federated principal is `<claim>@papercliped`, a **new Proxmox principal in that realm**, created by the administrator (or by realm auto-create **disabled by default**) with **no permissions**. It is not `alice@pam`; Proxmox does not let an OIDC login assume a PAM user. A link in this phase maps account `A` to `<accountId>@papercliped` (the userid claim is the stable `bridge.accounts.id`, not an email), and the administrator grants that principal ACLs in Proxmox.
- Sessions and tokens issued through that realm login record `via: <linkId>` so unlink (8.1) revokes exactly them.
- Open prerequisites, not decided here: whether the issuer is Connect itself or Supabase Auth's OAuth 2.1 server (README: beta and disabled), the issuer URL being reachable by the Proxmox node (back-channel discovery and JWKS fetch), `client_id` per device, and what happens at the device when the issuer is unreachable (the `papercliped` realm login fails, every other realm keeps working).

**Alternative considered and not recommended: ticket exchange** (device mints its own session from a Connect-signed assertion). For a PAM/PVE realm user this would require the host service to create a Proxmox ticket without that user's password, i.e. hold a privileged ticket-signing capability on the device, which contradicts "Proxmox credentials stay on the device and execution is the user's". A variant that executes with a per-user, privilege-separated Proxmox API token the user created locally avoids that, but makes ePaperclip a second place where permissions are expressed. Revisit only if the OIDC realm proves unworkable.

## 11. Data

Connect (proposed additive migration, owners to review):

```
connect.identity_links (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null,
  account_id text,                                -- set at approve
  principal_userid text not null, principal_realm text not null,
  role text check (role in ('owner','member')),
  state text not null check (state in ('pending','approved','active','denied','expired','canceled','revoked')),
  challenge text,                                  -- S256(v); null once leaving pending/approved
  user_code_hash text, code_attempts smallint not null default 0,
  session_binding text not null,
  return_origin text, return_path text,
  approved_by text, confirm_digest text,
  replaces_link_id uuid,
  expires_at timestamptz not null,
  approved_at timestamptz, activated_at timestamptz, revoked_at timestamptz,
  revoked_by text, revoke_reason text,
  created_at timestamptz not null default now(),
  foreign key (device_id) references connect.devices(id) on delete restrict   -- device id only: member rows carry a different account_id (open question 2)
);
```
RLS on, no browser policies, same pattern as the other tables. Every query carries `account_id` / `device_id` predicates (the Worker role is `BYPASSRLS`, threat model T3). Audit: `identity.link.started|approved|confirmed|denied|expired|revoked` actions in `connect.audit_events` with `actor_type` `customer` or `device`, no secrets. Data note: Connect now stores `userid@realm`, which today's docs say Connect does not hold ("Proxmox ... users are NOT represented"). Open question 3.

Device: link records in the `StateStore` settings (non-secret), sealed verifiers in the vault (secret), pre-approvals (non-secret, device-local), a replay cache of hint `jti`s in memory.

## 12. Threats

| # | Threat | Control |
|---|---|---|
| T1 | Attacker links their account to a victim principal | needs the victim's live local session on the device (principal comes from the session; CSRF + same-origin) and the victim's explicit confirm of the shown account |
| T2 | Victim tricked into approving the attacker's link (fixation) | approval page names device, owner and principal; userCode from the device screen required; association only, no permission; step-up |
| T3 | Leaked or forwarded approval URL | URL holds only `linkId`; approve needs a signed-in session, step-up and the userCode; confirm needs the device key and the sealed verifier |
| T4 | Database leak at Connect | stores `c` (hash), `userCodeHash`, no verifier; confirm still needs the device private key |
| T5 | Replay of poll/confirm/revoke | `linkId` and `ts` in the signed text, 60 s skew, state-conditional update, `confirm_digest` for same-message idempotency only |
| T6 | Cross-protocol signature reuse | distinct `papercliped-connect:identity:<action>:v1` prefix with field-tagged canonical encoding; not in the existing `ACTIONS` set |
| T7 | Swapping the approver after the local person looked | confirm names `accountId`; Connect requires equality to the stored approver |
| T8 | Confirm from another local session or another local user | `sessionBinding` + principal from session on the device; both signed |
| T9 | Open redirect through `returnTo` | path allow-list, origin classification, no auto redirect except the device's own managed hostname, link carries no secret (5.6) |
| T10 | Account takeover via an existing link | one-to-one uniqueness; displacing needs the existing party; admin cannot link for someone else |
| T11 | Cloud-side action logs local users out (DoS) | unlink never ends local sessions (8.1); no cloud-triggered session kill |
| T12 | Link used to gain permissions | no code path derives a session, token or ACL from a link in Phase 1; Phase 2 sessions carry `via` and local ACLs decide |
| T13 | Stale link after cloud revoke while device offline | reconcile; hint only online and only for an active link; Phase 1 link grants nothing |
| T14 | Enumeration of devices/links/accounts | uniform 404/403; member and owner lists scoped by session account |
| T15 | Brute force of userCode | 5 attempts per link, rate limits, 10 min life |
| T16 | Forged or hostile device (paired by an attacker) | device can only create links for its own device row; members of that device see only what the attacker's device chooses to show; the account holder sees device name and owner before approving |
| T17 | Clock skew locking out linking | same 60 s rule as tunnel credentials; error text names the clock |
| T18 | PII spread (principal names at Connect) | stored only after consent; deletion on account/device removal; open question 3 |
| T19 | Shared-database blast radius | same as existing T3; new table is RLS-on and reached only through the Worker role |
| T20 | Federation (Phase 2) bypassing local ACLs | out of Phase 1; new principal in its own realm with no permissions by default |

## 13. Mapping to `docs/v1/ACCEPTANCE.md` rows

Existing rows this contract touches (statuses are those on remote main `9837b89`; this contract changes none of them):

| Row | How |
|---|---|
| ID-1 | no silent merge; uniqueness; no email-equality linking |
| ID-3, ID-7 | approval rides the verified session with CSRF/Origin and step-up |
| ID-10 | account deletion must revoke links (8.5) |
| CN-2, CN-8 | links hang off the paired device; unpair revokes links |
| CN-10 | rate limits on link creation/approval (5.10) |
| CN-6, MC-5 | remote MCP parity (section 9); no tunnel dependency for linking |
| EP-3, MC-4 | principal and ACLs enforced on the device |
| EP-7 | linking independent of the exclusive mode |
| EP-11, UI-2, UI-3 | device Access panel and Connect console screens gain Link/Members |
| SR-5, SR-10, SR-11 | tenant isolation tests for links; fail closed; local control when Connect is down |
| SR-9 | section 12 is an input to the threat model, not a sign-off |
| UI-4 | the confirm/approve screens need the design and accessibility review |

Proposed new rows (for the Connect owners to add; all `not-started` today):

| ID | Requirement | Gate |
|---|---|---|
| ID-11 | Identity link create/approve/confirm with device-held verifier, single use, replay-safe | `verified-test` on real Postgres, then `verified-live` with a real device key |
| ID-12 | Multiple principals/accounts per device: request, pre-approval, local admin approval, owner removal, no seat change | tests plus live run with two accounts |
| ID-13 | Unlink/revoke from every initiator, offline `pendingRevoke`, reconcile, account switching | tests |
| ID-14 | Explicit principal access revocation; unlink does not end unrelated sessions | device tests (negative test: another session survives) |
| ID-15 | Linking works in `local`, `cloudflare-self` and `connect` modes without entitlement | tests per mode |
| ID-16 | Sign-in hint (Phase 1b), documented and labelled as association | tests |
| ID-17 | Federation via OIDC realm (Phase 2, optional) | design review before any code |

## 14. Test and implementation gates (before any code merges)

- Connect: real-Postgres tests for each error in 5.9, the uniqueness indexes, concurrent double confirm (exactly one wins; the other gets the idempotent answer or 409), concurrent approve vs deny, expiry boundary, code lockout, secret nulling, tenant isolation (another account's link looks missing), `replaceLinkId` swap atomicity, OpenAPI entries plus the existing contract test.
- Device: fake-Connect tests for each device state, sealed-verifier deletion on every exit, session-binding mismatch, `wrong_account`, admin approval matrix (6.3), a node admin cannot link for another user, unlink leaves another session and an MCP token alive (negative test), `connect_unreachable` leaves state unchanged, `pendingRevoke` retry.
- A real two-account, two-principal run on a real device before ID-11..ID-15 can be marked `verified-live`.

## 15. Open questions for the Connect owners

1. **Pairing in non-Connect modes.** May a `local` or `cloudflare-self` device stay registered (free, no seat) for linking? Today the engine does not forbid it and `connect.devices` has no entitlement dependency; confirm it is intended, and that a registered-but-unsubscribed device is not purged.
2. **Schema for member rows.** `connect.devices` is keyed `(account_id, id)` with a composite FK from `audit_events` and `device_pairings`. Is it acceptable that `identity_links` references `devices(id)` and carries a different `account_id` for members, and that `audit_events` rows for a member's actions use the owner's `(account_id, device_id)` plus an `actor_ref`? Or should members get their own audit account scoping?
3. **Principal names at Connect.** `docs/DATABASE.md`/`DEVICE-PROTOCOL.md` say local users are not represented. This contract stores `userid@realm` (needed for the approval page and the owner's member list). Is that acceptable, or should Connect store only a device-salted HMAC and show a device-supplied label that is not persisted?
4. **Masked email.** May `emailMasked` appear on the device confirm panel and the member list, or display name and id suffix only? (Revision 1 question, still open.)
5. **Owner-invited members.** Is a cloud-side owner invitation wanted in V1 (owner invites an account, local admin still approves), or is request plus local pre-approval enough?
6. **Reconcile cadence and cloud-initiated unlink in V1.** Proposed: at start, when the Access page loads, and every 15 minutes with jitter (same loop as the tunnel check, but independent of mode). Is cloud-initiated unlink V1?
7. **Rate-limit numbers** in 5.10.
8. **Retention** of terminal `identity_links` rows (proposed 90 days) and of the audit events; interaction with ID-10 deletion.
9. **Hint key and issuer.** A dedicated EdDSA hint key and JWKS at `connect.papercliped.co/.well-known/jwks.json`, separate from the claim keys? Is Phase 1b wanted at all, or only association?
10. **Federation issuer** for Phase 2: Connect-hosted OIDC, or Supabase Auth's OAuth 2.1 server once reviewed (README says beta and disabled)?
11. **Step-up lifetime** for `approve`: reuse the existing `STEPUP_TTL`, or a shorter one for linking?
12. **Account switching and the owner.** May the device owner's account replace its own link (`replaceLinkId`) without any local approval? This contract says yes (no admin step for the owner account, 6.3).
