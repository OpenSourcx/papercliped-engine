# ePaperclip 1.0.0: PinView and Collaborate

Status: planned, not built. This file is the plan written in plan mode, kept here so it is part of the repo. PinView is the Claude-style workspace for Pin and agents; Collaborate is the local chat for people, Pin and agents. See also [PLAN-PAPERCLIP-PARITY.md](PLAN-PAPERCLIP-PARITY.md).

## Context

ePaperclip today has Pin as a small island plus a Pin page, agent chat buried inside each organization, and no place where people on a host talk to each other. 1.0.0 is the launch release and adds two things:

- **PinView**: a Claude-app-style full-screen workspace, the one place for every conversation on the system (Pin chats, organization agent chats, Collaborate rooms), searchable, filterable, sorted by recency and source. It is how you do deep AI sessions; the Proxmox homelab console stays as it is.
- **Collaborate**: a local, Discord/Slack-style chat that lives on the Proxmox host. Up to 50 customizable rooms; people, Pin and agents from every organization take part. It is the mobile landing screen. First release is the fundamentals: usability, access control, management, security, integration, communication. Not social features.

Daily bug checks continue in parallel (Phase 0). Nothing here is built until the plan is approved.

## Decisions already made

- **Membership**: Proxmox users and groups from this host's realms; room roles (owner, moderator, member, read-only) live in ePaperclip. Plus **invites**: a link that gives a person access to Collaborate only.
- **Agents**: address and reply. `@agent` from any organization in a room; the reply appears in the room. Pin joins the same way. Agents only post in rooms where an administrator added them.
- **In 1.0.0 beyond messages, rooms, roles, security**: phone notifications (web push), file and image attachments, threads and reactions, search across all conversations.

## What the research found (shapes the design)

- **No chat infrastructure exists to extend.** There is one SSE producer (`Pin.chat` in `services/epaperclip/src/pin.ts`), one WebSocket upgrade point (`createApp().upgrade` in `src/app.ts`, auth via `socketPrecheck`: same-origin plus session cookie, API tokens refused), no fan-out hub, no connection caps, no backpressure handling.
- **Storage**: `StateStore` (`src/state.ts`) rewrites the whole JSON file on every write. Fine for settings, wrong for message history. There is no database in the host service. Node is pinned to 24.21.0 by the installer, so `node:sqlite` is available; the systemd unit allows writing `/var/lib/epaperclip` (`MemoryMax=512M` is the budget).
- **Paperclip has no rooms.** Its "chat channels" are an external-provider bridge (Slack, Discord, Telegram...), one assigned agent each. Its native agent chat is an issue with `conversationAgentId`, owner-only posting, experimental. Everything is company-scoped: agent keys and the live-events WebSocket cannot cross companies.
- **Agents are addressed through issue comments**: a comment containing `[Name](agent://<agentId>)` wakes that agent (`issue-comment-wakeup`); agents reply with `POST /issues/:id/comments`. Per company, `GET /api/companies/:id/events/ws` emits `activity.logged` (`issue.comment_added`, no body) and comments are fetched with `?after=<id>&order=asc`.
- **Console**: `PinThread`, `PinInput`, `Markdown`, `ToolCard`, `PinOrb`, `Modal`, `SettingsModal`, the `Feature` registry (`src/features/registry.ts`) and `--z-fullscreen` already exist. `PinContext` holds one live thread and a Pin-only message type (`from: "you"|"pin"`), so it needs a multi-thread, multi-author refactor. The rail is hand-written in `AppShell.tsx` `Rail()`. No `env(safe-area-inset-*)` anywhere, no service worker.

## Phase 0: bugs and gaps from daily testing (ship as rc patches, before and alongside)

1. **Island and quick actions**: confirm on the host that rc12 fixes "New automation" (opens `?modal=new-automation`). Audit every Pin-proposed action card and quick action for anything that still posts canned chat text instead of opening its modal (`pin/suggestions.ts`, `pages/pin/PinPage.tsx`, `pin/tools.ts`). Add the same describe-it-or-fill-the-form modal pattern for "new task".
2. **Pin cannot create an automation from chat** ("I couldn't save this as a standing rule"): add a `create_automation` tool that validates through the existing automation validator (`features/pin-automations.ts`, `@papercliped-engine/automations`) and shows a read-back card the person approves.
3. **Spurious red "Didn't remember" chip** when the model calls `remember` unprompted: refuse silently (no chip), keep the gate in `pin.ts`.
4. **VM creation tool gaps** seen in the transcript: `create_vm` and `create_container` need an optional `vmid`; `set_machine_config` or a new `attach_iso` must attach a CD/DVD and set boot order on an existing VM.
5. **Wrong claims after a failed action**: after any failed act call, Pin must re-read state before claiming one (tool result carries Proxmox's real error and the task log line). Investigate the failed start of VM 102 using `/api/activity` on rc12.
6. **Stalled model**: with the activity log live, collect which models stall on tool chains and add a "model test with a tool" probe (`/api/pin/settings/test`) so bad models are flagged when chosen.

## Phase 1: foundations

- **Collaborate store** (`services/epaperclip/src/collab/db.ts`): SQLite via `node:sqlite`, WAL, file `collab.db` (0600) in the state dir, versioned migrations in code, tables: `rooms`, `room_members`, `messages` (per-room monotonically increasing `seq`, `thread_root`, `author_kind` user|guest|pin|agent, `author_id`, `body`, `edited_at`, `deleted_at`), `reactions`, `attachments`, `reads`, `invites`, `guests`, `push_subscriptions`, `agent_links`, `audit`. Spike first: confirm FTS5 is compiled into Node's SQLite; if not, use indexed prefix search.
- **Realtime hub** (`src/collab/hub.ts`): in-process fan-out keyed by room. WebSocket at `/api/collab/ws` added to the existing `upgrade` path with the same origin and session checks; per-user connection cap, ping/pong with idle timeout, `bufferedAmount` backpressure (drop slow client, it resumes), 64 KiB frame cap. Clients resume with `after=<seq>` per room so mobile reconnects lose nothing. REST handles history and sends; the socket is for push only.
- **Identity**: a `Principal` for Collaborate that is one of: Proxmox user (existing session), guest (invite). Rooms resolve membership from Proxmox groups at request time (cached briefly, invalidated by `SessionStore.epoch`) so removing someone from a group removes access.

## Phase 2: Collaborate server (`src/collab/*`, feature `collab` in `features/index.ts`)

- **Rooms**: create, rename, topic, archive; hard cap 50 (enforced server side); room kinds: standard, announcements (read-only for members), private. Customization: name, topic, icon/colour from tokens, order, default notification level.
- **Roles and ACL**: owner, moderator, member, read-only, per room, granted to a Proxmox user, a Proxmox group, or a guest. Instance administrators (`isNodeAdmin`) can manage every room and the 50-room budget. One function `can(principal, room, action)` is the only authorization path; every route and every socket subscription calls it.
- **Messages**: send, edit (own, keep history), delete (own or moderator, tombstone), reply threads, reactions, mentions (`@user`, `@group`, `@agent`, `@pin`, `@room`), unread counts and read markers, markdown via the existing `Markdown` renderer (HTML never accepted).
- **Attachments**: upload to `/var/lib/epaperclip/collab/files/<random>` with size cap, content-type sniffing and an allowlist, served only through an authorized route with `Content-Disposition` and `nosniff`; images get a server-generated downscaled preview (no third-party service). Quota per room.
- **Search**: `GET /api/collab/search` and the PinView search combine Collaborate FTS with Pin chats (sealed docs, searched server side per user) and organization chat titles/comment text through the engine. Results are always filtered by `can()`.
- **Invites (Collaborate only)**: an owner or administrator creates a link (expiry, max uses, room set, role). Redeeming creates a **guest account native to ePaperclip** (passphrase hashed with scrypt, rate limited), not a Proxmox user: creating Proxmox users would need `User.Modify` on `/access`, which can also rewrite administrator accounts, so we do not hold that. Guest sessions reuse `SessionStore` with `kind: "guest"` and are accepted only by `/api/collab/*`; every other route keeps requiring a Proxmox ticket. Revoke, list and expire guests in the Collaborate admin UI. Audit every invite event with `appendAudit`.
- **Audit and retention**: per-room optional retention (days), message audit for moderation actions, export for administrators.

## Phase 3: agents and Pin in rooms

- **Link an agent to a room** (administrator): pick organization and agent. The host service keeps one **mirror issue** per (room, organization) named "Collaborate: #room" (Paperclip route `POST /companies/:id/issues`).
- **Room → agent**: a message mentioning the agent is posted as a comment on that mirror issue by the service account, body prefixed with who asked and in which room, containing `[Agent](agent://id)` so Paperclip's own wake logic fires, with `clientRequestId` for idempotency.
- **Agent → room**: one `events/ws` connection per linked company (service account, instance admin); on `issue.comment_added` for a mirror issue fetch `comments?after=<cursor>&order=asc`, store the cursor, post agent-authored comments into the room with the agent's name and organization. Polling fallback with the same cursor when the socket is down. Reuses `EngineGateway` (`src/engine.ts`: `userCall`, `accountJson`, `relayEvents`).
- **Pin in rooms**: `@pin` runs a Pin turn (`Pin.chat` machinery) with the room's recent messages as context. In rooms Pin is read-only/propose-only whatever the invoker's mode is: proposals and approval cards show only to the person who asked, never to the room; Pin's tools still run as that person's Proxmox ticket. Pin's answers are posted to the room.
- **Limits**: per-room agent rate limits and a mention loop breaker (an agent cannot trigger an agent that triggers it back inside N seconds), visible "agent is working" state, administrator kill switch per link.

## Phase 4: web push and mobile

- **Service worker** (`apps/console/public/sw.js`, same-origin script so the CSP `script-src 'self'` holds) for push display and offline shell; `manifest` gains `shortcuts` and per-route start URL (`/<device>/collaborate`).
- **Web Push**: VAPID keypair generated once and sealed in the vault; subscription endpoints in `collab/push.ts`; payload is encrypted per RFC 8291 and carries only room name, author and a short preview unless the person turned previews off. Prefer the `web-push` package if bundling it is clean; otherwise implement RFC 8291 and the VAPID JWT with `node:crypto`.
- **Hard prerequisite**: browsers refuse service workers and push on an untrusted certificate. The default install has a self-signed certificate, so push needs the host on a real domain with a trusted certificate (Proxmox ACME, which `features/nodeCerts.ts` already manages). The Collaborate settings page detects this, explains it, and hides push until it holds; everything else works without it.
- **Mobile layout**: Collaborate is the mobile landing (`start_url`). One pane at a time (room list → room → thread), back gestures, sticky composer using `dvh` and a new `--safe-bottom` token from `env(safe-area-inset-bottom)`, 44px targets, bottom tab bar (Rooms, Mentions, PinView, You). Desktop: three columns (rooms, room, thread/details).

## Phase 5: console, PinView and Collaborate UI (`apps/console/src`)

- **Refactor first**: extract `useThread(source)` and a source-agnostic message model (`author`, `kind`, `blocks`) from `pin/PinContext.tsx`; keep the island working through an adapter so it stays one live Pin thread. Replace `ChatList` with a generic `ConversationList`.
- **PinView** (`pages/pinview/`, route `/:device/view`, rail icon, `--z-fullscreen` capable): left column = New chat, Search, filters (source Pin / organization / agent / room, organization, pinned, unread), recents grouped by day; centre = thread using `PinThread`/`PinInput`/`Markdown`/`ToolCard`; right drawer = details (model, permission mode, tools used, linked org/agent). Data: Pin chats from `pinLibrary`, organization agent chats from `useChats(companyId)` per `data.orgs[]` (same fan-out as `useInboxCounts`), rooms from the Collaborate API. Opening an organization chat there and in the org's own Chat page is the same thread component.
- **Collaborate** (`pages/collaborate/`, route `/:device/collaborate`, rail icon, feature entry): room list with unread badges, room view, thread panel, composer (mentions autocomplete, attachments, emoji, markdown), room settings modal (members, roles, agents, notifications, retention), invite modal, admin overview. All creation flows are modals through `ModalHost` (`?modal=new-room`, `?modal=invite`), following the new DESIGN.md rules; dropdowns use `Select`.
- **Design**: add a "Conversations" section to `apps/console/DESIGN.md` (message anatomy, author badges for user/guest/Pin/agent, unread, mention, thread, reaction, attachment, empty and offline states, mobile pane rules) and extend the status vocabulary; no new colours outside tokens, `check:design` must stay clean.
- **Demo mode**: both areas render in demo with canned rooms so the website and tests work without a host.

## Security model (checked at design time, tested in Phase 6)

- One authorization function (`can`), deny by default, used by REST and the socket subscribe path; tests enumerate every route against every role.
- Guests: separate principal kind, allowlisted to `/api/collab/*`, scrypt hashes, invite tokens 256-bit and stored hashed, rate limits on redeem and login, revocation kills sessions and sockets immediately.
- All state-changing REST needs `X-EPC-Request` and same-origin; sockets reuse the same-origin check; no API tokens on sockets (existing rule), a separate scoped "Collaborate bot token" only if integrations are added later (out of scope).
- Input: markdown rendered by our renderer only, links through the existing `safeUrl`, attachments type-sniffed and served with `nosniff` and download disposition, filenames never trusted, per-room and per-user quotas, message size cap, flood limits per principal.
- Agents: mention-loop breaker, per-link rate limit, mirror issues clearly labelled, agents see only the room messages addressed to them, never other rooms.
- Privacy: message bodies are plaintext inside `collab.db` (needed for search) protected by 0600 and the host's disk; the plan states this plainly in docs/SECURITY.md. Pin chats and vault values keep their sealed storage. Push previews are optional.
- Audit via `appendAudit`; activity log events for realtime health (`collab.ws.*`) with no message content.

## Phase 6: tests, docs, release

- **Server tests** (vitest, patterns from `test/access-harness.ts`, `test/pin.test.ts`, `test/vault.test.ts`): store and migrations; ACL matrix; hub fan-out, resume, backpressure; invites and guest lifecycle; attachments; search permissions; agent bridge against `fakeEngine` extended with comments, `events/ws` and mention wake; push encryption against RFC 8291 test vectors; rate limits.
- **Console tests**: ConversationList filters/sorting, thread refactor does not break the island, room and invite modals, mobile pane state.
- **Docs**: `docs/COLLABORATE.md` (model, roles, invites, agents, push prerequisites), `docs/PINVIEW.md`, updates to `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/PIN.md`, and user docs.
- **Release**: land behind a "Collaborate" switch (administrator turns it on, default on for new installs) across release candidates; 1.0.0 only after a full dogfood week on the Proxmox host and the Windows tester run, with the conformance, design and test gates green.

## Suggested order and sizes

1. Phase 0 (small, continuous). 2. Phase 1 spikes (SQLite FTS5, `node:sqlite` bundling, WebSocket hub) then foundations. 3. Phase 2 + the Phase 5 refactor in parallel (server and UI split cleanly). 4. Phase 5 UI for PinView and Collaborate. 5. Phase 3 agents and Pin. 6. Phase 4 push and mobile polish. 7. Phase 6 hardening and docs. Each step ships as a release candidate with its own tests; nothing lands half-wired.

## Verification

- `pnpm typecheck && pnpm test` plus `node scripts/check-pve-api.mjs`, `pnpm --filter @papercliped-engine/console check:design`.
- Real-browser checks (Chromium via Playwright, desktop and a 390px phone viewport) for: room list/room/thread flows, reconnect and resume after killing the socket, attachments, invites end to end as a guest, scrollbars and dropdown rules.
- Against a real engine in the installer test (`deploy/test/run.sh`): create a room, link an agent, send an `@agent` message, see the reply appear.
- Manual on the Proxmox host: two users plus a guest on desktop and phone, push notification on a trusted-certificate host, Pin in a room, 50-room cap, removing a user from a Proxmox group removes access.

## Out of scope for 1.0.0

Voice and video, federation between hosts, end-to-end encryption, custom emoji and stickers, bots/webhook integrations for outside services, social presence features (status messages, activity feeds), a native mobile app.

## Open risks

- `node:sqlite` is experimental in Node 24 (warning on load); pin the version in the installer (already pinned) and wrap access in one module.
- Paperclip's `plugin-sdk` was not inspected; if the comment-polling bridge proves too slow, a plugin that pushes `issue.comment.created` is the fallback.
- A guest account system is new authentication surface; keep it minimal and review before launch.
- Web push depends on the user having a trusted certificate; the product must stay fully usable without it.

## Status: PinView first cut (built)

`/<device>/view`, a rail icon, full screen with a way back. One conversation list (`pin/ConversationList.tsx`) holds Pin's chats and each organization's agent chats: search, filter (All, Pin, Agents), grouped by day, rename and delete where the owner allows it. The thread, cards and composer are the same components everywhere (`pin/ThreadContext.tsx` lets any conversation provide its messages), so an agent chat is drawn exactly like Pin's. A details panel shows the model and permission mode for Pin, or the organization and status for an agent. On a phone the list and the thread are separate panes. Collaborate rooms join the list later. A **Files** panel beside the thread lists the files and documents an organization's agents produced (search, open in place: text and code in a monospace view, images, downloads for the rest) using the engine's artifacts and the same safe preview as the Artifacts page; on a phone the Files and Details panels open as a full sheet. Not built: unread markers, pinning, filter by organization, browsing a machine's or workspace's file tree, editing a file from PinView (the engine has no workspace file routes, so that goes through the agent or Pin).
