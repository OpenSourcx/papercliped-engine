# Identity linking and federated sign-in contract (PROPOSED v2.1, not implemented)

Status: revision 2.1 of the proposal for the Connect owners and the ePaperclip device side. Nothing here is implemented or deployed. Every Connect endpoint and table below is new and additive; no existing Connect or device shape changes. Date: 2026-11-07. Revision 2.1 (owner correction): "Sign in with Papercliped" is a **V1 deliverable**, not an optional phase; account association alone is not completion. Section 10 specifies the single V1 mechanism and states what could not be verified about Proxmox.

Sources of truth used: ADR-001 (`bridge.accounts.id` is the only customer identity), Connect `docs/DEVICE-PROTOCOL.md`, `docs/SECURITY.md`, `docs/architecture/threat-model.md`, `docs/openapi/connect-v1.yaml`, `docs/v1/ACCEPTANCE.md` and `LEDGER.md` (remote `OpenSourcx/papercliped-connect` main at `9837b89`, fetched 2026-11-07), the Connect code (`device-crypto.mjs`, `sessions.mjs`, migrations), and on the device `docs/PAPERCLIPED-ACCOUNT.md`, `connectLink.ts`, `paperclipedAccount.ts`. The original Connect work was recorded in a Claude session that is not reachable; where the repo and the ledger are silent this document says so and asks (see Open questions).

What changed from revision 1 (the five defects it had):

| # | Revision 1 problem | Revision 2 |
|---|---|---|
| 1 | `link/start` kept only `nonceHash`, but confirm needed the original nonce | PKCE-style device-held verifier, sealed on the device, revealed only inside the device-signed confirm; exact signed fields defined (section 5) |
| 2 | Linking implied the managed address was in play | Linking needs only free device registration plus outbound HTTPS to Connect; no tunnel, hostname, seat or entitlement (section 4) |
| 3 | Approval was owner-only | Members via request or local-admin pre-approval, with local administrator approval, separate from paid seats, and no Proxmox permission grant (section 7) |
| 4 | Unlink ended every session of the principal | Unlink revokes only what derives from the link; ending all sessions is a separate explicit security action (section 8) |
| 5 | "Continue as alice@pam" blurred association with sign-in | Association is stated plainly as not sign-in; real federated sign-in is a V1 deliverable with one concrete mechanism: a locally registered Proxmox OpenID realm with a Papercliped-operated issuer (sections 3 and 10) |

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

## 3. Two kinds of link, and what each one is

| Kind | What it does | Credential at the machine |
|---|---|---|
| `association` | Records that this Papercliped account and an **existing** local principal (for example `alice@pam`) are the same person; both sides proved it. Shows who is who in the console and in Connect. | Still the principal's own password / WebAuthn / realm login. **Association is not "Sign in with Papercliped".** Pre-filling `alice@pam` and still requiring her password proves nothing new. |
| `federated` | Makes **Sign in with Papercliped** work: the person authenticates at Papercliped and the machine accepts that as the credential for one specific, explicitly linked Proxmox principal in a dedicated OpenID realm (section 10). | The Papercliped login, verified by Proxmox's own OpenID realm code. |

Both kinds are V1. They differ in the principal: an OpenID login in Proxmox yields a principal in the OpenID realm (`<name>@papercliped`); it cannot become `alice@pam`. A person who wants both a local-password path and Papercliped sign-in therefore holds one `association` link (to an existing principal) and one `federated` link (to their `@papercliped` principal): two principals with separately granted permissions. Product copy must not call an association link single sign-on.

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
- Unlink is local-first. If Connect is unreachable the revoke is stored as `pendingRevoke` (same shape as unpair's `pendingRevoke`) and retried by reconcile. A cloud-side revoke made while the device is offline reaches it at the next reconcile; until then the device-side record is stale. For an `association` link that is harmless (it grants nothing); for a `federated` link the issuer already refuses new sign-ins once Connect says `revoked`, and open federated sessions are capped (10.8).
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
| `start` | `POST .../identity-links` | `deviceId`, `ts`, `challenge` (c), `kind`, `principalUserid` (`*` for `federated`), `principalRealm`, `sessionBinding`, `userCodeHash`, `returnOrigin`, `returnPath`, `confirmWindowSec`, `replaceLinkId` (empty string if none) |
| `poll` | `POST .../{linkId}/poll` | `deviceId`, `linkId`, `ts` |
| `confirm` | `POST .../{linkId}/confirm` | `deviceId`, `linkId`, `ts`, `kind`, `accountId`, `principalUserid`, `principalRealm`, `sessionBinding`, `challenge` (c), `linkExpiresAt`, `approvedBy`, `membership` |
| `revoke` | `POST .../{linkId}/revoke` | `deviceId`, `linkId`, `ts`, `initiator`, `reason` |
| `reconcile` | `POST .../identity-links/reconcile` | `deviceId`, `ts`, `cursor` |
| `oidc-register`, `oidc-redirects`, `oidc-rotate`, `oidc-remove` | `.../oidc-client*` (10.4) | `deviceId`, `ts`, plus the redirect URI list for the first two |
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

All routes: live local session of the acting user, `X-Requested-With`/CSRF header and same-origin check (as every mutating `/api/papercliped/connect/*` route today), and a paired device. The acting principal is **always derived from the session**, never from a request field (a `federated` link's principal is computed from the approving account, 10.5, never chosen by the caller).

| Method and path | Who may call | Request -> response |
|---|---|---|
| `POST link/start` | any local user, for themselves | `{ kind?: "association" (default) \| "federated", returnTo?: "/" \| "/access", replaceLinkId?: string }` -> `201 { linkId, userCode, approvalUrl, expiresAt, principal: { userid, realm }, needsAdminApproval: boolean }` |
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
| `POST /devices/{deviceId}/identity-links` | device-signed `start` | `{ publicKeyJwk, ts, signature, challenge, kind, principal: { userid, realm }, sessionBinding, userCodeHash, returnOrigin, returnPath, confirmWindowSec, replaceLinkId? }` -> `201 { linkId, approvalPath: "/devices/link?lid=<linkId>", expiresAt }` |
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
| `not_linked` | 403 | device login | the OpenID login returned a principal that is not an active federated principal; ticket discarded |
| `realm_conflict` | 409 | device enable | a realm `papercliped` exists with other settings |
| `principal_create_failed` | 409 | device approval | the Proxmox user could not be created with the administrator's own rights |
| `already_registered` | 409 | oidc-client | client already exists for this device |
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

Uniqueness (partial unique indexes): one `active` link per `(device_id, principal_userid, principal_realm)`; one `active` link per `(device_id, account_id, kind)` (an account may hold one `association` and one `federated` link); one in-flight (`pending`/`approved`) link per `(device_id, principal)`.

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

A `federated` link is the exception: it **always** needs a node administrator (10.5), whoever the account is.

`confirmWindowSec` is 86400 only when the device expects `awaiting_admin` (non-admin principal, no pre-approval), otherwise 600.

## 7. Multiple users per machine, membership, seats, permissions

- A device has one owner and any number of members. Each member is a separate `(account, principal)` link. Nothing is shared between members except the machine.
- **Becoming a member, two paths, one record.**
  1. **Request**: the person signs in locally as their own principal, chooses "Link my Papercliped account", and completes 5.1. Because they are not the owner they land in `awaiting_admin` and a local administrator approves or denies. Connect itself needs no invitation from the owner.
  2. **Pre-approval (invite)**: a local administrator creates a pre-approval for a named principal, optionally pinned to one `boundAccountId`, valid up to 72 h. The administrator tells the person out of band. When that principal links, the admin step is already satisfied. A pre-approval is device-local (not sent to Connect), single use, listable and revocable.
- The cloud owner is not the arbiter of local access (that would let a cloud login decide who is on a Proxmox host). The owner **can** remove any member's association from Connect (`DELETE /devices/{id}/members/{linkId}`, step-up). That removes the association and the member's cloud-side visibility. It does not touch the Proxmox user or its sessions.
- Members are **not paid seats**. A seat (`connect.device_entitlements`) is per device and pays for the managed address. Adding or removing members never creates, moves or releases a seat, and the pricing in `docs/customer/overview-and-pricing.md` ("per server") is unaffected.
- **No automatic Proxmox permissions**: confirming, approving, pre-approving or being owner creates no role and no ACL. An `association` link needs the principal to exist already (`principal_missing` otherwise). A `federated` link, on a local administrator's approval, creates one Proxmox user `<accountId>@papercliped` with no ACLs and no group; nothing else. Giving a person access to the machine is done in Proxmox (Users, Permissions) by someone authorised there, exactly as today.
- One account to one principal and one principal to one account per device. A second attempt gets 409 `already_linked`, which is how nobody takes over someone else's identity: displacing an existing link needs the existing party's own unlink, or a local administrator's unlink.
- Membership changes: a local administrator sees and unlinks all links; a user sees and unlinks their own; an owner sees members in Connect and removes them. Pairing a new owner (unpair, then pair by another account) revokes every link on the device (8.5).

## 8. Unlink, revoke, switching, recovery

### 8.1 What unlink revokes

Unlink (device `DELETE links/{id}`, cloud `DELETE /me/identity-links/{id}`, owner removal, admin unlink) ends **only** what derives from the association:

- the Connect row (`revoked`) and the device record;
- the member's cloud-side visibility of the device;
- any pending sign-in hint for that `(device, account)`;
- for a `federated` link (section 10): every console session and OAuth/MCP token that was *issued through that link's federated login*. They carry `link: <linkId>` in the session and token records, and exactly those are revoked; the principal's Proxmox user is also disabled (reversible; its ACLs are not deleted).

It does **not** end: a local session that signed in with the principal's own credential, MCP/OAuth tokens the principal obtained by authenticating locally and consenting, or any other principal's sessions. For an `association` link nothing is derived from the link, so unlinking it revokes no session and no token. (Revision 1 said unlink "immediately ends sessions and MCP tokens issued to that principal". That is withdrawn: it let a cloud-side action log a local user out, and made unlinking a denial-of-service lever.)

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

## 9. Optional username pre-fill for association links, and console/MCP parity

For `association` links only, as a convenience: the sign-in page can pre-fill the principal for a person who arrives with a verified Connect session. The person still enters the principal's own credential. This is account association, not authentication, and **it does not count toward the "Sign in with Papercliped" deliverable** (section 10 does). Whether to build it is open question 9.

Mechanism if wanted: the page creates `state` and `nonce` and sends the browser to `https://connect.papercliped.co/hint?device=<deviceId>&state=<state>&nonce=<nonce>&return=<origin>` (origin validated as in 5.6). A signed-in session holding an active `association` link on that device gets a 60 s JWT `{ iss, aud: "device:<deviceId>", sub: <accountId>, jti, nonce, iat, exp }`, signed with a dedicated hint key, returned in the URL fragment and posted to `POST /api/papercliped/connect/identity/hint` (CSRF, same-origin). The device verifies signature, `aud`, `exp`, `nonce`, consumes `jti`, and returns `{ principal }` for pre-fill only. Connect answers identically whether or not a link exists. The hint is never a credential: no session, token or permission is created from it, and `/mcp` and OAuth consent do not accept it.

Parity with the console and the remote MCP endpoint: every check is on the device and identical however the person signed in (password, WebAuthn, another realm, or the Papercliped realm) and whatever address was used (LAN, managed hostname, self-managed Cloudflare hostname). `/mcp` authorises with the device's own OAuth tokens issued after a local sign-in and consent, with the effective Proxmox permissions of that principal, checked server-side per call. A federated session is an ordinary session of its principal plus the provenance tag (10.8): no extra and no fewer permissions.

## 10. Federated sign-in: "Sign in with Papercliped" (V1 mechanism)

### 10.1 Choice

One mechanism for V1: **a locally registered Proxmox OpenID Connect realm on the device (realm id `papercliped`) whose issuer is a Papercliped-operated OIDC provider, one confidential client per device**, authorization-code flow. The device administrator's own Proxmox permissions create the realm; Proxmox itself runs the code exchange and the id_token validation; ePaperclip adds the link gate, the session tagging and the revocation. Ticket exchange (the device minting its own session from a Connect-signed assertion) is rejected: for a `pam`/`pve` principal it would need a privileged ticket-signing capability on the device and a second place where permissions are expressed, contradicting "Proxmox credentials and execution authority stay on the device".

### 10.2 What was verified about Proxmox, and what was not

Verified from this repository (engine worktree, read 2026-11-07):

- Proxmox exposes OpenID realms through the realm API (`POST /access/domains` with `type=openid`) and a two-step login: `POST /access/openid/auth-url` (open to anyone; input `realm`, `redirect-url`; returns the provider URL) and `POST /access/openid/login` (input `code`, `state`, `redirect-url`; returns a ticket). The engine already implements both (`packages/proxmox-client/src/client.ts`, `services/epaperclip/src/app.ts`: `POST /api/login/openid/start|finish`, one-use browser-bound cookie, sign-in limiter), documents them (`docs/ACCESS.md`, `docs/SECURITY.md` A-12) and maps them (`docs/PARITY.md` DC-088).
- The realm schema the engine uses (`services/epaperclip/src/features/access-realms.ts`, derived from the Proxmox API description) has these OpenID fields: `issuer-url` (must be `https`), `client-id`, `client-key` (write-only secret), `username-claim` (set at creation only; for example `username`, `subject`, `email`), `autocreate` (default false), `scopes` (default `email profile`), `prompt`, `acr-values`, `query-userinfo` (default true), `groups-claim`, `groups-autocreate`, `groups-overwrite`.
- Sessions opened this way are already recorded with `via: "openid"` (`sessions.ts`). A user "must already exist in Proxmox (or the realm must have auto-create enabled)" (`docs/ACCESS.md`).

**Not verifiable here, and therefore not claimed:**

- The Proxmox VE versions that support all of the above. The repository records no minimum version, and every test uses a fake Proxmox (`services/epaperclip/test/fakes-access.ts`). The minimum PVE version is a **gate**: it is determined on the approved test host (ACCEPTANCE EP-10) and written into the user guide before the feature is switched on. Until then the feature is "built, unverified".
- Whether Proxmox sends a PKCE `code_challenge`, which `id_token` signing algorithms it accepts (RS256 is the OIDC baseline; EdDSA is not assumed), whether it re-fetches the JWKS on each login or caches it and for how long, and exactly how it validates `iss`, `aud`, `nonce` and `exp`. The contract requires the issuer to be correct under any strict validation, and the test on the real host (10.11) must capture an actual `auth-url` and a login to record these behaviours. If PKCE is absent, the confidential client secret plus `state` and `nonce` are the protection; the doc then says so rather than implying PKCE.
- The Proxmox privileges needed to create a realm and a user (expected: the realm-allocate and user-modify privileges on `/access`); the admin's own Proxmox account must hold them, because the host service acts with the administrator's session (`ctx.asUser()`), never with extra authority. Confirm on the test host.
- That `username-claim=subject` with `query-userinfo=false` yields `<sub>@papercliped` on the target PVE versions. Expected from the schema; to be confirmed. If it does not, the fallback is a `username` claim with `query-userinfo=true`, which adds a userinfo endpoint to the issuer (10.4).

### 10.3 What the device administrator configures locally

1. A PVE version confirmed per 10.2 (written into the user guide after the host test) and outbound HTTPS from the **Proxmox node** to the issuer (`auth.papercliped.co`): Proxmox, not the browser, calls the token endpoint and the JWKS.
2. In ePaperclip, Access, People and permissions, an administrator with the Proxmox privileges above presses **Enable Sign in with Papercliped**. The device (a) registers a client with Connect (10.4), (b) creates the realm through the existing `POST /api/access/realms`: `realm=papercliped`, `type=openid`, `issuer-url=https://auth.papercliped.co/oidc`, `client-id=<from Connect>`, `client-key=<from Connect, never shown>`, `username-claim=subject`, `scopes=openid`, `query-userinfo=false`, `autocreate=false`, no `groups-*`, and `prompt` as the administrator chooses (`login` forces a fresh Papercliped sign-in each time). A realm called `papercliped` that already exists with different settings is not touched: 409 `realm_conflict`.
3. A federated principal appears only through a link the administrator approves (10.5). The administrator then grants permissions in Proxmox or the Access page. Nothing is granted by default.
4. **Disable** reverses step 2 (removes the client at Connect, deletes the realm only if it still matches what was created, ends federated sessions). Local password sign-in is untouched.

### 10.4 The issuer (Connect owners build this)

Connect hosts a minimal OIDC provider at `https://auth.papercliped.co/oidc` (issuer exactly this string; discovery at `/.well-known/openid-configuration`, JWKS at `/oidc/jwks`, `/oidc/authorize`, `/oidc/token`). Supabase Auth's OAuth server is not used for V1 (the README records it as beta and disabled, and it cannot give a per-device audience).

| Requirement | Specification |
|---|---|
| Flow | authorization code only; `response_type=code`; no implicit, no hybrid; `S256` PKCE accepted and, when the client sends a `code_challenge`, enforced at the token endpoint |
| Clients | one confidential client per registered device: `client_id = "ep-" + deviceId`, a random 256-bit `client_secret` (stored hashed at Connect, shown to the device exactly once). A client exists only while the device is registered and federated sign-in is enabled for it |
| Redirect URIs | exact-match allow-list registered by the device (device-signed): `https` only (loopback `http` only in development builds), no wildcard, no userinfo, no fragment, path exactly `/` (the console origin; ePaperclip already passes the site address). Private-network `https` origins are allowed because the redirect is a browser redirect to the LAN console. Open question 14 on how many origins |
| Authorization | the browser needs a Connect session for account `A`. Connect issues a code only if `A` holds an **active `federated` link on this device** (`identity_links.kind='federated'`, `state='active'`); otherwise `error=access_denied` with a plain-language page. A signed-out browser is sent through the normal sign-in, then back. `prompt=login` and `max_age` honoured |
| Code | single use, 60 s, bound to client, redirect URI, `nonce`, PKCE challenge and the account; replay of a used code revokes tokens issued from it and audits |
| `id_token` | signed JWT, `alg` RS256, header `kid`. Claims: `iss` = issuer string, `aud` = `client_id` only, `azp` = `client_id`, `sub` = `bridge.accounts.id` (never email, never a username), `iat`, `exp` (<= 5 min), `nonce` (echoed), `auth_time`. **No** `email`, `name`, `groups`, `roles`, `admin` or custom privilege claim. Nothing in a cloud claim can influence a Proxmox role |
| Access token | not issued for use anywhere else (token endpoint may return an opaque, 1-minute value to satisfy clients; `userinfo` is not offered unless the 10.2 fallback is needed, and then returns only `sub` and `username`) |
| JWKS rotation | at least two keys published while rotating: publish the new key >= 24 h before signing with it, stop signing with the old key, keep it published >= 24 h after the last token it signed expires (>= 1 h). Never reuse a `kid`. Rotation is a runbook item in `docs/runbooks/key-rotation.md`. Emergency rotation removes the old key at once and accepts that logins fail until Proxmox refetches |
| Separate keys | the OIDC signing key is distinct from the claim keys and the hint key |
| Device registration routes | `POST /api/v1/devices/{deviceId}/oidc-client` (device-signed action `oidc-register`; body `{ redirectUris: [...] }`) -> `201 { issuer, clientId, clientSecret }` (secret returned once; repeat call 409 `already_registered`); `PUT .../oidc-client/redirect-uris` (device-signed) ; `POST .../oidc-client/rotate-secret` (device-signed; old secret valid for 10 min); `DELETE .../oidc-client` (device-signed). Entitlement: **none required** (the issuer is reachability to the person's browser and the Proxmox node, not the paid tunnel); open question 13 |
| Failure | issuer down or unreachable: Proxmox's login fails; the console shows "Sign in with Papercliped is unavailable" and the other realms keep working (10.9) |

### 10.5 Creating the federated link

Same protocol as section 5 (device-held verifier, signed start/confirm, userCode, step-up) with these differences, all keyed on `kind: "federated"`:

- **Principal.** It is not taken from the starter's local session. It is **computed**: `userid = <accountId>`, `realm = papercliped` (the account id is only known after approval, so the device sets `principal = { userid: <approver accountId>, realm: "papercliped" }` at confirm and Connect checks it equals `accountId@papercliped`; `principalUserid` in `start` is the placeholder `"*"`). One account maps to exactly one federated principal; nobody can pick a different one. Open question 15 asks Connect to confirm the account id charset is valid as a Proxmox userid.
- **Starter.** Any signed-in local user can start it (their `sessionBinding` is used as in 5.3). The starter's own principal is recorded as `requestedBy` for audit and does not become the linked principal.
- **Consent.** A federated link **always** needs a local administrator's approval, with no owner-account shortcut and no pre-approval bypass (a pre-approval may pin `boundAccountId` and satisfies the admin step only if created by an administrator for that exact account and `kind=federated`): it creates a login path, so a node administrator must say yes. If the starter is a node administrator this is satisfied in the same session (`approvedBy: self-admin`).
- **Effect of approval.** The device, acting with the **administrator's session**, creates the Proxmox user `<accountId>@papercliped` with **no ACLs and no group** (or, if it already exists and is disabled from a previous unlink, enables it), then sends `confirm`. If creating the user fails, nothing is confirmed (state stays `awaiting_admin`, error `principal_create_failed`). The approval screen offers a shortcut to the permissions page; it never preselects a role.
- **No privileged auto-creation, no cloud-driven grant.** `autocreate` stays false so Proxmox never creates users from a login; roles, groups and ACLs are set only by a local Proxmox-authorised person; the realm has no groups claim; the issuer has no way to express a role.

### 10.6 The login flow

```
Browser            ePaperclip host service          Proxmox (pveproxy)           Connect OIDC issuer
 Sign in with Papercliped
 --> POST /api/login/openid/start {realm:"papercliped"}
                    check the link gate is enabled; same-origin; limiter
                    POST /access/openid/auth-url (realm, redirect-url) --> state, nonce (and PKCE if Proxmox uses it)
                    <-- provider URL;  Set-Cookie epc_oidc (one-use, HttpOnly, SameSite=Strict)
 <-- { url }
 redirect to https://auth.papercliped.co/oidc/authorize?...     --> session for A? link active on this device? issue code
 <-- redirect to the device origin /?code=..&state=..
 --> POST /api/login/openid/finish {code, state}
                    cookie + state match, one use
                    POST /access/openid/login (code,state,redirect-url)
                                                    --> POST token endpoint (client_id, client_secret, code[, verifier])
                                                    <-- id_token; Proxmox validates signature (JWKS), iss, aud, exp, nonce
                                                    <-- ticket for  <sub>@papercliped
                    LINK GATE: is  <sub>@papercliped  an ACTIVE federated principal, and is the cloud state fresh enough?
                       no  -> discard the ticket, 403 not_linked, audit, no session
                       yes -> create session  {via:"openid", link:<linkId>};  sessions cap 8 h absolute
 <-- signed in; permissions = that principal's effective Proxmox ACLs, checked per call
```

Points that differ from the generic OpenID path today: the **link gate** (a Proxmox user in the `papercliped` realm that was not created through an approved link cannot sign in to ePaperclip, even if an administrator created it by hand or `autocreate` was turned on in Proxmox), the `link` tag, and the session lifetime cap. The ticket Proxmox issued is held only server-side; refusing a login discards it.

### 10.7 Validation responsibilities

| Check | Who | Notes |
|---|---|---|
| `id_token` signature against JWKS, `iss`, `aud` = this `client_id`, `exp`, `nonce` | **Proxmox** (the party that receives the token) | expected per OIDC; **to be confirmed on a real host** (10.2). The host service never sees the `id_token`, so it does not claim to validate it |
| `state`, one-use browser-bound cookie, limiter | ePaperclip (exists today) | A-12 |
| the issuer only mints a code for an account with an active federated link on this device | Connect | server-side, per request |
| the returned principal is an active federated principal of this device | ePaperclip link gate | defence in depth if Proxmox or an administrator drifts |
| permissions | Proxmox ACLs on the principal, per call, in the console and in `/mcp` | unchanged |

### 10.8 Session and token provenance, revocation

- Every session created by 10.6 stores `link: <linkId>` next to `via: "openid"`. The sessions list shows "Papercliped".
- OAuth/MCP tokens issued at consent time while such a session is in use store the same `link`. Tokens obtained from a password session of another principal never carry it.
- Revocation of a federated link (unlink from any initiator, owner removal, account deletion, device unpair, reconcile finding `revoked`, principal removed) ends every session and revokes every token with that `link`, disables the Proxmox user, and revokes the client's refresh state at Connect (none is issued). Sessions of the same person created by another credential or another principal are untouched, as 8.1 requires.
- Because a cloud-side revoke reaches an offline device only at reconcile, federated sessions are capped at 8 h absolute and re-checked at each sign-in and each 15-minute reconcile. Open question 16.

### 10.9 Offline, Connect down, and the local password path

- The local password / WebAuthn / other-realm paths never depend on Connect or on the `papercliped` realm. Disabling or losing the realm, the issuer or the Internet cannot lock out `root@pam` or any `pam`/`pve`/`ldap` principal.
- If Connect or the issuer is unreachable: new Papercliped sign-ins fail (Proxmox cannot reach the token endpoint); the page says so and keeps the other sign-in methods visible. Already-open federated sessions continue until the 8 h cap unless a reconcile marks the link revoked.
- A **federated-only** person has no local password (an OpenID principal has none). That person cannot sign in while Connect is down. The product must say so at enable time and recommend that people who need that guarantee also hold an `association` link to a local principal, or that the administrator keeps a local administrator account. This is a stated trade-off of federation, not a defect to hide.
- Subscription state, tunnel state and entitlement do not affect federated sign-in on the LAN address. Whether the issuer serves devices without a paid seat is open question 13.

### 10.10 Permissions

A federated principal has exactly the Proxmox permissions an authorised local person gave `<accountId>@papercliped`, evaluated server-side per call. Cloud login, ownership of the device, subscription, a link, membership or any claim never grants, widens or implies an administrator role. The device owner's account gets no automatic rights either: if the owner also wants Papercliped sign-in as an administrator, an existing local administrator approves and grants it like anyone else.

### 10.11 Tests required for the federated flow

Connect (real Postgres plus an OIDC client test harness): discovery and JWKS shape; code single use and 60 s expiry; replay of a used code; `redirect_uri` exact match and every rejected form; wrong `client_secret`; `aud` is only the device's client; no privilege claims in the token; `sub` is the account id; access denied for an account with no active federated link on that device, with an association-only link, with a revoked link, and for a link on another device; PKCE enforced when presented; key rotation with overlap (old and new `kid` both validate); secret rotation window; `DELETE oidc-client` kills outstanding codes.

Device (fake Proxmox that also fakes the two OpenID endpoints, plus a fake issuer): enable creates exactly the expected realm (no groups, `autocreate` false) and refuses `realm_conflict`; approval creates a user with no ACLs and nothing else; the link gate refuses a hand-made `x@papercliped` user and discards its ticket; session and token carry `link`; unlink ends exactly those sessions and tokens while a password session of the same account's association principal and another principal's sessions survive; Connect unreachable: password sign-in still works, federated sign-in reports unavailable, open federated session survives until its cap; the 8 h cap; reconcile revokes a cloud-revoked link; disable removes only what enable created.

Real host (ACCEPTANCE EP-10 prerequisite): on the approved test Proxmox host and the production issuer, with two accounts: record the PVE version, capture the `auth-url` (PKCE present or not), confirm `username-claim=subject` and `query-userinfo=false` behaviour, a Proxmox rejection of a token with wrong `aud`, wrong `nonce`, expired `exp`, and an unknown `kid` after rotation, a real console login and a real `/mcp` consent as the federated principal with ACLs enforced (an allowed and a denied operation), unlink revoking the session and token, and sign-in with Connect blocked at the firewall (local password path works).

## 11. Data

Connect (proposed additive migration, owners to review):

```
connect.identity_links (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null,
  account_id text,                                -- set at approve
  principal_userid text not null, principal_realm text not null,
  kind text not null default 'association' check (kind in ('association','federated')),
  requested_by text,                               -- local principal that started a federated link
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

OIDC issuer tables (new, owners to design): `connect.oidc_clients` (device_id, client_id, secret hash, redirect URIs, state), `connect.oidc_codes` (hash, client, account, nonce, challenge, expires, used_at), signing keys held as Worker secrets with a `kid` list. Device: link records in the `StateStore` settings (non-secret), sealed verifiers in the vault (secret), pre-approvals (non-secret, device-local), a replay cache of hint `jti`s in memory.

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
| T12 | Link used to gain permissions | an `association` link derives nothing; a `federated` login yields only the permissionless-by-default principal, local ACLs decide, no cloud claim maps to a role |
| T13 | Stale link after cloud revoke while device offline | reconcile; federated sessions capped at 8 h and re-checked at sign-in and reconcile; an `association` link grants nothing |
| T14 | Enumeration of devices/links/accounts | uniform 404/403; member and owner lists scoped by session account |
| T15 | Brute force of userCode | 5 attempts per link, rate limits, 10 min life |
| T16 | Forged or hostile device (paired by an attacker) | device can only create links for its own device row; members of that device see only what the attacker's device chooses to show; the account holder sees device name and owner before approving |
| T17 | Clock skew locking out linking | same 60 s rule as tunnel credentials; error text names the clock |
| T18 | PII spread (principal names at Connect) | stored only after consent; deletion on account/device removal; open question 3 |
| T19 | Shared-database blast radius | same as existing T3; new table is RLS-on and reached only through the Worker role |
| T20 | Federation bypassing local ACLs | new principal in its own realm with no ACLs by default; `autocreate` false; no groups claim; ACLs set only by a local Proxmox-authorised person |
| T21 | Forged or replayed `id_token` / authorization code | Proxmox validates signature, `iss`, `aud`, `exp`, `nonce` (to be confirmed on a real host); code single use, 60 s, client-bound; redirect URI exact match |
| T22 | Token for device A used on device B | `aud` is the per-device `client_id`; the issuer mints only for an active federated link on that device |
| T23 | Unlinked or hand-made `x@papercliped` Proxmox user signs in to ePaperclip | link gate refuses and discards the ticket; issuer refuses to mint without an active link |
| T24 | Issuer key compromise or botched rotation | dedicated key, overlap rotation, emergency rotation runbook; devices fail closed for new sign-ins, local paths unaffected |
| T25 | Issuer or Internet down locks people out | local realms never depend on it; federated-only people are told at enable time (10.9) |
| T26 | Open redirect or code theft via redirect URI | exact-match https allow-list registered by the device-signed route; no wildcard |
| T27 | Account takeover at Papercliped becomes machine access | federated principals start with no ACLs; `prompt=login`/`max_age` available; step-up on link approval; admin can run 8.3 |
| T28 | Cloud claims or groups escalate to admin | tokens carry no email/groups/roles; realm has no `groups-claim`; roles come only from Proxmox ACLs |
| T29 | Client secret exposure | stored hashed at Connect; stored only in the Proxmox realm secret store on the node; never shown; rotation with a 10 min overlap |

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
| EP-3, EP-10, MC-4 | principal and ACLs enforced on the device; the federated flow is part of the real-host validation |
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
| ID-16 | Optional username pre-fill for association links, labelled as association (not sign-in) | tests |
| ID-17 | **Sign in with Papercliped (V1)**: federated link creation with local admin approval, permissionless principal, no auto-creation | tests, then real host |
| ID-18 | Connect OIDC issuer: discovery, JWKS rotation, per-device client, code/redirect/`aud` rules, no privilege claims | `verified-test` on real Postgres, then `verified-live` |
| ID-19 | Proxmox OpenID realm created by the device administrator; PVE version support recorded; Proxmox rejects bad `aud`/`nonce`/`exp`/`kid` | real test host (EP-10) |
| ID-20 | Federated session and MCP token carry the link; unlink revokes exactly those; unrelated sessions survive | device tests, real host |
| ID-21 | Connect or issuer down: local password path works; federated shows unavailable | real host with Connect blocked |
| ID-22 | Effective-ACL enforcement for a federated principal in the console and `/mcp` (allowed and denied operation) | real host |

## 14. Test and implementation gates (before any code merges)

- Connect: real-Postgres tests for each error in 5.9, the uniqueness indexes, concurrent double confirm (exactly one wins; the other gets the idempotent answer or 409), concurrent approve vs deny, expiry boundary, code lockout, secret nulling, tenant isolation (another account's link looks missing), `replaceLinkId` swap atomicity, OpenAPI entries plus the existing contract test.
- Device: fake-Connect tests for each device state, sealed-verifier deletion on every exit, session-binding mismatch, `wrong_account`, admin approval matrix (6.3), a node admin cannot link for another user, unlink leaves another session and an MCP token alive (negative test), `connect_unreachable` leaves state unchanged, `pendingRevoke` retry.
- Federated flow: the tests listed in 10.11 are part of these gates.
- A real two-account, two-principal run on a real device before ID-11..ID-15 and ID-17..ID-22 can be marked `verified-live`.

## 15. Open questions for the Connect owners

1. **Pairing in non-Connect modes.** May a `local` or `cloudflare-self` device stay registered (free, no seat) for linking? Today the engine does not forbid it and `connect.devices` has no entitlement dependency; confirm it is intended, and that a registered-but-unsubscribed device is not purged.
2. **Schema for member rows.** `connect.devices` is keyed `(account_id, id)` with a composite FK from `audit_events` and `device_pairings`. Is it acceptable that `identity_links` references `devices(id)` and carries a different `account_id` for members, and that `audit_events` rows for a member's actions use the owner's `(account_id, device_id)` plus an `actor_ref`? Or should members get their own audit account scoping?
3. **Principal names at Connect.** `docs/DATABASE.md`/`DEVICE-PROTOCOL.md` say local users are not represented. This contract stores `userid@realm` (needed for the approval page and the owner's member list). Is that acceptable, or should Connect store only a device-salted HMAC and show a device-supplied label that is not persisted?
4. **Masked email.** May `emailMasked` appear on the device confirm panel and the member list, or display name and id suffix only? (Revision 1 question, still open.)
5. **Owner-invited members.** Is a cloud-side owner invitation wanted in V1 (owner invites an account, local admin still approves), or is request plus local pre-approval enough?
6. **Reconcile cadence and cloud-initiated unlink in V1.** Proposed: at start, when the Access page loads, and every 15 minutes with jitter (same loop as the tunnel check, but independent of mode). Is cloud-initiated unlink V1?
7. **Rate-limit numbers** in 5.10.
8. **Retention** of terminal `identity_links` rows (proposed 90 days) and of the audit events; interaction with ID-10 deletion.
9. **Username pre-fill (section 9).** Wanted at all? It is association only and not part of the sign-in deliverable. If yes: a dedicated hint key.
10. **Issuer hosting.** This contract chooses a Connect-hosted OIDC provider at `https://auth.papercliped.co/oidc` (Supabase's OAuth server is beta and disabled). Confirm the Worker, the domain and who owns it, and the signing-key storage.
11. **Step-up lifetime** for `approve`: reuse the existing `STEPUP_TTL`, or a shorter one for linking?
12. **Account switching and the owner.** May the device owner's account replace its own link (`replaceLinkId`) without any local approval? This contract says yes (no admin step for the owner account, 6.3).
13. **Federated sign-in without a paid seat.** The contract serves the issuer to any registered device (reachability to the person's browser and the Proxmox node, not the paid tunnel). Confirm no entitlement check, or define one (a paid-only issuer would contradict "local-only and self-managed users can link").
14. **Redirect URI limits.** How many registered redirect origins per device, and are private-network https origins (self-signed or private-CA) acceptable to the issuer?
15. **Account-id charset.** Confirm `bridge.accounts.id` values are valid in a Proxmox userid (`<accountId>@papercliped`), or define a deterministic encoded username claim (which then needs `query-userinfo=true` and a userinfo endpoint, 10.2).
16. **Federated session cap and offline behaviour.** 8 h absolute and re-check at sign-in and 15-minute reconcile proposed. Different cap, or should open federated sessions end when Connect is unreachable (stricter, but locks federated-only people out mid-work)?
17. **Minimum PVE version and realm privileges** are unknown until the real-host test; who provides the approved test host and when (EP-10)?
18. **Owner policy.** May the device owner require that all new members use `federated` links only, or `association` only? Not specified; proposed as a local administrator setting, not a cloud one.
