# Signing in with GitHub (PinView → Changes)

ePaperclip connects GitHub with **OAuth device flow**: you press *Connect with GitHub*, open github.com/login/device, type a short code and approve.
No token is pasted, no client secret is kept on your device, and the token GitHub returns is stored sealed and never shown again (only its last four characters).

## One-time setup (whoever publishes or runs ePaperclip)

The device needs the *client ID* of a GitHub OAuth app. The client ID is public; it is not a secret.

1. GitHub → your organization (or account) → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Name: `ePaperclip`. Homepage URL: your site. Authorization callback URL: any HTTPS address (device flow does not use it).
3. Tick **Enable Device Flow**, register the app, and copy the **Client ID**.
4. On the Proxmox host, add the line `EPC_GITHUB_CLIENT_ID=<the client id>` to `/etc/default/epaperclip`, then `systemctl restart epaperclip`.

Until a client ID is set, the Connect form says that signing in isn't set up and offers the fine-grained token instead.

## What it asks GitHub for

Scopes `repo` and `read:user`. ePaperclip only *reads* pull requests and their checks, but GitHub's OAuth apps have no read-only scope for private repositories.
If you prefer least privilege, use a fine-grained personal access token instead (paste it in the same form).

## Notes

- Only Proxmox administrators can connect or disconnect GitHub.
- The host polls GitHub no faster than GitHub's interval and stops when the code expires (15 minutes).
- Disconnecting removes the sealed token. Revoke the app's access on github.com → Settings → Applications as well if you want it gone there.
