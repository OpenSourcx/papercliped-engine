# APT signing key

`epaperclip-archive-keyring.asc` is the public half of the key that signs ePaperclip's APT repository. Users install it into `/usr/share/keyrings/` and reference it with `signed-by=` (see docs/INSTALL.md).

- Fingerprint: `2DC0 0D1A 1A87 1018 F797  E7CE F565 5E1B 9FA7 5813`
- User ID: `ePaperclip Releases <releases@papercliped.co>`
- Type: ed25519, signing only, no passphrase, created 2026-11-14, expires 2029-11-13

The private half lives only in the repository secret `APT_SIGNING_KEY`, used by the release workflow. Never commit it.

The package is built from the release tarball, including `epaperclip-exec.mjs`, `epaperclip-exec.socket` and `epaperclip-exec@.service`. Its postinst and prerm call the shared installer, so APT installs/enables and uninstalls the private container exec helper just like source installs and signed updates. The helper uses the bundled Node, not a system Node package.

The first key (fingerprint `B8A0 77BE 1EB3 B107 D11A  15DF 3A07 D686 6306 BE32`, made 2026-10-12) was replaced on 2026-11-14: its private half
existed only in the repository secret, which GitHub cannot show again, and the stored value could not be imported. Nothing had been published
with it, so no one's trust was affected. The new key was generated inside a sandbox and written straight into the secret; the private half was
never displayed or saved anywhere else, so **there is no backup of it**. If it is ever lost, the same replacement has to be repeated, and by then
users will have trusted this fingerprint. Keep that in mind before the repository has real users, and consider exporting a backup from a
machine you control (`gpg --armor --export-secret-keys`) by generating the next key there.
