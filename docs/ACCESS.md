# Access control

ePaperclip replaces Proxmox's web interface, and its philosophy is **Integrated Access Control**: every change made here is made in Proxmox first, as the signed-in person, and Proxmox decides whether it is allowed. The engine then follows. Nothing here is a second user database. If Proxmox refuses, the screen shows its reason ("Proxmox refused: Permission check failed (/access/groups, Group.Allocate)"), and a person without the right sees the same screens read-only.

The Access area is **Access control** in the sidebar (and in Settings). It has twelve tabs. Every request is checked against Proxmox's API description (`apidoc.js`, the `pve-docs` API viewer); the paths, parameters and privileges below were verified against it.

## Users

The people on the device: real Proxmox users from every realm. The user dialog covers name, email, comment, expiry date, enabled, **groups**, device role (our preset on Proxmox ACLs), organization roles, and a read-out of sign-in security (two-factor kinds, API token count, realm-enforced two-factor).

Realm-aware: the **pve** realm keeps a password in Proxmox (create asks for one). **PAM** users are operating-system accounts: Proxmox stores only their permissions, so the dialog explains that the account and password live in the OS and no password is sent. **LDAP / AD / OpenID** users sign in with their directory or identity provider; no password is sent or shown. Proxmox has no SSH keys on users; its `keys` field is the legacy Yubico OTP key list, shown and editable as such.

Proxmox: `GET/POST /access/users`, `GET/PUT/DELETE /access/users/{userid}`, `PUT /access/password`, `GET /access/domains`.

## Groups

List, create, edit (comment, members) and delete. Members can be set from the group dialog and from each user's dialog. The group dialog shows its **effective permissions**: every permission given to the group, with the role's privileges. (Proxmox has no "effective permissions" call for groups, so this is the group's ACL entries expanded through the roles.)

Proxmox: `GET/POST /access/groups`, `GET/PUT/DELETE /access/groups/{groupid}`; membership is the user's `groups` (with `append` to add), `GET /access/acl`, `GET /access/roles`. Needs `Group.Allocate` on `/access/groups` (`User.Modify` for membership).

## Roles & permissions

Three views:

- **Permissions**: every ACL (path, user, group or API token, role, whether it applies below the path), with search and filters. Our **device roles** (Administrator, Operator, Viewer) and **organization roles** are presets made of ordinary ACLs; the ones they make are marked, and everything set by hand shows up too and is left alone. Add and remove permissions on any path; paths autocomplete from machines, storage, devices, networks (`/sdn/zones/…`) and resource groups.
- **Roles**: built-in and custom roles with their privileges, grouped (Machines, Storage, Device, People and access, Resource groups, Networking, Hardware mappings), each with a plain-language description. Built-in roles are read-only. Custom roles can be created, edited and deleted; deleting a role that permissions still use asks to remove those permissions too.
- **Check access**: the effective permissions of a user or API token on a path, as Proxmox computes them (groups, roles and inheritance included).

Proxmox: `GET/PUT /access/acl` (needs `Permissions.Modify` on the path), `GET/POST /access/roles`, `GET/PUT/DELETE /access/roles/{roleid}` (needs `Sys.Modify` on `/access`; Proxmox itself refuses its special roles), `GET /access/permissions?userid=&path=`, `GET /cluster/resources`, `GET /pools`.

## API tokens

Two kinds, one tab:

- **ePaperclip API tokens**: for automation against ePaperclip itself. Name, expiry (always finite, at most a year), read-only, privilege separation. Shown once; only a hash is kept. **Renew** gives the same token a new end date (also in Proxmox); **Rotate** also makes a new secret, shown once, and the old one stops at once. Tokens ending within a week are flagged. Only the owner or an administrator, in a browser session, can renew or rotate; a token can't extend itself. See [API.md](API.md) for the design and curl examples.
- **Proxmox API tokens**, per user: create (the secret is shown once, with an explanation of privilege separation), edit (comment, expiry, privilege separation), generate a new secret, delete, and edit the token's own permissions (ACL entries for `user@realm!name`). ePaperclip's own tokens appear in the list marked as such; deleting one there revokes it properly.

The host never stores or logs a Proxmox token secret (except the one sealed in the vault behind an ePaperclip API token). Names starting with `epc-` are reserved.

Proxmox: `GET /access/users/{userid}/token`, `POST/PUT/DELETE /access/users/{userid}/token/{tokenid}` (`regenerate`, `privsep`, `expire`, `comment`), `PUT /access/acl` with `tokens`.

## Two-factor

Per user: list entries, add an **authenticator app** (TOTP) or **recovery keys**, enable or disable, delete. Administrators with `User.Modify` or `Sys.Audit` can see and remove other people's entries and unlock a locked-out account.

- The authenticator secret is made **in the browser** (`crypto.getRandomValues`), the QR code is drawn there as inline SVG by a vendored MIT encoder (see [THIRD-PARTY.md](THIRD-PARTY.md)), and nothing goes to a QR service. The content policy stays `script-src 'self'; img-src 'self' data:`. The secret passes through the host to Proxmox once, with the current code, and is not stored or logged.
- Recovery keys are returned by Proxmox once and shown once.
- Proxmox asks for the performing user's password when changing their own entries; the form passes it through and never keeps it.
- **Security keys (WebAuthn)** can be added by their owner (a key needs its owner's browser), and removed by the owner or an administrator. A key is bound to the web address it is registered on, and Proxmox keeps one WebAuthn address for the whole datacenter, so the form first compares Proxmox's configured address with the page's address and explains a mismatch instead of making a key that would not work. An administrator can point Proxmox's WebAuthn address at ePaperclip in **Sign-in policy** (this is the "WebAuthn settings" screen; changing it may break keys registered on the old address, and the screen says so). The flow follows Proxmox's own pages: the host asks Proxmox for the registration options, the browser creates the key (`navigator.credentials.create`), and the answer goes back as base64url JSON. The challenge is Proxmox's, the host stores nothing.
- Sign-in: accounts that have an authenticator or recovery keys get the code step as before. A security key is answered at sign-in too: the host reads the second factors Proxmox's partial ticket offers and passes the key's options to the browser (`navigator.credentials.get`), and the answer is sent to Proxmox as `webauthn:<json>`. Accounts with only a legacy U2F key or a Yubico OTP get a clear message instead of an unanswerable prompt (the check fails open if the ticket can't be read).
- Proxmox does not allow API tokens to change two-factor settings, so token callers get 403 `ticket_only`.

Proxmox: `GET /access/tfa`, `GET/POST /access/tfa/{userid}` (`type=webauthn`: first call returns the options, second call sends `challenge` and `value`), `PUT/DELETE /access/tfa/{userid}/{id}`, `PUT /access/users/{userid}/unlock-tfa`, `GET /access/users/{userid}/tfa`.

## Realms

List with type, server and whether Proxmox **enforces two-factor** for the realm (`tfa`, for example `type=oath`). Add, edit and delete **LDAP**, **Active Directory** and **OpenID Connect** realms; edit **PAM** and **Proxmox** (default realm, two-factor enforcement, comment).

The forms are drawn from a schema built from Proxmox's `POST/PUT /access/domains` description: field names, limits, enums and defaults are Proxmox's, and the host validates the same rules before anything is sent. **Bind passwords and client secrets are write-only**: never returned, never prefilled, blank on edit means unchanged, and there is a checkbox to remove the stored one. They are not logged or audited.

- **Test the connection**: the form's "Check the connection before saving" sets Proxmox's `check-connection`, so Proxmox binds to the server first and refuses the change if it can't. A dry-run sync exercises the connection for an existing realm.
- **Sync** (LDAP and AD): scope (users, groups, both), enable new users, what to do with entries that vanished (`remove-vanished`: entry, properties, acl). It is a **dry run by default**; it starts a Proxmox task, the log is followed live, and a successful dry run offers "Run it for real".

Proxmox: `GET/POST /access/domains`, `GET/PUT/DELETE /access/domains/{realm}`, `POST /access/domains/{realm}/sync`, `GET /nodes/{node}/tasks/{upid}/status|log`. Needs `Realm.Allocate` (sync: `Realm.AllocateUser` and `User.Modify`).

### Scheduled syncs

Under the realm list: Proxmox's own **realm sync jobs** (`/cluster/jobs/realm-sync`). Add, edit, pause and delete a job: realm (LDAP or Active Directory), schedule (a systemd calendar event, with a preview of the next five runs from `/cluster/jobs/schedule-analyze`), scope, enable new users, and what to remove when entries vanish. Proxmox runs the jobs and keeps their logs; nothing runs in ePaperclip. Needs `Realm.AllocateUser` on the realm and `User.Modify` (creating or editing), `Sys.Modify` (deleting).

### OpenID Connect sign-in

The sign-in page offers **Sign in with &lt;realm&gt;** for every OpenID Connect realm. Flow (Proxmox's own): the host calls `POST /access/openid/auth-url` with this site's address as the redirect, the browser goes to the identity provider, comes back to this site's address with `?code=&state=`, and the host calls `POST /access/openid/login` and opens an ordinary session from the ticket Proxmox returns. The identity provider must allow this site's address (for example `https://epaperclip.example.org`) as a redirect URI. Protections: the attempt is bound to the browser that started it by a ten-minute `HttpOnly` cookie and used once (a code replayed or opened in another browser is refused), the `state` must be the one Proxmox issued, and failures count against the sign-in limiter. A user must already exist in Proxmox (or the realm must have auto-create enabled); roles then work as for anyone. Sessions opened this way say so in the sessions list.

## Your own account

**My security** tab, for everyone:

- **Change your password**: asks for the current one (Proxmox confirms it), needs 8 or more characters, signs your other sessions out and keeps this one. Wrong current passwords are limited to five per fifteen minutes. LDAP, Active Directory and OpenID accounts are told their password lives elsewhere. Proxmox: `PUT /access/password`.
- **Sessions**: every browser signed in as you (device, address, when it started, when it was last used, and whether by password or OpenID), with **Sign out** for each and **Sign out everywhere else**. Administrators can switch to everyone's sessions, end one, or end every session of one person (a lost laptop). Session ids are secrets and never listed; each row has a short handle for revoking. Ending a session also makes that person's ePaperclip API tokens re-check Proxmox at once.

## Effective permissions

A user or API token, as an explorer: the ACL entries that apply to them (their own, each group's, the token's own) and, per path, the privileges Proxmox computes with the role, path and source that grant each one. A privilege-separated token shows only its own entries. Proxmox: `GET /access/permissions?userid=` (no path lists every path), `GET /access/acl`, `GET /access/roles`, `GET /access/users/{userid}`.

## Reviewing a change before it is applied

Changing someone's device role or organization roles in the user dialog first shows **Review changes**: the permissions it will add and take away in Proxmox (path, role, how many privileges), the engine memberships that change, and side effects (administrator status of the engine, sessions that will end). Nothing is sent until **Apply changes**. The preview computes the same ACL changes the apply step makes, from the current ACLs. Templates, CSV import and group mapping show the same lists.

## People tools: import, templates, group mapping

**Import & templates** tab (administrators and anyone with `User.Modify`):

- **CSV import**: paste or choose a file (up to 500 people, 256 KiB). Columns `username` (or `name@realm`; bare names use the default realm), `password`, `firstname`, `lastname`, `email`, `comment`, `groups` (`;` separated), `enable`, `expire` (`2027-06-30`), `devicerole`, `orgs` (`Name:role; Name:role`), `template`. **Preview** shows every row (create, leave, update, error), the access it gives and the Proxmox changes it will make; nothing is created while any row has an error. **Import** creates each Proxmox user and, together, their engine account, groups, device role and organization roles, one at a time, reporting each person's result. Existing people are left alone or updated, as chosen. Optionally missing groups are created, and a password is generated for pve-realm people without one: those passwords are shown once and are not stored, logged or audited. Passwords for non-pve realms are never sent.
- **Templates**: named bundles (device role, groups, organization roles; an organization of `*` means every organization). **Apply** to chosen people after a preview; it adds the template's access and takes nothing away. Stored in the host's state; administrators manage them.
- **Group mapping**: "members of group G get role R in organization O". **Preview a sync** then **Apply**: people in a mapped group are added or raised, and a role that mapping gave is taken back when they leave the group. Roles given by hand, or higher than the mapping's, are never lowered or removed (the host records only what mapping granted). Works with directory groups: run the realm sync (or its schedule), then sync the mapping.

## Audit log

Sign-ins (and how), changes to users, groups, roles, permissions, realms, templates, imports, sessions, sign-in policy and API tokens, and failed token use. Filter by person, action, text and dates; **CSV** and **JSON** export what the filter shows (spreadsheet formulas are neutralised). Administrators only. The last 2000 entries are kept in the host's state. Secrets and generated passwords never appear.

## Sign-in policy

Administrators: the **login notice** (Proxmox's `consent-text`, shown on the sign-in page before sign-in with an "I have read this notice" box; the host keeps a copy so the page can show it before anyone has signed in, refreshed whenever an administrator saves or opens this tab), **WebAuthn** (`rp`, `id`, `origin`, `allow-subdomains`; one click fills this page's address) and **U2F** (`appid`, `origin`). Proxmox: `GET/PUT /cluster/options`. Needs `Sys.Modify` on `/`.

## Routine webhooks from outside

A routine's webhook address is the engine's loopback URL. For GitHub or a build server to call it, an administrator opens the organization in **Sign-in policy > Routine webhooks from outside**; each routine's public address (`/hooks/routines/<id>/fire`) is then listed with its signing mode, and unsigned triggers are flagged. Off by default; see [SECURITY.md](SECURITY.md) for exactly what the door accepts and the risk.

## Resource groups (Proxmox pools)

List with members, create, edit the comment, add and remove machines and storage, delete. Pools named `epc-*` belong to organizations: they are marked, and a pool mapped to an organization (state setting `resourceGroups`) cannot be deleted from here (409 `organization_pool`); unmapped leftovers can. Proxmox only deletes empty pools.

Proxmox: `GET/POST/PUT/DELETE /pools` (nested-pool-aware calls with `poolid`; members add or remove with `vms`, `storage`, `delete`), `GET /cluster/resources`. Needs `Pool.Allocate`.

## Audit trail

See **Audit log** above. `GET /api/access/audit` takes `actor`, `action`, `q`, `from`, `to`, `limit`, `offset`; `GET /api/access/audit/export?format=csv|json` takes the same filters.

## Routes of the host service

All under `/api/access/…`; the list is in [API.md](API.md). Source: `services/epaperclip/src/features/access.ts` (Proxmox access control), `access-admin.ts` (own password, sessions, audit, sign-in policy, security keys, explorer, sync jobs), `access-people.ts` (preview, templates, import, group mapping, webhook switch), `routine-ingress.ts` (the webhook door), `access-tokens.ts` (Bearer tokens), `access-realms.ts` (realm schema), `access-privs.ts` (privileges); the console: `apps/console/src/pages/access/`.
