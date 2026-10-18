# Release verification, sourced by deploy/epaperclip-update.sh (root), deploy/install.sh --tarball, and inlined into the
# get.sh that scripts/package-release.mjs builds. It is a library: it defines functions and runs nothing.
#
# A release is three files: epaperclip.tar.gz, epaperclip.manifest.json (version, SHA-256, size, file name) and
# epaperclip.manifest.sig (a detached Ed25519 signature over the manifest's bytes, base64). The public key (PEM) is
# pinned in the repository (deploy/release-signing.pub) and shipped inside every release; a download is only believed
# if the manifest's signature verifies against that key. Only openssl (3.x or 1.1.1+) and coreutils are needed.
#
#   epc_verify_release <tarball> <manifest> <signature> <public-key-file> [expected-version] [installed-version]
#
# Returns 0 only when ALL of these hold; otherwise returns 1 with a plain-language reason in EPC_VERIFY_ERROR:
#   - the key file exists and openssl can read it
#   - the signature is 64 bytes of base64 and verifies over the manifest
#   - the manifest names epaperclip.tar.gz and carries a well-formed version and SHA-256
#   - the tarball's SHA-256 and size equal the manifest's
#   - the manifest's version equals expected-version (when given: stops a different, validly signed release being swapped in)
#   - the manifest's version is not older than installed-version (when given: stops a downgrade to an old signed release)
EPC_VERIFY_ERROR=""

# epc_ver_lt A B: true when version A is older than B (semantic versioning: a pre-release is older than its release).
epc_ver_lt() {
  local a="${1#v}" b="${2#v}" ac bc ap="" bp=""
  ac="${a%%-*}"; bc="${b%%-*}"
  [ "$a" = "$ac" ] || ap="${a#*-}"
  [ "$b" = "$bc" ] || bp="${b#*-}"
  if [ "$ac" != "$bc" ]; then [ "$(printf '%s\n%s\n' "$ac" "$bc" | sort -V | head -n1)" = "$ac" ]; return; fi
  [ "$ap" = "$bp" ] && return 1
  [ -z "$bp" ] && return 0
  [ -z "$ap" ] && return 1
  [ "$(printf '%s\n%s\n' "$ap" "$bp" | sort -V | head -n1)" = "$ap" ]
}

epc_verify_release() {
  local tar="$1" man="$2" sig="$3" key="$4" want="${5:-}" have="${6:-}"
  EPC_VERIFY_ERROR=""
  local bin="" v h n s
  command -v openssl >/dev/null 2>&1 || { EPC_VERIFY_ERROR="openssl is needed to check the release's signature and is not installed (apt-get install -y openssl)"; return 1; }
  if [ ! -s "$key" ]; then
    EPC_VERIFY_ERROR="this copy has no release-signing key pinned, so nothing can be verified. The maintainer must run scripts/release-keygen.mjs and publish a release that carries deploy/release-signing.pub"
    return 1
  fi
  [ -f "$tar" ] || { EPC_VERIFY_ERROR="the release file is missing"; return 1; }
  [ -s "$man" ] || { EPC_VERIFY_ERROR="the release has no signed manifest (epaperclip.manifest.json), so it is not trusted"; return 1; }
  [ -s "$sig" ] || { EPC_VERIFY_ERROR="the release has no signature (epaperclip.manifest.sig), so it is not trusted"; return 1; }
  bin="$(mktemp)" || { EPC_VERIFY_ERROR="couldn't make a temporary file"; return 1; }
  if ! tr -d ' \t\r\n' <"$sig" | base64 -d >"$bin" 2>/dev/null || [ "$(wc -c <"$bin" | tr -d ' ')" != 64 ]; then
    rm -f "$bin"; EPC_VERIFY_ERROR="the release's signature file is not a valid Ed25519 signature"; return 1
  fi
  if ! openssl pkeyutl -verify -pubin -inkey "$key" -rawin -in "$man" -sigfile "$bin" >/dev/null 2>&1; then
    rm -f "$bin"; EPC_VERIFY_ERROR="the release's signature is not valid for the pinned key: it was not signed by the project, or the manifest was altered"; return 1
  fi
  rm -f "$bin"
  # The manifest is now authentic, but its values are still checked for shape before use.
  n="$(sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' "$man" | head -n1)"
  v="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$man" | head -n1)"
  h="$(sed -n 's/^ *"sha256": *"\([^"]*\)".*/\1/p' "$man" | head -n1)"
  s="$(sed -n 's/^ *"size": *\([0-9][0-9]*\).*/\1/p' "$man" | head -n1)"
  [ "$n" = "epaperclip.tar.gz" ] || { EPC_VERIFY_ERROR="the signed manifest is for a different file ('${n:-none}'), not epaperclip.tar.gz"; return 1; }
  [[ "$v" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$ ]] || { EPC_VERIFY_ERROR="the signed manifest has no valid version"; return 1; }
  [[ "$h" =~ ^[0-9a-f]{64}$ ]] || { EPC_VERIFY_ERROR="the signed manifest has no valid SHA-256"; return 1; }
  if [ "$(sha256sum <"$tar" | cut -d' ' -f1)" != "$h" ] || { [ -n "$s" ] && [ "$(wc -c <"$tar" | tr -d ' ')" != "$s" ]; }; then
    EPC_VERIFY_ERROR="the download doesn't match the signed manifest's checksum, so it is damaged or was replaced"; return 1
  fi
  if [ -n "$want" ] && [ "$v" != "${want#v}" ]; then
    EPC_VERIFY_ERROR="the signed manifest is for version $v, not the $want that was asked for"; return 1
  fi
  # A development build (wsl-<hash>, a checkout) has no comparable version, so it never blocks an update.
  [[ "$have" =~ ^v?[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,40})?$ ]] || have=""
  if [ -n "$have" ] && epc_ver_lt "$v" "$have"; then
    EPC_VERIFY_ERROR="release $v is older than the $have that is installed, so it was not installed (rollback is the way back)"; return 1
  fi
  EPC_VERIFIED_VERSION="$v"
  return 0
}
