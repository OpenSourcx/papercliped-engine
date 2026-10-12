# APT signing key

`epaperclip-archive-keyring.asc` is the public half of the key that signs ePaperclip's APT repository. Users install it into `/usr/share/keyrings/` and reference it with `signed-by=` (see docs/INSTALL.md).

- Fingerprint: `B8A0 77BE 1EB3 B107 D11A  15DF 3A07 D686 6306 BE32`
- User ID: `ePaperclip Releases <releases@papercliped.co>`
- Type: ed25519, signing only, expires 2029-10-11

The private half lives only in the repository secret `APT_SIGNING_KEY`, used by the release workflow. Never commit it.
