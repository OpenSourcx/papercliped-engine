# Self-managed Cloudflare: implementation notes

Supersedes the "not implemented" status of `CLOUDFLARE-PROVISIONING-DESIGN.md`.

## What exists
- `services/epaperclip/src/cloudflareProvision.ts`: provisioner run by the host service with the customer's own token (device vault). Steps: token ok, domain chosen, tunnel created + ingress to `https://127.0.0.1:443` (`noTLSVerify` for the loopback certificate), proxied CNAME to `<tunnel-id>.cfargotunnel.com`, connector started, reachable (live probe of `https://<host>/api/health`).
- `publishing.ts`: `cf()` API wrapper (429 retried twice with Retry-After, errors name the missing permission, token never in messages), paginated `zones()` with account ids, `CLOUDFLARE_PERMISSIONS` guide.
- Routes (admin only, same-site, audited): `GET /api/publishing/cloudflare/permissions`, `GET|POST|DELETE /api/publishing/cloudflare/deployment`. POST needs mode `cloudflare-self`. Deleting the token while an address exists is refused (409).
- The tunnel run token goes Cloudflare -> host -> root helper socket only; not stored, returned or logged. Leaving self-managed mode stops the connector (objects stay); Remove deletes DNS record, connections, tunnel and stops the connector, idempotently and resumably.
- Safety: one address per device; foreign DNS records need explicit confirmation; tunnel adopted by deterministic name `epaperclip-<deviceid>` (a locally managed one of that name is refused); reserved labels refused. Client IP is read from CF-Connecting-IP while the self tunnel is running.
- UI: `apps/console/src/pages/access/CloudflareAccess.tsx` (token guide, permission self-check, create, step list, Resume, replace-record confirm, Remove). Copy states that no Worker is deployed.

## Limits
- Edit permissions (DNS, Tunnel) cannot be probed without writing; the self-check confirms read access and the create step names an Edit failure exactly.
- Removing a replaced foreign record does not restore it.

## Validation levels
- Simulated: 19 provisioner tests against a fake Cloudflare API (`test/cloudflare-provision.test.ts`, `test/fakes-cloudflare.ts`), console tests. No real token anywhere.
- Real Cloudflare: NOT done. Open gate.

## Manual verification procedure (open gate)
Disposable Cloudflare account with one throwaway zone; token with the three permissions on that zone/account; device with `cloudflared` and `epaperclip-publish.socket`. Choose Self-managed Cloudflare, paste token in Plugins, Check permissions, create `epc-test.<zone>`, confirm all six steps green and sign-in page loads over the public URL; press Resume (no duplicates); Remove and confirm tunnel and DNS record gone in the Cloudflare dashboard.

## Broker request (not filed)
`tool-request new epaperclip cloudflare "Real attach test of self-managed Cloudflare provisioning: with a disposable zone and scoped token, create tunnel epaperclip-<id> and proxied CNAME epc-test.<throwaway-zone>, verify the address reaches /api/health, then Remove and verify deletion. Needs: a throwaway zone owned for testing and a token with Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit on it only. Token stays in the test device vault; never in Git or logs."`
