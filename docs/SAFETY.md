# Safety: the kill switch and vault key recovery

Two emergency controls, in **Settings → Safety**. Only Proxmox administrators (Sys.Modify on `/`) can use them, with the Proxmox sign-in and the console's own header, never an API token. Every use is written to the access audit log.

## Kill switch

Use it when something is wrong and you need agent work to stop now.

What it does, in this order:
1. **Pauses agents** in every organization the signed-in administrator can reach (engine `POST /api/agents/{id}/pause`). Organizations the administrator is not a member of are counted and reported, not hidden.
2. **Stops every running guest that ePaperclip manages**: a container or VM tagged `epaperclip`, or in a pool whose name starts with `epc-`. A hard stop, not a tidy shutdown. Templates, stopped guests and anything else on the host are never touched.

It deletes nothing. The switch is recorded first, so if the host service dies halfway it still shows as on, and pressing it again finishes the job. Failures are listed one per line and do not stop the rest.

**Clearing it** (`POST /api/safety/resume`) restarts nothing. It can optionally resume exactly the agents the switch paused. Start containers again yourself, or let agents start new ones when they run.

The confirmation phrase is `STOP EVERYTHING`.

| Route | |
| --- | --- |
| `GET /api/safety` | whether the switch is on (anyone signed in), and what it did (administrators) |
| `POST /api/safety/kill-switch` | `{ confirm: "STOP EVERYTHING" }` |
| `POST /api/safety/resume` | `{ unpauseAgents?: boolean }` |

Not in this version: refusing new work while the switch is on. Agents are paused, so nothing new runs through the engine; Pin and new organization setup are not blocked by it.

## Vault key recovery

Every secret the host keeps (engine passwords, connector keys, vault variables) is sealed with one key in `vault.key`. Lose that file and the secrets are gone. A recovery file keeps a copy of the key, locked with a passphrase you choose (scrypt, then AES-256-GCM), so it can live somewhere other than this device.

- **Download**: a passphrase of at least 12 characters, typed twice. The file never contains the key in the clear, and the passphrase is never stored. There is no way to recover a forgotten passphrase.
- **Restore**: the file and its passphrase, plus the confirmation phrase `RESTORE VAULT KEY`. The key must open the file, and it must match at least one value already sealed on the host (so a file from another host can't replace a good key). The key it replaces is kept as `vault.key.replaced-<time>` so a mistaken restore can be undone by hand. The running service keeps its old key until you restart it: `systemctl restart epaperclip`.

| Route | |
| --- | --- |
| `POST /api/vault/recovery/export` | `{ passphrase }` returns the file as a download |
| `POST /api/vault/recovery/restore` | `{ file, passphrase, confirm: "RESTORE VAULT KEY" }` |

Not in V1: unlocking the vault with a passphrase at start-up.
