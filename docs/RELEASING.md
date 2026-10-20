# Releasing

How a release is cut and signed. Why it is signed, and what each installer checks, is in [SECURITY.md](SECURITY.md#release-signing).
In short: CI signs a small manifest (version, SHA-256, size, file name) with an Ed25519 key that only CI holds; every installer
and the root update helper verify it with the public key pinned in this repository. No signature, no install.

## One-time key setup (a maintainer, on their own machine)

Never in CI, and never in a shared terminal log.

```sh
git pull
node scripts/release-keygen.mjs --set-secret          # needs `gh auth login` with access to the repository
git add deploy/release-signing.pub
git commit -m "Pin the release signing public key"     # review it: it must be a PUBLIC KEY block
git push
```

`--set-secret` pipes the private key to `gh secret set RELEASE_SIGNING_KEY` and never shows it or writes it to disk. Without
`--set-secret` the script prints the private key once on stdout instead; paste it into Settings, Secrets and variables, Actions,
as `RELEASE_SIGNING_KEY`, then clear the terminal. Keep an offline backup (a password manager entry or a printed copy in a safe);
if the key is lost, see "Rotating the key" below for what that costs.

`deploy/release-signing.pub` is a PEM public key (`openssl pkeyutl` reads it directly). It is committed, shipped in every
release and inlined into the `get.sh` each release carries. It doesn't exist until you run the generator, and until then no
release can be built (CI stops on a tag) and no build of the code installs anything; the failure says
"run scripts/release-keygen.mjs".

Also worth doing once: restrict who can push `v*` tags (Settings, Rules), and attach the secret to a `release` environment with
required reviewers.

## Cutting a release candidate

```sh
git tag v1.0.0-rc1
git push origin v1.0.0-rc1
```

A tag with a hyphen builds, tests, signs and publishes a GitHub **pre-release**, publishes npm with `--tag next` (so `latest` is
untouched) and leaves the APT repository alone. "Latest" on GitHub, `get.sh` from `releases/latest` and the console's
update notice ignore it. Install it on a test host as described in [INSTALL.md](INSTALL.md#release-candidates).

## Cutting a stable release

```sh
git tag v1.0.0
git push origin v1.0.0
```

CI runs typecheck, test, build and the installer tests on simulated hosts, packages, signs, then publishes the GitHub release,
the APT repository and npm `latest`. The build fails, and nothing is published, if `RELEASE_SIGNING_KEY` or
`deploy/release-signing.pub` is missing, or if the key doesn't match the pinned public key (`scripts/sign-release.mjs` verifies
its own output before it writes it).

Before tagging: the version in the tag is what gets signed, so it must be the one you mean. Versions are `MAJOR.MINOR.PATCH`,
optionally `-rc1`, `-beta1`. After it is out, check one release by hand (see SECURITY.md) or run `get.sh` on a test host.

## What users get from a release

A release is not only the tag. After the GitHub release is published, CI:

1. publishes the signed APT repository (final releases only),
2. publishes the **signed update feed** (`updates/feed.json` and `feed.sig` on the Pages site) with every release, its channel and notes. The step never fails a release; devices fall back to GitHub's release list,
3. publishes the npm package.

Installed devices read the feed on their channel, so the order that matters to users is: **tag a release candidate, let people on the candidate channel try it, then tag the final release** (same commit or later). A final tag (no hyphen) is what everyone on the default channel is offered. See [UPDATES.md](UPDATES.md).

### Pulling a bad release

Add its version and a reason to `deploy/withdrawn-releases.txt`, push, and tag the next release. The feed then marks the version withdrawn: devices never offer it and warn any that run it. The GitHub release itself can stay (a pulled release's files still verify); withdrawing is about what devices are told.

### Before the first final release

`1.0.0` is the first release that moves devices on the default channel. Until then devices on it see "No final release yet" and only people who opt in to release candidates are offered anything.

## Rotating the key

Installed hosts only trust the key they were installed with, so a new key must ride in a release the old key signed.

1. `node scripts/release-keygen.mjs --public-out new.pub` (no `--set-secret`). Keep the printed private key aside.
2. `cp new.pub deploy/release-signing.pub`, commit, and tag a release as usual. The secret still holds the old private key, so this
   bridge release is signed by the old key and carries the new public key. Hosts update to it.
3. Once hosts have moved, store the new private key as `RELEASE_SIGNING_KEY` (`gh secret set RELEASE_SIGNING_KEY < new.pem`, from a
   file you then shred). All later releases are signed with it.
4. Destroy the old private key.

Hosts that skip the bridge release refuse later updates with a message; they are fixed by running the current `get.sh` once.
If the old key is lost or leaked there is no safe bridge: announce it, make a new key, and have everyone reinstall with `get.sh`
from a copy of the repository verified out of band.
