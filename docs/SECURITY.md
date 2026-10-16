# Security

ePaperclip replaces the Proxmox web interface on port 443 and acts on Proxmox as the person who signed in. A flaw here is
a flaw on someone's hypervisor, so this page says what the product defends, how, where in the code, what was found when it
was audited before v1 and what is left. Every fixed finding has a test that tries the attack (listed with it); run them all
with `pnpm test` and `bash deploy/test/run.sh`.

## Reporting a vulnerability

Please report privately, not in a public issue.

1. Use GitHub's private vulnerability reporting on the repository (Security tab, "Report a vulnerability"). The owner needs
   the feature switched on for the repository (Settings, Code security); until it is, there is no private channel listed
   here and that is an open item (see "Needs the owner").
2. Include the version (`/opt/epaperclip/VERSION`), what you did, what you expected and what happened. A request that
   shows it (curl is fine) beats a description.
3. Please give us 90 days before publishing, and don't test against hosts that aren't yours.

What counts: anything that lets someone act on a host as a person they are not, see or change what Proxmox would not let
them, run code on the host, read the vault, get past the page's content security policy, or make the update path install
something that wasn't published. What doesn't: needing a Proxmox administrator (they are root-equivalent already), needing
a shell on the host, or findings in Proxmox, the engine or Node.js themselves (report those upstream).

## Threat model

**What is protected**

| Asset | Where it lives |
| --- | --- |
| Proxmox tickets and CSRF tokens of signed-in people | Host service memory only. The browser holds an opaque session id. |
| Managed engine passwords, connector API keys, Proxmox API-token secrets (ePaperclip API tokens, automations, the agent-container sandbox), the SSH key | `/var/lib/epaperclip/state.json`, sealed with AES-256-GCM by `vault.key` (0600, same directory, mode 0700). |
| The engine's data and its secrets | `/var/lib/epaperclip-engine`, `/etc/epaperclip/engine.env` (0600, root). Loopback only. |
| The host itself | Whatever the three services and the update helper can reach. |

**Who is who**

| Actor | Trust |
| --- | --- |
| A visitor with no account | Nothing. Can reach the sign-in routes, `GET /api/health`, `GET /api/realms`, static files. |
| A signed-in Proxmox user | Exactly what Proxmox lets that user do. ePaperclip adds no authority; it must never add any. |
| A Proxmox administrator (Sys.Modify on `/`) | Root-equivalent on the hypervisor already (node shell, ACLs, storage). Also the engine's instance admin, and may change connectors, agent containers, updates. |
| An ePaperclip API token | The person it belongs to, minus what the token's flags take away (read-only, privilege-separated). |
| The browser and any page in it | Untrusted input. Another site in the same browser must not be able to act as the person. |
| Model providers, the release feed, the catalog, certificate authorities, Proxmox's own answers | Untrusted data. Never run, never trusted as markup, never trusted as a link target. |
| The engine (Paperclip) | Trusted for its own data, not for deciding what a Proxmox user may do on the host. It listens on loopback and runs as its own user. |
| The host service process | Unprivileged (`epaperclip`), sandboxed by systemd. Its compromise is serious (it holds users' tickets and the vault) but must not become root: the update path is the only bridge and treats the service as hostile. |

**Trust boundaries that matter**

1. Browser to host service (HTTPS 443): sessions, CSRF, Origin, CSP, rate limits.
2. Host service to Proxmox (loopback, TLS verified against the cluster CA): always as the person or as a Proxmox API token.
3. Host service to engine (loopback): the person's managed account; the service account only for jobs ePaperclip itself authorises.
4. Host service (unprivileged) to the update helper (root): one request file in a folder the service owns.
5. Host service to the outside: model providers, the release feed, vendor checksum files, the signed catalog.
6. Release to host: tarball, `.deb`, npm package, Node.js, the engine's npm packages.

## What is enforced, and where

| Rule | Where | Test |
| --- | --- | --- |
| Sessions: 256-bit random id, `HttpOnly; SameSite=Strict; Secure`, `__Host-` prefix over HTTPS, 2 h idle / 12 h absolute, never reused across sign-ins, ended when the person's access is removed or their password changes | `sessions.ts`, `app.ts` | `security.test.ts`, `iac.test.ts` |
| Every POST, PUT, PATCH and DELETE under `/api` needs `X-EPC-Request: 1` and a same-host `Origin` (or a valid Bearer token), enforced centrally before routing; read-only tokens can't pass it | `app.ts` (`handle`, `requireSameSite`), `access-tokens.ts` (`guard`) | `security.test.ts` |
| WebSockets (consoles, engine events): same-host `Origin` and a session cookie before the upgrade; VNC sessions are one-time, 30 s, bound to the session | `app.ts` (`socketPrecheck`), `console.ts`, `engine.ts` | `security.test.ts`, `app.test.ts`, `engine.test.ts` |
| Sign-in limits: 8 failures per address or per person (however the name is typed) in 15 minutes; wrong second-factor codes count too and aren't reset by starting over; 5 tries per two-factor step; body must arrive within 30 s | `app.ts` (`LoginLimiter`, `userKey`), `http.ts` | `security.test.ts` |
| Every change runs as the person against Proxmox, so Proxmox's permissions decide; inputs are checked against narrow patterns before they reach it (names, volume ids, file names, URLs, firewall fields, hardware strings) | `app.ts`, `features/*`, `firewall.ts`, `hardware.ts` | `app.test.ts` and each feature's tests |
| Anything ePaperclip does with its own authority (engine service account, device-role side effects, organization membership) first checks the caller's own right: org owners/admins, or the Proxmox permission to hand out ACLs | `iac.ts`, `app.ts` | `iac.test.ts` |
| API tokens: `epc_<id>_<secret>`, salted SHA-256 stored, constant-time compare, always hashed (no id oracle), 1 to 366 days, per-token rate limit, per-address failure lock, mapped to a real Proxmox token so Proxmox enforces expiry and removal; can't create tokens, change passwords or two-factor, mint Proxmox tokens, open consoles or approve plans; privilege-separated ones don't get the person's engine access | `features/access-tokens.ts`, `features/access.ts`, `engine.ts` | `access-tokens.test.ts`, `security.test.ts` |
| `/engine/api` proxy: **route allow-list** (only the engine routes the console's client uses, `engine-allow.ts`, kept equal to the client's list by a test and exercised against the real engine by the E2E harness), fixed header allow-list both ways (no cookies or Authorization through, no `Set-Cookie` back), dot segments / empty segments / encoded slashes refused, auth routes blocked, the managed-sandbox-only setting can't be turned off, replies can't run as a page of this origin (`sandbox` CSP, active types download) | `engine.ts`, `app.ts` (`engineGuard`) | `engine.test.ts`, `containers.test.ts` |
| Content security policy on every response: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, plus `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, HSTS, `COOP/CORP: same-origin`. The console has no inline code, no HTML sinks, no third-party loads; links from outside data must be plain http(s) | `app.ts` (`baseHeaders`), `apps/console` | `app.test.ts`, `apps/console/test/security.test.ts`, `check:design` |
| Secrets never leave: connector keys and token secrets are sealed, returned only as last four characters or once at creation, scrubbed from provider errors, job logs and Proxmox errors | `vault.ts`, `connectors.ts`, `containers.ts`, `features/nodeCerts.ts` | `pin.test.ts`, `containers.test.ts`, `access-tokens.test.ts` |
| Outbound fetches (vendor checksum files, the catalog): https only, no addresses on this network by name or by DNS answer, 3 redirects, 2 MB, 15 s. Provider calls go to fixed hosts | `vendorFetch.ts`, `connectors.ts` | `vendorFetch.test.ts` |
| The Store's catalog is shown only if signed by a pinned Ed25519 key, unexpired, with a sequence number that never goes down (also across restarts); entries are validated, text can't carry markup | `packages/marketplace`, `app.ts` | `security.test.ts`, `app.test.ts`, `packages/marketplace` tests |
| Pin never changes anything itself: action tools only propose; plan steps are parsed strictly, labelled by the server, approved one at a time by the signed-in owner (not a token), destructive ones need a typed phrase; automations act through their own scoped Proxmox token and only notify on `protected` machines; chats are limited to 20 a minute and 3 at once per person | `pin.ts`, `features/pin-agent.ts`, `features/pin-automations.ts` | `pin.test.ts`, `pin-runtime.test.ts`, `pin-model.test.ts` |
| Updates: the service writes a request file (fixed shape); a root helper re-validates it, treats the shared folder as hostile (real-directory check, O_NOFOLLOW read, private log, rename-into-place), refuses older releases, checks the release's SHA-256, runs the installer's staged install with automatic rollback | `features/pin-update.ts`, `deploy/epaperclip-update.*`, `deploy/install.sh` | `deploy/test/run.sh update_helper` |
| systemd sandboxes: host service and engine run unprivileged with `NoNewPrivileges`, `ProtectSystem=strict`, no home, private `/tmp` and devices, kernel protections, restricted address families, `UMask=0077`, hidden `/proc`, memory caps; the engine has no capabilities at all | `deploy/*.service` | `deploy/test/run.sh` (unit contents) |
| Installer: pinned, checksum-verified Node.js; engine and provider from their lockfiles with integrity hashes and `--ignore-scripts`; secrets written once with 0600; stage, test-start, swap, roll back | `deploy/install.sh` | `deploy/test/run.sh` |

## Findings from the pre-v1 audit

Severity is the audit's judgement of impact with the existing deployment model. "Fixed" means a change and a test that
fails without it.

### Fixed

| ID | Severity | Finding | Fix and test |
| --- | --- | --- | --- |
| F-01 | High | The root update helper wrote its log and status through fixed names inside `/var/lib/epaperclip/update`, a folder the unprivileged host service owns. A link named `log` or `status` made root truncate (`: >`), append to or `chmod 0644` any file (`/etc/shadow`, a key). Replacing the folder by a link, a pipe or directory in place of `request`, and a swap between check and read were open too. | The helper steps into the real directory (`cd -P`) and checks it, reads the request with `dd iflag=nofollow,nonblock`, builds log and status in its private `/tmp` and puts them in place by renaming a fresh file over the name. `deploy/test/run.sh update_helper` (links, swapped folder, pipe, folder). |
| F-02 | High | An ePaperclip API token that "acts as you" could create or regenerate Proxmox API tokens (`POST/PUT /api/access/users/:id/tokens`) with no expiry and `privsep=false`, returning the secret: a permanent credential that escapes the token's 366-day limit, its revocation and the audit pin; and `PUT` could loosen another token's privilege separation. | Token principals get 403 `ticket_only` on both routes. `security.test.ts` "a token can't mint…". |
| F-03 | Medium | `GET /api/iac` read organizations and their members as the engine's instance admin (service account) for everyone, so any signed-in Proxmox user saw every organization's name, id and role mapping. | Non-administrators read through their own engine account. `iac.test.ts` "only sees their own organizations". |
| F-04 | Medium | `PUT /api/iac/users/:id {deviceRole}` ran its engine and session side effects (end all of the target's sessions, flip their engine-admin flag) even when the Proxmox ACL step needed no write, so Proxmox never said no. Anyone able to read ACLs could sign out any user or demote an engine admin until their next sign-in. | The caller must hold `Permissions.Modify` at `/` first. `iac.test.ts` "can't use that to sign others out". (Whether Proxmox lets every audit-level account read ACLs depends on the version; the test double allows it.) |
| F-05 | Medium | An organization's `admin` could make anyone (themselves) an `owner`, or demote or remove an owner: the change is made as the engine's instance admin, which skips the engine's own rule about who may do that. | Admins can't grant owner or touch owners; owners and Proxmox administrators can. `iac.test.ts` "an organization's admin can't make themselves…". |
| F-06 | Medium | A privilege-separated API token (meant to hold only the permissions given to it in Proxmox) was served the person's full engine access through `/engine/api`, resource groups and Pin's organization tools, because the engine knows the person, not the token. | `EngineGateway.loginFor` refuses privilege-separated tokens (403 `token_scope`). `security.test.ts` "never gets the person's engine access"; `docs/API.md`. |
| F-07 | Medium | Wrong second-factor codes weren't counted: a correct password reset the failure record, so guessing could restart without limit (Proxmox's own TOTP lock is the only other layer). Names typed differently (`sam`+`pve`, `sam@pve`, `SAM@PVE`) had separate records. | Codes count against the person and the address until a full sign-in; one record per person. `security.test.ts` "sign-in limits". |
| F-08 | Medium | The catalog's anti-rollback sequence floor lived only in memory, so after a restart an older but unexpired signed copy was accepted again. | The floor is kept in the state file. `security.test.ts` "won't go back… after the service restarts". |
| F-09 | Medium | Every signed-in person could start unlimited Pin chats; each spends the organization's model key and holds a connection and up to six provider calls. | 20 a minute and 3 at once per person (429). `pin.test.ts` "chat cost and load limits". |
| F-10 | Low | The update helper would install any release number it was asked for, including an old vulnerable one, from a request the unprivileged service writes. | Releases older than the running one are refused (`rollback` is the way back). `update_helper` scenario. |
| F-11 | Low | Vendor and catalog fetches blocked IPs and `localhost` by spelling only: `localhost.`, `x.localhost`, single-label and `.internal` names, and any name whose DNS answer is a private or metadata address passed. | More names refused, and the connection's DNS answer is checked (any private answer refuses). `vendorFetch.test.ts`. |
| F-12 | Low | The session cookie could be planted from a sibling domain or over plain HTTP (no `__Host-` prefix). New sign-ins already issue fresh ids, so this was a login-CSRF / session-confusion risk. | `__Host-epc_session` over HTTPS. `security.test.ts` "session cookie". |
| F-13 | Low | Sessions survived a password change; whoever had the old password kept a live session for up to 12 h. | Changing a password (own or by an administrator) ends the person's other sessions. `iac.test.ts` "changing a password". |
| F-14 | Low | Before sign-in, a request body could trickle in for up to the 6 h upload limit, holding a connection (and a descriptor) per attacker socket. | JSON bodies must arrive within 30 s (408, connection closed). `security.test.ts` "slow requests". |
| F-15 | Low | Links built from outside data (a CA's terms-of-service URL, a subscription's shop URL, a release page) weren't checked to be http(s). The CSP already stops `javascript:` from running, so this was defence in depth. | `httpUrl()`; a test keeps new links from skipping it. `apps/console/test/security.test.ts`. |
| F-16 | Low | A route that forgot `ctx.sameSite()` would have been cross-site reachable and open to read-only tokens. None did (all routes were audited), but nothing enforced it. | Central enforcement for POST/PUT/PATCH/DELETE under `/api`. `security.test.ts` "cross-site requests", "read-only token". |
| F-17 | Info | `from-source.sh` put its GitHub token on `git`'s command line, readable with `ps`. | Passed through git's environment. |
| F-18 | Info | systemd: other processes were visible in `/proc`; the root update unit had no kernel hardening. | `ProtectProc=invisible`, `RemoveIPC`; update unit protects kernel tunables, modules, clock, personality, realtime. |
| F-19 | Info | No cross-origin isolation headers. | `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`. |

### Checked, no issue found

CSRF and Origin handling (header and Origin both required; `null`, look-alike hosts and unparsable origins refused);
session fixation (ids are never taken from the client; sign-in always issues a new one); path traversal in static files,
ISO/template/upload/backup/restore routes (file names, storage ids and volume ids are matched against narrow patterns and
`..` is refused; static paths are resolved and prefix-checked); header and response splitting (no user data in headers;
`Set-Cookie` carries only the random id; JSON bodies are `JSON.stringify`'d); open redirects (the service never redirects);
shelling out (the host service's only child process is `ssh` with a fixed argument vector, a validated IP and user, and a
private 0600 key directory); Proxmox parameter injection (form-encoded by `URLSearchParams`, path segments encoded, and
Proxmox checks the person's rights for whatever arrives); SSRF through connector tests (fixed provider hosts) and
download-from-URL (Proxmox fetches, as the person, like its own UI); engine proxy path tricks and the managed-sandbox guard
(case, encoding, method, repeated keys, oversized bodies: `containers.test.ts`); WebSocket origin checks; timing of token
checks; secrets in logs and errors; XSS sinks in the console (none: no `dangerouslySetInnerHTML`, `innerHTML`, `eval`;
Pin's Markdown preview renders text only); file modes (state 0600 in a 0700 directory, vault key 0600 and re-tightened,
engine settings 0600 root, installer secrets 0600).

## The routine webhook door

By default the host exposes nothing without a sign-in except the login page, its assets, the realm list, the login notice and the health check. A Proxmox administrator can open one more door per organization: `POST /hooks/routines/<id>/fire`, so a service on the internet (GitHub, a build server) can start a routine. The risk, in words:

- **Anyone who can reach the host can send that request.** Whether it does anything is up to the engine: for a trigger with signing mode `none`, knowing the 24-hex address is the only secret, and a leaked address lets anyone start the routine (and so spend an agent's budget) until the trigger's address is rotated. Prefer the signed modes (GitHub or HMAC), which the engine verifies against the sender's signature headers; the host forwards those headers and the body byte for byte for that reason.
- **What the door does not do.** It forwards to exactly the engine's public fire route; it has no other path or method, does not accept or forward cookies or other headers, and never reaches the rest of the engine. It cannot be used to read anything: the answer is the engine's status and JSON for that one call. It answers 404 for unknown triggers, closed organizations and wrong paths alike, so it doesn't reveal which triggers exist.
- **Limits.** JSON only, 64 KiB, 15 s to send the body, 60 requests a minute per address, 30 per trigger, 600 overall. A flood costs a 429, not an engine call. Behind a shared proxy all callers share one address (see A-05).
- **Exposure.** It is the same port as the console, so opening an organization makes this one path reachable wherever the console is. Putting the host on the internet at all is the administrator's decision; a reverse proxy that only forwards `/hooks/` is the way to expose just this door.
- **Who decides.** Only Proxmox administrators, in a browser session; each change is in the audit log. Closing it again takes effect at once.

Tests: `access-people.test.ts` (the door, with a stand-in engine) and the real-engine E2E stage "routine webhooks from outside".

## Accepted, with reasons

| ID | Risk | Why it stays |
| --- | --- | --- |
| A-01 | Proxmox administrators are root-equivalent and are also the engine's instance admins. The console can't and doesn't limit them. | By design: "Integrated Access Control". The managed-sandbox-only guard keeps agents off the host even for them. |
| A-02 | Whoever compromises the host service process gets what it holds: live tickets, the vault key beside the sealed secrets, Proxmox token secrets for API tokens and automations. The vault protects a copied `state.json`, not a compromised process. | Inherent to acting as many users without their passwords. Mitigated by the sandbox, an unprivileged user, no shell, and the helper treating the service as hostile. |
| A-03 | "Download from URL" asks Proxmox to fetch any http(s) address, so it can reach the LAN from the hypervisor. | Proxmox does this itself, as the person, with its own checks; ePaperclip adds the same permission test. |
| A-04 | Pin sends machine names, tags, configuration (minus secrets by key name) and organization summaries to the model provider the administrator chose; a hostile name can try to steer the model. | Disclosed here; no provider is used until an administrator adds its key. The model can only propose; the server builds every plan label and the person approves each step, with typed phrases for destructive ones. |
| A-05 | Rate limits count by socket address. Behind a shared NAT one person's failures lock the group, and there is no trusted-proxy mode. | The service is meant to be reached directly on 443. |
| A-06 | DNS rebinding to the LAN address. | Served only over HTTPS with the node certificate; a rebinding host fails certificate checks. (`EPC_DEV_HTTP=1` is for local development only.) |
| A-07 | Any signed-in person can rewrite `state.json` by saving Pin settings repeatedly (each save is an fsynced whole-file write). | Low impact on a single host; needs an account. Worth a per-person write limit later. |
| A-08 | Read-only API tokens can't call `POST /api/mcp` (the MCP endpoint offers only read tools, but the central change guard refuses every POST). | Fails closed; use a normal token or the REST routes. A functional gap, not a weakness. |
| A-09 | A privilege-separated API token can still read the owner's Pin inbox, plans and automation list: ePaperclip's own per-person state, which Proxmox ACLs don't govern. | Read-only, and only the owner's own data; the token's reach into Proxmox and the engine is what separation limits. Revisit if tokens are ever handed to third parties. |
| A-10 | The agent-container template is created with `nesting=1` (containers inside the container). It stays unprivileged, with no bind mounts or raw `lxc.*` settings (the provider refuses a template that has them). | Lets tools that use containers work inside an agent's sandbox. Drop it from `plugins/proxmox-sandbox/template/build-template.sh` if you don't need that. |
| A-11 | GitHub Actions in `.github/workflows/release.yml` are pinned by major tag, not commit. | Common practice; pinning by SHA is a hardening step for the owner. |
| A-12 | OpenID Connect sign-in relies on the identity provider and on Proxmox's check of `state` and `code`; the host adds a one-use, browser-bound nonce cookie (so a login link can't be planted in someone else's browser) and the sign-in limiter. | The provider's own security is outside ePaperclip. |
| A-13 | WebAuthn keys are tied to the address Proxmox is configured with; an administrator who changes it can invalidate existing keys. The Sign-in policy screen says so and one factor of another kind is recommended. | Inherent to WebAuthn and to Proxmox keeping one address. |

## Needs the owner

1. **Release signing (High, open).** The one-click update, `get.sh` and the release tarball verify a SHA-256 that is published
   next to the file, so they protect against corruption, not against a compromised release or GitHub account (anyone able to
   publish a release can have the root helper install it). The `.deb`/APT path is GPG-signed and the catalog is Ed25519-signed;
   the tarball should be too. Suggested: sign `epaperclip.tar.gz` with the same Ed25519 scheme as the catalog (key in CI,
   public key pinned in `install.sh` and the helper), and make `get.sh` and the helper verify the signature before extracting.
2. **Engine API surface (Medium, narrowed).** `/engine/api` now forwards only the routes the console uses (an allow-list),
   so engine routes nobody listed, including future ones, are closed. Still to confirm with the real engine: that
   managed-sandbox-only blocks every adapter that would run a command on the host (not just the local adapter), because
   the listed agent routes remain open to the signed-in person.
3. **Automation tokens (fixed).** Automation tokens now expire (90 days by default, up to 366, chosen when the automation is
   made), the owner is told a week before, the automation stops cleanly when its token ends, and **Renew** (Pin >
   Automations, or `POST /api/pin/automations/:id/renew`) extends the Proxmox token and the host's record together. They
   appear in the Proxmox token list under the name `epcauto-<id>`. Automations made before this change have no end date
   until they are renewed once. ePaperclip API tokens can be renewed and rotated the same way (Access control > API tokens).
4. **A private way to report.** Enable GitHub private vulnerability reporting for the repository (and, if wanted, add a
   security mailbox); this page deliberately lists no address that doesn't exist yet.
5. **Hardening not applied because it can't be tested without real systemd:** `SystemCallFilter` for the host service and
   engine (the `ssh` client and Node need a considered list), `ProcSubset=pid`, `PrivateUsers`. Run them under
   `systemd-analyze security` on a Proxmox host before enabling.
