# Node and datacenter operations

These screens stand in for the parts of Proxmox's own web UI that are about the device and the datacenter, so nobody needs Proxmox's UI for them. They work on a connected device only (the demo has nothing behind it and says so). Everything is a Proxmox API call made **as the signed-in person**: Proxmox decides permissions, and a refusal (403) is shown as "Your Proxmox account doesn't have permission for this". Input is validated strictly by the host service before anything reaches Proxmox, changes need the same-site header, and anything destructive needs a typed confirmation. Secrets (certificate keys, subscription keys, notification and metric tokens, ACME DNS settings and binding keys, the HTTP proxy password) are write-only: never returned to the browser, never logged, and scrubbed out of any error text Proxmox sends back.

Code: host service `services/epaperclip/src/features/node*.ts` (routes under `/api/node/…`), console `apps/console/src/features/node.tsx` and `apps/console/src/pages/node/**`, data layer `apps/console/src/data/engine/nodeApi.ts`. Every Proxmox path and parameter below was checked against the API viewer data (`apidoc.js`), not guessed.

## The node selector

Node-scoped routes take an optional `node` (query string on reads, body field on changes). It is checked against `GET /nodes`; an unknown or malformed name is refused. Without it the call means the device the console is signed in to. In the console, `NodeSwitcher` (in `pages/node/common.tsx`) shows a node picker in the header of every node screen when the datacenter has more than one node, and the choice is remembered. Existing pages (machines, storage, network, firewall, backups) stay on the default node.

## Host

| Screen | What it does | Proxmox API |
| --- | --- | --- |
| Services | Lists services; start, stop, restart, reload. Stopping (or restarting `pve-cluster`/`corosync`) a service the node depends on needs the service name typed. Only services Proxmox allows are accepted. | `GET /nodes/{node}/services`, `POST /nodes/{node}/services/{service}/{start,stop,restart,reload}` (Sys.Audit, Sys.Modify) |
| Time | Shows the clock and sets the time zone. | `GET`, `PUT /nodes/{node}/time` |
| Logs | Journal (lines, last hour/day/week, unit, importance, kernel only) and system log (paged 200 lines, from/until, service). Search filters the lines shown; Follow re-reads every 3 seconds and sticks to the end. | `GET /nodes/{node}/journal`, `GET /nodes/{node}/syslog` (Sys.Syslog) |
| Updates, Packages | Refresh the index (a task, with its log), the list of upgradable packages with versions, a changelog per package, and the upgrade (see below). A kernel update pending, or a newer kernel installed than the one running, shows "reboot required". | `POST/GET /nodes/{node}/apt/update`, `GET /nodes/{node}/apt/changelog`, `GET /nodes/{node}/apt/versions`, `GET /nodes/{node}/status` |
| Updates, Repositories | Lists repositories, turns each on or off, adds Proxmox's standard repositories. Warns about the enterprise repository without an active subscription and offers a one-click switch (enterprise off, no-subscription on). | `GET/POST/PUT /nodes/{node}/apt/repositories`, `GET /nodes/{node}/subscription` |
| Certificates | Lists the node's certificates (expiry, names, fingerprint); uploads a custom certificate and key; removes the custom certificate. | `GET /nodes/{node}/certificates/info`, `POST/DELETE /nodes/{node}/certificates/custom` |
| Certificates, ACME | Accounts, challenge plugins (DNS providers from Proxmox's own challenge schema), the node's account and domains, order, renew, and back to the node certificate. Orders and renewals run as tasks with their log. | `/cluster/acme/{account,plugins,directories,tos,meta,challenge-schema}`, `GET/PUT /nodes/{node}/config` (`acme`, `acmedomain0..5`), `POST/PUT/DELETE /nodes/{node}/certificates/acme/certificate` |
| Power and subscription | Reboot or shut down (the node name must be typed; the dialog lists the running machines and says clearly that rebooting this device takes ePaperclip with it). Wake a node that is switched off. Subscription: status, set key, check now, remove key. | `POST /nodes/{node}/status` (`command=reboot\|shutdown`, Sys.PowerMgmt), `POST /nodes/{node}/wakeonlan`, `GET/PUT/POST/DELETE /nodes/{node}/subscription` |

### Upgrading packages

Proxmox has **no API task for the upgrade itself**. Its own UI runs it in a terminal (`POST /nodes/{node}/termproxy` with `cmd=upgrade`), because apt can ask questions. So the Updates screen refreshes the index and lists packages as tasks and data, and the upgrade opens the node terminal after a typed confirmation (`upgrade`) that lists the packages and warns about a kernel. The console asks for `/api/console/node?cmd=upgrade`; the terminal relay in `app.ts` must pass `cmd` to Proxmox's termproxy for that to run the upgrade directly (the proxmox client has `termproxyCommand(node, "upgrade")` ready). Until the relay does, the person gets the normal node shell (root@pam only) and runs `apt-get dist-upgrade` there.

### Changing the certificate changes what ePaperclip serves

The installer points `EPC_TLS_CERT` at `/etc/pve/local/pve-ssl.pem`. Proxmox's own proxy serves `/etc/pve/local/pveproxy-ssl.pem` and `.key` instead whenever a custom or ACME certificate exists, so the host service follows the same rule (`nodeTls.ts`): when `EPC_TLS_CERT` is the default `pve-ssl.pem` and a `pveproxy-ssl.{pem,key}` pair sits beside it, that pair is served. A certificate path the operator chose themselves is never second-guessed.

The running server swaps its certificate without a restart (`server.setSecureContext`), validated first (the pair must parse, belong together and be unexpired; otherwise the old certificate keeps being served). It happens:

1. right after an upload or removal through this screen (and again 3 and 15 seconds later, because Proxmox writes the files a moment before it restarts its proxy);
2. when an ACME order, renewal or revert task ends;
3. whenever the files change on disk, checked every 30 seconds (this catches Proxmox's automatic daily renewal);
4. on request: `POST /api/node/certificates/reload` (administrators), which the console calls after ACME tasks and from the "serving an older certificate" notice.

The watcher starts the first time a node route is used after the service starts. A service restart always reads the current files.

**Loopback caveat.** ePaperclip reaches Proxmox on `https://127.0.0.1:8006` and verifies it against the cluster CA. A custom or ACME certificate is not issued by that CA and usually does not list `127.0.0.1`, so after replacing the certificate ePaperclip may no longer verify Proxmox. The upload response warns when the certificate doesn't list `127.0.0.1` or `localhost`. The fix is configuration: set `EPC_PVE_URL` to the node's name (for example `https://pve.example.com:8006`, which must resolve to this machine) and drop `EPC_PVE_CA` so the system trust store verifies it. This is not done automatically.

## Datacenter

| Screen | What it does | Proxmox API |
| --- | --- | --- |
| Datacenter | Cluster name, quorum, version, every node with CPU, memory, uptime and machine counts; works for one node and for many; "Manage" switches the node selector. | `GET /cluster/status`, `GET /cluster/resources` (`type=node`, `type=vm`), `GET /nodes`, `GET /version` |
| Options | Keyboard, language, console viewer, HTTP proxy, MAC prefix, migration, bandwidth limits, replication, next-id range, parallel workers, tag style, who may set tags, protected tags, fencing, HA, resource scheduling, mail sender, notes, location. | `GET/PUT /cluster/options` |
| Notifications | Targets (sendmail, SMTP, Gotify, webhook): add, edit, test, delete; matchers: add, edit, delete. | `/cluster/notifications/{targets,endpoints/{sendmail,smtp,gotify,webhook},matchers}`, `POST …/targets/{name}/test` |
| Metric servers | Graphite, InfluxDB, OpenTelemetry. | `/cluster/metrics/server[/{id}]` |
| Resource mappings | PCI, USB and directory mappings, with Proxmox's own problem checks. Read only. | `GET /cluster/mapping/{pci,usb,dir}` |
| Tags | Tags in use with counts, colors (background and text), shape and order. | `GET/PUT /cluster/options` (`tag-style`, `registered-tags`), `GET /cluster/resources` |
| All tasks | Tasks on every node, filtered by node, type, user, status and time, newest first; open any task's log (read incrementally while it runs); stop a running task. Tasks show under the signed-in user in Proxmox's own task log. Every node screen has a Tasks link that opens this list pre-filtered. | `GET /nodes/{node}/tasks`, `GET /nodes/{node}/tasks/{upid}/{status,log}`, `DELETE /nodes/{node}/tasks/{upid}` |

### Forms come from Proxmox's definitions

The settings forms (options, notification targets and matchers, metric servers, ACME plugins) are not hand-written field by field. `services/epaperclip/src/features/nodeSchema.gen.mjs` reads the API viewer data and writes `nodeSchema.ts`: types, enums, limits, patterns, defaults and the parts of property strings (`next-id`, `migration`, `tag-style`…). The host service validates every value against it (unknown settings are refused; `null` clears one), and sends it to the console, which renders toggles, lists, number boxes with limits and grouped boxes for property strings (`SchemaForm`). To follow a newer Proxmox:

```sh
curl -sS https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js -o apidoc.js
node services/epaperclip/src/features/nodeSchema.gen.mjs apidoc.js > services/epaperclip/src/features/nodeSchema.ts
```

List settings (such as `mailto` or `match-severity`) are sent as repeated form keys, which the proxmox client now supports.

## Routes

All need the Proxmox session; changes need `X-EPC-Request: 1`. Bodies and queries accept an optional `node` where it makes sense. Shapes are in `apps/console/src/data/engine/nodeApi.ts`.

`GET /api/node/nodes` · `GET /api/node/services`, `POST /api/node/services/:service/:action` · `GET|PUT /api/node/time` · `GET /api/node/logs/syslog`, `GET /api/node/logs/journal` · `GET /api/node/power`, `POST /api/node/power`, `POST /api/node/wakeonlan` · `GET|PUT|DELETE /api/node/subscription`, `POST /api/node/subscription/check` · `GET /api/node/updates`, `POST /api/node/updates/refresh`, `GET /api/node/updates/changelog` · `GET /api/node/repos`, `POST /api/node/repos/{toggle,add,no-subscription}` · `GET /api/node/certificates`, `POST|DELETE /api/node/certificates/custom`, `POST /api/node/certificates/reload` · `GET /api/node/acme`, `GET /api/node/acme/tos`, `GET|PUT|DELETE /api/node/acme/accounts[/:name]`, `POST /api/node/acme/accounts`, `POST|PUT|DELETE /api/node/acme/plugins[/:id]`, `PUT /api/node/acme/config`, `POST /api/node/acme/{order,renew}`, `DELETE /api/node/acme/certificate` · `GET|PUT /api/node/datacenter/options` · `GET /api/node/datacenter/notifications`, `GET|POST|PUT|DELETE …/notifications/targets/:type[/:name]`, `POST …/targets/:name/test`, `GET|POST|PUT|DELETE …/notifications/matchers[/:name]` · `GET|POST|PUT|DELETE /api/node/datacenter/metrics[/:id]` · `GET /api/node/datacenter/mappings` · `GET|PUT /api/node/datacenter/tags` · `GET /api/node/cluster` · `GET /api/node/tasks`, `GET|DELETE /api/node/tasks/:upid`.

## Tests

Host service: `services/epaperclip/test/node.test.ts` (every route: happy path, validation refusals, permission denials, secrets never in responses or errors) and `node-tls.test.ts` (the certificate swap on a real HTTPS server, including an end-to-end upload). The fake Proxmox for these is `test/fakes-node.ts`. Console: `apps/console/test/node.test.tsx`.

## Not verified against a real Proxmox

Everything above was checked against the API viewer data and a fake Proxmox, not a real node: the exact bytes of array parameters (sent as repeated keys), the upgrade terminal command, the standard-repository `status` values, and the certificate swap on a node whose proxy has just restarted.
