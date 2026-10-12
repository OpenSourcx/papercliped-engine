# Access control

ePaperclip replaces Proxmox's web interface, and its philosophy is **Integrated Access Control**: every change made here is made in Proxmox first, as the signed-in person, and Proxmox decides whether it is allowed. The engine then follows. Nothing here is a second user database. If Proxmox refuses, the screen shows its reason ("Proxmox refused: Permission check failed (/access/groups, Group.Allocate)"), and a person without the right sees the same screens read-only.

The Access area is **Access control** in the sidebar (and in Settings). It has seven tabs. Every request is checked against Proxmox's API description (`apidoc.js`, the `pve-docs` API viewer); the paths, parameters and privileges below were verified against it.

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

- **ePaperclip API tokens**: for automation against ePaperclip itself. Name, expiry, read-only, privilege separation. Shown once; only a hash is kept. See [API.md](API.md) for the design and curl examples.
- **Proxmox API tokens**, per user: create (the secret is shown once, with an explanation of privilege separation), edit (comment, expiry, privilege separation), generate a new secret, delete, and edit the token's own permissions (ACL entries for `user@realm!name`). ePaperclip's own tokens appear in the list marked as such; deleting one there revokes it properly.

The host never stores or logs a Proxmox token secret (except the one sealed in the vault behind an ePaperclip API token). Names starting with `epc-` are reserved.

Proxmox: `GET /access/users/{userid}/token`, `POST/PUT/DELETE /access/users/{userid}/token/{tokenid}` (`regenerate`, `privsep`, `expire`, `comment`), `PUT /access/acl` with `tokens`.

## Two-factor

Per user: list entries, add an **authenticator app** (TOTP) or **recovery keys**, enable or disable, delete. Administrators with `User.Modify` or `Sys.Audit` can see and remove other people's entries and unlock a locked-out account.

- The authenticator secret is made **in the browser** (`crypto.getRandomValues`), the QR code is drawn there as inline SVG by a vendored MIT encoder (see [THIRD-PARTY.md](THIRD-PARTY.md)), and nothing goes to a QR service. The content policy stays `script-src 'self'; img-src 'self' data:`. The secret passes through the host to Proxmox once, with the current code, and is not stored or logged.
- Recovery keys are returned by Proxmox once and shown once.
- Proxmox asks for the performing user's password when changing their own entries; the form passes it through and never keeps it.
- **Security keys (WebAuthn)** are listed and can be removed, but not added here. A key is bound to the web address it is registered on, and Proxmox's configured origin is its own address, so registering from ePaperclip would fail or produce keys that don't work on Proxmox. This is deliberate, and worth revisiting if Proxmox's WebAuthn origin is ever set to ePaperclip's address.
- Sign-in: accounts that have an authenticator or recovery keys get the code step as before. An account whose only second factor is a security key gets a clear message instead of an unanswerable code prompt (the check reads Proxmox's partial ticket and fails open if it can't).
- Proxmox does not allow API tokens to change two-factor settings, so token callers get 403 `ticket_only`.

Proxmox: `GET /access/tfa`, `GET/POST /access/tfa/{userid}`, `PUT/DELETE /access/tfa/{userid}/{id}`, `PUT /access/users/{userid}/unlock-tfa`, `GET /access/users/{userid}/tfa`.

## Realms

List with type, server and whether Proxmox **enforces two-factor** for the realm (`tfa`, for example `type=oath`). Add, edit and delete **LDAP**, **Active Directory** and **OpenID Connect** realms; edit **PAM** and **Proxmox** (default realm, two-factor enforcement, comment).

The forms are drawn from a schema built from Proxmox's `POST/PUT /access/domains` description: field names, limits, enums and defaults are Proxmox's, and the host validates the same rules before anything is sent. **Bind passwords and client secrets are write-only**: never returned, never prefilled, blank on edit means unchanged, and there is a checkbox to remove the stored one. They are not logged or audited.

- **Test the connection**: the form's "Check the connection before saving" sets Proxmox's `check-connection`, so Proxmox binds to the server first and refuses the change if it can't. A dry-run sync exercises the connection for an existing realm.
- **Sync** (LDAP and AD): scope (users, groups, both), enable new users, what to do with entries that vanished (`remove-vanished`: entry, properties, acl). It is a **dry run by default**; it starts a Proxmox task, the log is followed live, and a successful dry run offers "Run it for real".

Proxmox: `GET/POST /access/domains`, `GET/PUT/DELETE /access/domains/{realm}`, `POST /access/domains/{realm}/sync`, `GET /nodes/{node}/tasks/{upid}/status|log`. Needs `Realm.Allocate` (sync: `Realm.AllocateUser` and `User.Modify`).

## Resource groups (Proxmox pools)

List with members, create, edit the comment, add and remove machines and storage, delete. Pools named `epc-*` belong to organizations: they are marked, and a pool mapped to an organization (state setting `resourceGroups`) cannot be deleted from here (409 `organization_pool`); unmapped leftovers can. Proxmox only deletes empty pools.

Proxmox: `GET/POST/PUT/DELETE /pools` (nested-pool-aware calls with `poolid`; members add or remove with `vms`, `storage`, `delete`), `GET /cluster/resources`. Needs `Pool.Allocate`.

## Audit trail

`GET /api/access/audit` (Proxmox administrators) shows the last 500 entries of the `audit` setting: who changed what in access control, and ePaperclip API token creation, revocation and failed use. Secrets never appear in it.

## Routes of the host service

All under `/api/access/…`; the list is in [API.md](API.md). Source: `services/epaperclip/src/features/access.ts` (Proxmox access control), `access-tokens.ts` (Bearer tokens), `access-realms.ts` (realm schema), `access-privs.ts` (privileges); the console: `apps/console/src/pages/access/`.
