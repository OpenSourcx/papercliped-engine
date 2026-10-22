# Updates

How an ePaperclip device learns about updates, installs them, and what it keeps a record of. The console page is Settings → Updates (and Pin's Updates tab); everything below is also what that page changes.

## Two kinds of update

| | ePaperclip | Proxmox VE packages |
| --- | --- | --- |
| Who installs | the device, through a small root-owned helper (`epaperclip-update`), after an administrator approves or inside a maintenance window | the administrator, in a shell the console opens, after a backup warning |
| Automatic | optional, off by default, only inside the window you set | never. Proxmox has no upgrade API, and an unattended `dist-upgrade` on a hypervisor can restart services under running machines |
| Rollback | yes: "Go back to the previous version" (the installer keeps the last version and the engine's database from before) | no. apt has no undo; take a backup or snapshot first. Older kernels stay installed so one can be chosen at boot |
| Restart | ePaperclip restarts for a minute or two by itself | a new kernel needs a reboot; the device says so and reminds you. The notice has a **Restart now…** button: it lists what is running, asks you to type the device name, then reboots |

## Where updates come from

Releases are published by the project's CI: a GitHub release (tarball, signed manifest, `get.sh`, `.deb`) and, for final releases, the signed APT repository.

CI also publishes the **update feed**, `updates/feed.json` plus `updates/feed.sig` on the project's Pages site. It lists every release with its channel and notes, and which releases were withdrawn. It is signed with the same Ed25519 release key every installation pins, so a device checks it against the key installed with its own version (never anything downloaded). If the feed is unreachable, or its signature doesn't verify, the device uses GitHub's release list instead and says so. Either way, the update helper checks the release's own signature, checksum and version before installing anything, and refuses one older than what is running.

Set `EPC_UPDATE_FEED` to point devices at your own mirror of GitHub's release list (an internal mirror for air-gapped fleets); the format is GitHub's `releases` answer.

## Channels

- **Final releases** (default): `1.0.0`, `1.0.1`. Tested for everyday use.
- **Release candidates**: `1.0.0-rc12`. Sooner, with rough edges. A device on a release candidate follows them until switched back; one on a final release is only offered one after the person opts in ("Get updates as soon as they're available").

"No final release yet" while only candidates exist is shown as a fact, not as an error.

## What the device does on its own

- Checks the feed every few hours (a device sends nothing about itself).
- **Reminds** administrators who have opened Updates, once a day, in Pin's inbox. Snooze a day, three days or a week; pause everything up to five weeks. Restart reminders (a new kernel is installed but not running) ignore pause and honour snooze.
- Optionally **installs in a maintenance window** (a day or every day, a start time and 1 to 6 hours, on the device's clock). Only ePaperclip, only when the helper exists, never while paused, never an older version. A scheduled update that fails is **not tried again by itself**: you are told, and you decide.
- Keeps **history**: what was installed, by whom (an administrator, the maintenance window, or the host's shell), and how it ended; plus Debian's apt history for the package side. Settings → Updates → Update history.

## Withdrawing a release

If a release turns out to be bad, add its version to `deploy/withdrawn-releases.txt` with a reason (`1.0.0-rc3 # the engine didn't restart`) and push a release: the next feed marks it withdrawn, devices stop offering it, and any device running it is warned (a critical notice and a banner) to move on. See [RELEASING.md](RELEASING.md).

## API

All need a Proxmox administrator (signed in, or an API token that acts as one; changes need the console's request header).

| Route | |
| --- | --- |
| `GET /api/pin/update` | installed, latest on the channel, state, channel, policy, paused, restart needed (`system`), history source |
| `POST /api/pin/update/check` | look now |
| `PUT /api/pin/update/settings` | any of `check`, `channel` (`stable`/`rc`), `mode` (`remind`/`window`), `window {day, at, hours}`, `pauseDays` (0 resumes), `snoozeHours` |
| `POST /api/pin/update` | `{action: "update"\|"rollback", confirm}` hands a request to the helper |
| `GET /api/pin/update/history` | `{entries, system}` |

Related: [ACTIVITY.md](ACTIVITY.md) for what the device is doing, [INSTALL.md](INSTALL.md) for installing and `epaperclip update` from a shell.
