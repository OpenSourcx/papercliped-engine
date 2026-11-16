# Changelog

## 1.0.3

- **Agents in containers can reach Paperclip's MCP servers.** Paperclip addresses the "Paperclip projects" and "Paperclip connections" MCP servers as the engine's loopback port, which inside a container is the container's own loopback, so every connection was refused (ECONNREFUSED). The provider now gives each container that port through an SSH reverse forward, held for as long as it holds the container, that ends at a small host-side relay. The relay forwards only those routes (`GET`/`POST /mcp/runtime-tools`, `POST /api/mcp/project-tools`), passes the agent's own bearer token through untouched, and drops cookies and other headers. The engine stays bound to host loopback and keeps requiring Paperclip's authentication. Existing containers are prepared the first time a command runs in them; new templates ship the sshd setting.
- **`epaperclip mcp-check <container id> [--run <run id>]`.** A read-only check, run as root on the host, that an agent container reaches both MCP servers through that route: the engine is loopback-only, the container's sshd is set for the forward, other engine routes are refused from the container, and `tools/list` answers with the run's own token (read from its retained config, never printed). Also at `/opt/epaperclip/update/mcp-check.sh`.
- **A stale "running" agent is reset.** When a run is cancelled while the agent is starting it, Paperclip can set the agent to "running" after the cancellation, with nothing left to clear it. ePaperclip's minute sweep now sets an agent that is ready, says "running" and has no queued or running run for three sweeps in a row back to idle, after confirming once more just before. It uses the engine's own agent update, cancels and pauses nothing, and does nothing when the engine can't say what is live.
- **An agent with no live work no longer shows "Working".** Paperclip keeps an agent's `running` word in its record and clears it only when a run ends while the agent is ready; a run cancelled or failed during setup can leave it behind. The agent list, the agent page, the organization chart, the dashboard and the chat now show Working only while Paperclip lists a queued or running run for that agent, and Idle otherwise. The run history keeps the real outcome (Cancelled, Failed, Finished).
- **Agent sign-in shows its address sooner.** The dialog now checks the new sign-in every half second at first (then every second, then every two once the address is there) instead of waiting two seconds before the first look, and asks for Claude's address only until it has it rather than on every check.
- **The console loads about 4 times faster over the wire.** The host service now sends the console's text files compressed (Brotli, else gzip) when the browser accepts it, computed once per file and kept in memory. The main script drops from 2.5 MB to about 0.56 MB, and a reload of the page itself is answered with an ETag and a 304.
- **The chat list stops spinning after a run is stopped.** An agent conversation shows as working only while Paperclip lists a queued or running run for it.
- **An agent's status and its readiness are shown separately.** The agent page no longer joins them into one green line such as "Working, ready to run"; the status keeps its own colour and "Ready to run" sits beside it.
- **Every run state has a name.** Runs that Paperclip marks as waiting for a retry or interrupted now say "Retry scheduled" and "Interrupted".

## 1.0.2

- **Safer rollback.** `epaperclip rollback` now checks for the database copy from before the upgrade first, and refuses (changing nothing) if it is missing or from a different engine version, instead of starting the older engine on a database the newer one already migrated. `EPC_ROLLBACK_WITHOUT_DB_COPY=1` goes back anyway.
- **Failed upgrades never replace a live database.** If an upgrade fails to start and an engine process is still running after the stop, the automatic recovery now leaves the database, the copy and the previous version as they are and stops, telling you to run `epaperclip rollback` once that process is gone.
- **Agent chat in Pin view.** An organization agent's chat now has a working Stop button (it cancels the run), shows Queued, Running or Stopping, links to the agent's settings or Agent containers when something blocks it, and shows a loading or retry state instead of "no longer available" while the agent loads.
- **Sign-in status is honest.** An organization's connected provider account is shown as "Provider account" and no longer marks an agent container as "Signed in"; a failed check says so with a retry, and a sign-in started just before the dialog closes is cancelled instead of left running.

## 1.0.1

- **The pairing screens show the device key.** `epaperclip login` and the console panel print the start of this computer's key; the approval page on link.papercliped.co shows the same characters, so the owner can check they are approving the right computer.
- **`epaperclip login`.** Link a computer to your Papercliped account from its shell: it shows a short code to enter at https://link.papercliped.co, waits for you to approve it there, shows which account approved it and asks you to confirm. `epaperclip whoami` shows what it is linked as; `epaperclip logout` unlinks it. The console's "Link to Papercliped" panel now shows the same code instead of a long address (older Papercliped servers still use the approval link).
- **Link your Papercliped account to your Proxmox user, with a code.** A new panel under Access, Remote access (once this computer is linked) starts a machine sign-in link, shows a code to enter at https://link.papercliped.co, and asks the administrator to confirm the account that approved it before anything is linked. Administrators get a matching card: turn Sign in with Papercliped on or off, approve or deny requests from other people (shown with the account they would use), hand out short-lived pre-approvals, and unlink other people's links.
- **No error line on a fresh install.** The installer no longer prints "No such file or directory" for the channel marker before it has written one.

## 1.0.0

The first final release of ePaperclip: a Proxmox-native console, its pinned Paperclip engine and agents that run in
unprivileged containers or on workers you enrol, with Pin to explain and operate it within what you approve.

**Install** (Proxmox VE 8+, as root; the installer checks everything first and rolls back by itself):
`apt install epaperclip` (signed repository, see docs/INSTALL.md), or `npx epaperclip install`, or the `get.sh` one-liner.
Workers (Linux): `sudo epaperclip --worker`, then `sudo epaperclip --worker connect <code>`.

**New since the release candidates**
- Signing in survives a restart or an upgrade: sessions are kept sealed on the host, their limits and every way of ending one still apply.
- Follow a run to its container or worker and back: the console shows where a run ran and what a machine has run, limited to your organizations.
- Pin can be given the run, container, worker or organization you are looking at. The host reads the facts as you and checks your access; text from a run is treated as data. You see, and can remove, what Pin is given.
- Pin can stop a run in every mode. You approve by typing a phrase (in the chat in Agent mode, on the Plans tab in Assistant mode and with the plan permission); the run is checked again when you approve, and a run that finished or changed is not stopped.
- `apt`, `npm` and the release download no longer fight over a host: the installer records which one installed it and refuses to install over an apt-managed host, with the way forward.
- The worker release is now signed with the release key and ships inside the npm package; `epaperclip --worker` verifies it, installs it and leads into pairing.

**What is verified, and what is not.** Verified: the host and worker releases are signed and the signatures check out against the pinned key; the npm package carries the same signed files with build provenance; the installers pass their simulated-host suites (211 host-installer checks, 77 worker checks); the host service, console and workers pass their automated tests (1,322, 648 and 12). **Not yet verified:** a first install from the signed apt or npm package on a clean physical Proxmox host, then upgrade, rollback and reinstall; ChatGPT/Codex sign-in; GitHub device sign-in through to connected; several runs at once, cancelling and recovery after a restart on real hardware; a Mac worker; Orion enrolment; remote access through Cloudflare, Tailscale or Papercliped Connect end to end, and paid Connect. Everything above that is marked tested was tested against stand-ins, not on a real host.

**Upgrading.** `epaperclip rollback` puts the previous version back (the engine's database too, when the engine changed). A host installed from source or an earlier candidate upgrades in place with the same command it was installed with; a host apt manages must upgrade with apt. Back up before you upgrade (`docs/BACKUP.md`): this is the first final release.

**Known gaps.** See `docs/PLACEMENTS.md`, `docs/PIN-CONTEXT.md` and `docs/PIN-STOP-RUN.md` for what each new piece does not do yet, and the status ledger in the docs repository for the open items.
