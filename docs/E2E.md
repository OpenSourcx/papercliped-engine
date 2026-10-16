# End-to-end proof against the real engine

No real Proxmox was reachable while building v1, so the strongest proof available is this harness: the **real pinned
Paperclip engine** (`paperclipai 2026.1005.0`, run as `nobody`), the **real host service** and the **built console**,
against a fake Proxmox, driven by Playwright. It takes about 1.5 minutes.

Run it: `node --experimental-strip-types services/epaperclip/scripts/e2e-real-engine.mts`
(env: `EPC_E2E_SHOTS`, `EPC_E2E_ONLY`, `EPC_E2E_HOLD`, `EPC_E2E_KEEP`; screenshots are not committed).
Files: `services/epaperclip/scripts/e2e-real-engine.mts` (harness), `e2e-stages.mts` (stages),
`services/epaperclip/test/fakes-e2e.ts` (one router over the area fakes, plus a scripted model provider).

## What it proves (last full run on the merged completion push: 40 passed, 0 failed)

Sign-in for an admin and a non-admin; organization creation (engine UUID, `epc-<name>` pool, creator is pool admin,
non-members refused); access control moving Proxmox ACLs and engine memberships together, sessions ending on removal;
agents and tasks, with agents **failing closed** when no sandbox exists; inbox, decisions, routines, chat on/off, costs
with a real budget incident, search, task detail over the live socket; Pin (key never sent back, a chat turn, a plan
approved step by step including a real engine task and a typed-confirmation power step); an automation firing on
schedule once per day; the machine wizard at device and organization level; device, disk, node, datacenter, cluster,
HA, replication and Ceph pages; Bearer API tokens (read-only cannot write, none can approve a plan or mint a token,
revocation works); strict CSP, cookie flags, CSRF and Origin checks; the proxy refusing to switch the managed-sandbox
policy off; sign-out and idle session expiry; no sideways scrolling at 390px on 28 pages and three modals.

## Bugs found and fixed (each has a test)

1. New agents defaulted to an adapter that can never run in a container; the console now asks the engine which
   adapters are sandbox-capable.
2. With "Approve new agents" on, New agent showed a raw engine error; it now follows the engine to the hire route.
3. The agent containers banner sat under Pin's island.
4. Pin's Activity tab showed invented demo lines on a live device.
5. Pin's overview said "No connectors yet" while one was connected.
6. Members, settings and name lookups showed the engine's internal managed-account address.
7. Decisions showed "hire agent" without a name.

## Open

- (Fixed) The "reject and request a revision" stage clicked a card that had not yet left the list; it now waits for the list to settle. The console was right.
- (Fixed) After a chat message to an agent that cannot run, the thread showed "Runner is writing" indefinitely; it now says why, links to Agent containers or the agent, and offers Try again (stage "chat: an agent that cannot run says why").
- The Inbox badge counts 1 where "Needs you" lists 3 (the engine's own counts differ). Cosmetic.
- (Fixed) The Access settings tab strip clipped "Resource groups" at 1440px; it now wraps (stage "access: the settings tab strip shows every tab").
- A fresh admin who creates an organization within about a second of signing in can get "Instance admin required",
  because promotion runs in the background.

## Decisions

- A routine's webhook address is the engine's loopback URL, unreachable from outside the device. Built: an ingress that is
  off by default and opened per organization by an administrator (`POST /hooks/routines/<id>/fire` only, 64 KiB, rate
  limited); the harness proves the real engine accepts a forwarded call (stage "routine webhooks from outside"). The risk is
  written up in SECURITY.md.
- The `/engine/api` proxy is an allow-list of the routes the console uses; the harness passes through it end to end
  (it adds one test-only route, cost events, which an agent would report directly to the engine).
- The engine's artifact list only holds agent-produced files; a file a person attaches to a task is not listed.

## Still unproven

Everything that depends on a real Proxmox: access-control, containers and template build, disks, cluster, the update
helper on real systemd, and Pin against a real model provider.

## After the completion push

The merged branch first ran 32 passed, 6 failed. Four Pin/automation stages failed only because the stages looked for
old wording ("The key works.", the first "Set key" button, which now belongs to another provider in a longer list);
the product was fine and the stages now target the Anthropic row and the new "Works. N models available" text. One
failure was a real console bug: on a phone the machine page's Cluster section pushed its two buttons 47px wide
(fixed by letting them wrap). One was the stage race above.
