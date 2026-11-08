# Release plan: from today to a release candidate on a real device, then stable V1

Written 2026-11-08 by the release-engineering agent (miah). Nothing here was tagged, released, published to R2 or APT, and no GitHub
setting was changed. Every step that needs the owner or the broker is marked **pending-owner-approval**.
Evidence labels: **real** (the actual artifact or service), **local** (this machine, real code, stand-ins around it),
**simulated** (the repository's fake-host suite).

## 1. Where things are (2026-11-08)

* Latest tag and pre-release: `v1.0.0-rc31` (23:50 UTC 2026-11-06). No final release exists, so the stable channel, `releases/latest`,
  the stable APT repository and npm `latest` have nothing (`updates.papercliped.co/apt/...` and `apt.papercliped.co/...` answer 404).
* Open PRs: #15 `feat/stable-v1-reconcile` -> `main` (the integration branch; #17 is already merged into it), #16 identity contract (docs),
  #18 `feat/worker-fabric`, #19 `feat/worker-fabric-ui` (base #18), #20 `feat/cloudflare-access`, #21 `fix/agent-containers` (all base #15),
  #6 `dist/r2-updates` -> `main`.
* `main` has no branch protection (`GET branches/main/protection` = 404, `rulesets` = `[]`, checked 2026-11-08).

## 2. Version naming (the repo's convention)

Tags are `v<MAJOR>.<MINOR>.<PATCH>[-rcN]`; so far `v1.0.0-rc1` through `v1.0.0-rc31`, contiguous (`git tag`); never re-used. `scripts/sign-release.mjs`, `release-lib.mjs` and the update helper accept
`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]{1,40})?$`; rc ordering is numeric (`rc9 < rc31`, tested in `deploy/test/run.sh`, "version order").
* Next candidate: **`v1.0.0-rc32`** (the owner tags; I did not). Debian packages turn `-` into `~` so `1.0.0~rc32 < 1.0.0`
  (`scripts/build-deb.sh`); GitHub shows the asset as `...1.0.0.rc32_all.deb` because it rewrites `~`. The package itself is correct.
* Stable: **`v1.0.0`**, the same commit as the accepted rc or later. A hyphen-free tag is what triggers APT publication, npm `latest`, and the
  first move of devices on the default channel. A bad release is pulled by adding it to `deploy/withdrawn-releases.txt` (the feed then marks it withdrawn).

## 3. Merge order and predicted conflicts

Computed with `git merge-tree --write-tree` and trial merges in scratch worktrees (`release-trial-rc`), never on others' branches.

| Step | Merge | Base | Predicted conflicts | Notes |
|---|---|---|---|---|
| 1 | #18 `feat/worker-fabric` into #15 | `feat/stable-v1-reconcile` | `docs/STABLE-V1-LEDGER.md` only (both sides append sections; keep both) | Resolved in the integration; the same file conflicts for #19 until #18 is in |
| 2 | #19 `feat/worker-fabric-ui` | #18 | none after step 1 | Contains #18's commits |
| 3 | #20 `feat/cloudflare-access` | #15 | none | |
| 4 | #21 `fix/agent-containers` | #15 | none | |
| 5 | #16 identity contract | #15 | none (docs only) | Proposal: Connect has not accepted its open questions; merge as a proposal or hold |
| 6 | #15 into `main` | `main` `a708864` | none (`merge-tree` clean) | Merge only after the integrated head is green and the owner approves; after this the stacked PRs retarget `main` |
| X | #6 `dist/r2-updates` | `main` | **CONFLICTS** in `release.yml`, `README.md`, `INSTALL.md`, `RELEASING.md`, `UPDATES.md`, `publish-apt.sh`, `publish-update-feed.sh` | **Do not merge.** `main` already carries a different R2 publishing implementation (`339470d`, secrets `CLOUDFLARE_R2_*`, bucket `epaperclip-releases`) which matches the secrets that exist in the repo. #6 uses `R2_*` secrets and bucket `epaperclip-updates`, which are not configured, so merging it would silently stop feed publication. Salvage candidate: its `verify_pool` hardening in `publish-apt.sh` (3ced0f2), re-applied on top of `main`'s variant. Close #6 |

Integration performed 2026-11-08 on `feat/stable-v1-reconcile` with ordinary merge commits (no force-push): #18, #19, #20, #21. Only the
ledger conflicted. Heads merged: #18 `3ded131`, #19 `9b441e4`, #20 `f20408e`, #21 `45be134`. The head SHA and CI of the integrated branch are in section 9.

## 4. What is signed today (honest)

* **Release manifest**: Ed25519 over `epaperclip.manifest.json` (version, SHA-256, size, name). Key: private half in the GitHub secret
  `RELEASE_SIGNING_KEY` (set 2026-10-18); public half `deploy/release-signing.pub` (`MCowBQYDK2VwAyEAUKvQ...`), shipped in every tarball and inlined in `get.sh`.
* **Checked by me, real**: the published `v1.0.0-rc31` manifest verifies with that key (`epc_verify_release`), its SHA-256 and size match, and the tarball carries the same public key.
  The live `https://updates.papercliped.co/feed.json` + `feed.sig` verify against the same key (`channels: stable null, rc 1.0.0-rc31`, generated 2026-11-06T23:50:17Z).
* **Update helper** verifies, in order: signature (key installed with the running version, never from the download), size/SHA-256, manifest version equals the request, no downgrade; only then extracts and runs the installer.
* **APT**: signing key secret `APT_SIGNING_KEY` exists, public key at `deploy/apt/epaperclip-archive-keyring.asc`; **nothing published** (stable only, 404 today).
* **Missing / not evidenced**: an offline backup of the release key; a rotation drill; tag-push restriction (Settings, Rules) and a `release` environment with required reviewers (RELEASING.md recommends both; `environments` is empty);
  signature on the `.deb` itself (it is covered by neither manifest nor feed; APT's InRelease would cover it only after a stable publish); the `get.sh` asset is not individually signed (it embeds the key and is trusted by TLS to GitHub for the first install; later updates are verified).
  npm provenance uses Trusted Publishing; not checked.

## 5. Pre-flight checklist (all **pending-owner-approval**)

1. Review the integrated PR #15 head and its CI (`checks`, `deploy-simulation` green).
2. Branch protection on `main` (section 6) so nothing merges red.
3. Secrets present (names only, confirmed by `gh secret list`): `RELEASE_SIGNING_KEY`, `APT_SIGNING_KEY`, `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_ENDPOINT`, `CLOUDFLARE_R2_BUCKET`. Not present: `APT_SIGNING_PASSPHRASE` (fine if the key has none).
4. Restrict who can push `v*` tags; create the `release` environment with required reviewers (optional, recommended).
5. Merge #15 to `main` (owner decision). Then re-check `git merge-tree origin/main <rc commit>`.
6. Tag from the merged commit: `git tag v1.0.0-rc32 <sha> && git push origin v1.0.0-rc32`. CI runs typecheck, tests, build, PVE conformance, release-script tests, provider build, `deploy/test/run.sh` as root, the real-engine install test; signs; publishes a GitHub pre-release; publishes the signed feed (never fails the release); npm `next`. APT is not touched.
7. Verify what was published (commands in section 8) before telling anyone to install.

## 6. Branch protection: exact commands for the owner/admin (NOT run by me)

Required check names are the CI job names `checks` and `deploy-simulation` (workflow `CI`). Run as a repository admin:

```sh
gh api -X PUT repos/OpenSourcx/papercliped-engine/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["checks", "deploy-simulation"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
gh api repos/OpenSourcx/papercliped-engine/branches/main/protection --jq '.required_status_checks.contexts'   # verify
```

Optional tag rule (rulesets API): restrict creation of `v*` tags to admins:

```sh
gh api -X POST repos/OpenSourcx/papercliped-engine/rulesets --input - <<'JSON'
{ "name": "release tags", "target": "tag", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ],
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ] }
JSON
```

Notes: `enforce_admins:false` leaves the owner able to merge in an emergency; set `true` once the flow is trusted. With one human owner,
`required_approving_review_count: 1` blocks the owner from merging their own PR unless a second account/bot reviews; set `0` (keep the checks) if that is the situation.
The CI workflow has `pull_request` and `push: main` triggers, so both checks report on PRs. `strict:true` forces branches to be up to date (stacked PRs must be retargeted and updated after #15 merges).

## 7. Release candidate path (a): rc on a real device

1. Items 1-7 of section 5; tag `v1.0.0-rc32`.
2. On the **real device** (a Proxmox VE 8 host or a test VM running Proxmox, root, 4 GB RAM, 3 GB free disk, internet):
   ```sh
   B=https://github.com/OpenSourcx/papercliped-engine/releases/download/v1.0.0-rc32
   curl -fsSL $B/get.sh | EPC_RELEASE_BASE=$B bash
   epaperclip status
   ```
3. Upgrade proof on that device: tag `v1.0.0-rc33` later, then Updates page or `epaperclip update --tag v1.0.0-rc33`; rollback: `epaperclip rollback`.
4. **What I need to run it myself**: SSH (key) as a sudo user to a disposable Proxmox VE 8 host or nested PVE VM that is not the production Proxmox host, outbound HTTPS to github.com and registry.npmjs.org, a statement that it may be wiped, and the owner's go-ahead. Nothing else is required; it needs no secrets.

## 8. Stable V1 path (b) and post-publish verification

1. Real-device gates in `docs/V2-ACCEPTANCE-MATRIX.md` (C1, C3, C4, S1, S2 minimum) pass on the rc.
2. Decide on #16/Connect identity linking and #6 (close).
3. Tag `v1.0.0` on the accepted commit. Expect: GitHub release (not pre-release), signed APT repo at `updates.papercliped.co/apt` (R2 custom domain; INSTALL.md currently documents `apt.papercliped.co`, which does not resolve to content: **fix the docs or the domain before announcing APT**), npm `latest`, feed channel `stable: 1.0.0`.
4. Verify after each publish:
   ```sh
   gh release download v1.0.0-rc32 -R OpenSourcx/papercliped-engine -D /tmp/rc32
   curl -s https://updates.papercliped.co/feed.json -o feed.json; curl -s https://updates.papercliped.co/feed.sig | base64 -d > feed.bin
   openssl pkeyutl -verify -pubin -inkey deploy/release-signing.pub -rawin -in feed.json -sigfile feed.bin
   bash -c '. deploy/verify-release.sh; epc_verify_release /tmp/rc32/epaperclip.tar.gz /tmp/rc32/epaperclip.manifest.json /tmp/rc32/epaperclip.manifest.sig deploy/release-signing.pub 1.0.0-rc32 && echo OK'
   ```

## 9. Validation on the integrated head (local, real code)

Integrated head and CI: see the PR #15 description / this file's last lines (updated after the push).

## 10. Install / upgrade / rollback proof (local container, real scripts, real artifacts built from the integrated head)

**Label: local, real `get.sh`, `install.sh`, update helper, `verify-release.sh`, pinned Node 24.21.0 download and `npm ci` of the real engine 2026.1023.0 (embedded PostgreSQL, 332 migrations).
Not a real Proxmox host**: the target is `docker` image `epc-release-trial-target` (Debian 12, real systemd as PID 1, 5 GB memory limit, disposable container `epc-rc-target`, removed afterwards), with stand-ins for only what is Proxmox-specific
(`pveversion` printing `pve-manager/8.2.4`, `pveproxy.service` and `pve-cluster.service` as `sleep infinity`, a self-signed node certificate). Dockerfile and scripts: `/project/.work/release-plan/` (outside the repository).

Artifacts: built from the integrated head of `feat/stable-v1-reconcile` (`76060d0` + matrix edits) with `scripts/package-release.mjs` and `scripts/sign-release.mjs`, versions **`1.0.0-rc32` and `1.0.0-rc33`**
(local trial names, never tagged or published). They are signed with a **throwaway Ed25519 key** made for this trial (outside the repository); the repo's real public key was swapped only in the working tree during packaging and restored (`git checkout`).
Signature, checksum and version of both verified with the trial key by `epc_verify_release`. The real production key was never used (CI-only).

| Step | Command (inside the container unless noted) | Result (exact) |
|---|---|---|
| First install attempt | `EPC_RELEASE_BASE=file:///rel/v1.0.0-rc32 bash get.sh` | `signature and checksum verified (version 1.0.0-rc32)`, Node downloaded, engine installed from lockfile, then `Failed to start epaperclip.service: Unit pve-cluster.service not found.` and **`installation failed and was removed. Proxmox's interface is unchanged`** (exit 1). A target-stand-in gap, and a proof that a failed first install is removed (`/opt` empty afterwards) |
| Install rc32 | same, after adding the `pve-cluster` stand-in | `epaperclip: installed 1.0.0-rc32: running, could NOT reach Proxmox's sign-in` (expected: no Proxmox :8006 stand-in), exit 0. `epaperclip status`: epaperclip.service running, epaperclip-engine.service running, `engine health: ok on 127.0.0.1:3100`, `health: ok at https://172.17.0.2:443/`, engine paperclipai 2026.1023.0, update path unit active |
| Upgrade rc32 -> rc33 | request file `action=update version=1.0.0-rc33` written as user `epaperclip` into `/var/lib/epaperclip/update/`; `epaperclip-update.path` fired the root helper; `EPC_RELEASE_DOWNLOAD=file:///rel` via a unit drop-in | status `phase=done message=Updated to 1.0.0-rc33`; `/opt/epaperclip/VERSION` 1.0.0-rc33, `/opt/epaperclip.prev/VERSION` 1.0.0-rc32; both services active; engine health ok; marker file in the engine DB dir kept |
| Downgrade request | `action=update version=1.0.0-rc32` while on rc33 | `phase=failed message=Version 1.0.0-rc32 is older than the 1.0.0-rc33 that is running, so it was not installed. Nothing was changed.` VERSION stays rc33 |
| Rollback | request `action=rollback` | `phase=done message=Rolled back to the previous version.`; log `epaperclip: rolled back to 1.0.0-rc32 (engine 2026.1023.0).`; VERSION rc32; services active; engine health ok; the DB-dir marker still present |
| Upgrade again | `action=update version=1.0.0-rc33` | `phase=done message=Updated to 1.0.0-rc33`, engine health ok |

What this does not prove: a real Proxmox host (certificates in `/etc/pve`, `pveproxy` sign-in on :8006, firewall), the console Update button (the request file was written directly as the host-service user, which is what the host service does),
an engine-pin change on upgrade/rollback (both builds pin 2026.1023.0, so `pre-upgrade` DB restore was not exercised here; it is covered by the simulated `upgrade`/`rollback`/`drain` scenarios and by `docs/UPGRADING.md`'s real-data check), `get.sh` over HTTPS from GitHub, large-database migration time, reboot persistence.
No defect was found in the install, upgrade or rollback scripts, so no script was changed.

Release-script and suite results on the integrated head (local, real code): typecheck ok; `pnpm -r test` all packages pass (services/epaperclip 1091 passed / 22 skipped, apps/console 562 passed, proxmox-client 112, worker-fabric 17, worker-daemon 4, host-broker 21);
build ok; `check:design` 0 violations; `scripts/check-pve-api.mjs` ok; `node --test scripts/*.test.mjs` 25/25; provider typecheck/test/build ok; `sudo bash deploy/test/run.sh` **193 passed, 0 failed** (simulated hosts; `real_engine` skipped, as in CI it runs only in the release workflow).
One timing flake observed once under heavy machine load: `packages/worker-daemon` `gate.test.ts` (passed 3/3 alone and in the full run). On PR #19's earlier CI heads `fabric.test.ts` "adopts a worker with a single-use code" failed twice (race: the test reads the worker's config file as soon as the hub reports it online); the later heads are reported green. Both belong to the Worker Fabric author.
