# Signing in with GitHub (and the OAuth harness behind it)

**For people using ePaperclip: nothing to set up.** In PinView → Changes press *Connect with GitHub*, open github.com/login/device, type the short code and approve.
No token is pasted, there is no client secret on your device, and the token GitHub returns is stored sealed and never shown again (only its last four characters).
It works the same on every device because every ePaperclip uses the same public OAuth app, built in.

## How this compares with Paperclip

Paperclip's catalog (`packages/shared/src/app-definitions/github.json`) has two GitHub methods:

| Paperclip method | What it is | Who owns the GitHub registration |
| --- | --- | --- |
| `managed` (`oauthStrategy: "paperclip_cloud_connector"`, `platform_shared`) | Browser sign-in through **Paperclip Cloud**. The provider token lands in the instance vault on a user grant. | Paperclip Cloud, a hosted broker with a fixed callback. A self-hosted instance never registers an app. |
| `mcp-key` ("Personal access token (advanced)") | Paste a fine-grained token (the `github_pat_…` dialog). | The person, who creates the token. |

Its client resolution order (doc/connections/CONNECTOR-PLAYBOOK.md): a deployment-preconfigured client, then CIMD, then dynamic registration, then a customer-created client ID and secret.

ePaperclip reaches the same result for the user without a hosted broker: **device flow**. The client ID is public and ships in the code; there is no secret to keep and no callback address to host.
A device may still override it with `EPC_GITHUB_CLIENT_ID` (for someone running their own OAuth app).

## What the maintainers register (once), under OpenSourcx

Register **one OAuth App**, not a GitHub App (a GitHub App's user tokens expire after 8 hours and need an installation per organization; the OAuth App is a single step for the person).

1. Sign in to github.com as an owner of the **OpenSourcx** organization and open
   `https://github.com/organizations/OpenSourcx/settings/applications` → **OAuth Apps** → **New OAuth App**.
2. Fill in:
   - **Application name:** `ePaperclip`
   - **Homepage URL:** `https://papercliped.co`
   - **Application description:** `Follow pull requests and checks from your own Proxmox host. Runs on your hardware; nothing is sent to us.`
   - **Authorization callback URL:** `https://papercliped.co/` (required by the form, never used by device flow)
3. Tick **Enable Device Flow**, then **Register application**.
4. On the app page copy the **Client ID** (it looks like `Ov23li…`). **Do not generate a client secret**; device flow needs none, and ePaperclip never stores one.
5. Upload the ePaperclip logo (so the approval screen shows it).
6. Put the Client ID between the quotes of `defaultClientId` for `github` in `services/epaperclip/src/oauth-device.ts` and release. It is a public value.

Check it before releasing:

```
curl -s -X POST https://github.com/login/device/code -d client_id=<CLIENT_ID> -d scope="repo read:user"
```

You should get `device_code`, `user_code` and `verification_uri`. An error `device_flow_disabled` means the box in step 3 is not ticked.

Until the Client ID is built in (or `EPC_GITHUB_CLIENT_ID` is set), the Connect form says so and offers the fine-grained token.

## What it asks GitHub for

Scopes `repo` and `read:user`. ePaperclip only *reads* pull requests and their checks, but an OAuth App has no read-only scope for private repositories.
If you prefer least privilege, paste a fine-grained personal access token in the same form instead.
People in an organization with OAuth app access restrictions need an owner to approve *ePaperclip* once for private repositories.

## The harness, and other providers

`services/epaperclip/src/oauth-device.ts` is the reusable part: a provider entry (`deviceCodeUrl`, `tokenUrl`, `scope`, built-in `defaultClientId`, `envVar`, allowed verification hosts) and `DeviceSessions`, which starts a sign-in, hands the browser only an opaque id (never the device code), holds early polls back to the provider's interval, and returns the token to the caller to store sealed.
Adding a provider that supports device flow is one entry plus its registration.

| Provider | Device flow | Plan |
| --- | --- | --- |
| GitHub | Yes | Built in (this document). |
| Microsoft (Entra) | Yes (`/devicecode`) | Same harness once an app is registered. |
| Google | Yes, for a limited set of scopes | Same harness once a client is registered. |
| Linear, Slack, Notion, Atlassian, most web-only providers | No | Need an authorization-code flow with a redirect. A self-hosted device has no registered address for that, so it goes through a broker, as Paperclip does with Paperclip Cloud: Papercliped Connect is the place for it. Until then they use a key or token. |
| Cloudflare, Tailscale | No OAuth for these uses | Scoped API token or auth key, as today. |

## Notes

- Only Proxmox administrators can connect or disconnect GitHub.
- The host polls no faster than the provider's interval and stops when the code expires (15 minutes).
- Disconnecting removes the sealed token. Revoke the app on github.com → Settings → Applications as well if you want it gone there too.
