# Cloudflare R2, through its S3-compatible API: where the signed update feed and the APT repository are served from, at
# https://updates.papercliped.co (the bucket's custom domain). Sourced by publish-update-feed.sh and publish-apt.sh.
#
# Needs R2_ENDPOINT (https://<account id>.r2.cloudflarestorage.com), R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY: a token limited
# to the one bucket with Object Read & Write. R2_BUCKET defaults to epaperclip-updates. The credentials reach the `aws` CLI
# (on GitHub's runners) through its environment only, never its command line.
R2_BUCKET="${R2_BUCKET:-epaperclip-updates}"
EPC_UPDATES_BASE="https://updates.papercliped.co"

r2_ready() { [ -n "${R2_ENDPOINT:-}" ] && [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; }

# R2 accepts the checksums the AWS CLI adds only when they're asked for, so they're limited to that.
r2() {
  command -v aws >/dev/null || { echo "r2: the aws command is missing (pipx install awscli)" >&2; return 1; }
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto \
    AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    aws --endpoint-url "$R2_ENDPOINT" --only-show-errors s3 "$@"
}
