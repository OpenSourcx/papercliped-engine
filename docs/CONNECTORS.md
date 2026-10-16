# Connectors

Everything that connects ePaperclip to AI: apps that use this device (Claude, ChatGPT, Codex, any MCP client), the model services Pin and the agents think with (hosted providers and models you run yourself), agents' own AI accounts, and the adapters that run agents. Code lives in `services/epaperclip/src/features/connect*.ts` (one registration line each in `features/index.ts`, plus the root routes hooked in `app.ts`), the screens in `apps/console/src/pages/connect/`.

Rules that hold everywhere below: every call acts as the signed-in Proxmox person; changes need `X-EPC-Request: 1` and a same-site `Origin`; input is validated strictly and unknown fields are refused; keys and tokens are sealed or hashed, returned once at most, and never logged; the content security policy is untouched.

## How the pieces fit

| Piece | What it is | Studied from |
| --- | --- | --- |
| Papercliped bridge | OAuth 2.1 server and an MCP endpoint at `/mcp` on this device, so Claude, ChatGPT and Codex connect to it directly | The Papercliped bridge repository's plan (OAuth, `paperclip:read` / `paperclip:control`), the MCP authorization spec (RFC 9728, 8414, 7591, 8252, 7636) |
| Connections | Model services with a key or an address: the four built in (Anthropic, OpenAI, Gemini, OpenRouter), 14 more hosted providers, and local servers | Paperclip's AI connections, Proxmox-style "test before you trust" |
| Agent AI accounts | Per organization: a key handed to the engine, or a Claude / ChatGPT subscription signed in inside the agent container | The engine's `ai-connections` and device-login sessions (`/api/companies/{id}/adapters/{type}/login-sessions`, `setup-token-login-sessions`) |
| Adapters | Paperclip's 15 built-in adapter types, switched on in the engine, plus adapters from the signed catalog | The engine's `/api/adapters` |

## Connecting an app (the bridge)

An app needs only this device's address: `https://<device>/mcp`. Web apps (claude.ai, ChatGPT) must be able to open it from the internet, so the device needs an https address they can reach (a tunnel or Tailscale); Codex and other programs on your network can use it directly.

1. **Discovery.** `POST /mcp` without a token answers 401 with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`. The metadata points at this device as the authorization server (`/.well-known/oauth-authorization-server`: authorization code, refresh token, S256 only, public clients only).
2. **Registration.** `POST /oauth/register` (RFC 7591), open but limited to 10 an hour per address and 500 stored apps. Only public clients (`token_endpoint_auth_method: none`). An app registered but never approved is forgotten after a day.
3. **Redirect addresses, strictly.** Up to 5 per app; `https` as given, or plain `http` only on a loopback address (`localhost`, `127.0.0.1`, `[::1]`; any port). No fragments, user names, wildcards, other schemes (`javascript:`, `data:`, app-specific schemes) or anything over 2000 characters. At authorization the address must match a registered one exactly (loopback: any port). A wrong app or address gets an error page, never a redirect.
4. **Authorization.** `GET /oauth/authorize` serves the console's consent page (the session cookie is `SameSite=Strict`, so it only reaches our own pages). The page shows the app's name, **the host it will return to**, the person, the access level, the organizations, and whether the app may act without a plan. Approve or Deny; the redirect carries `code`, `state` and `iss` (RFC 9207). `resource`, if sent, must be this device's `/mcp`.
5. **Token.** `POST /oauth/token` with the code, the exact redirect address and the PKCE verifier. Codes live 60 seconds and work once; presenting a used code ends the connection it made. Access tokens (`epo_...`) last an hour; refresh tokens (`epr_...`) rotate on every use, and an already-used refresh token ends the connection (a copy was taken). A connection lasts at most 90 days. `POST /oauth/revoke` (RFC 7009) lets the app give up its tokens.
6. **Limits.** Token endpoint: 60 requests a minute and 20 bad tries per 5 minutes per address. `/mcp`: 240 requests and 90 tool calls a minute per connection. Consent: 20 a minute per person.

### What an approval creates

Approving mints a real Proxmox API token of the signed-in person, `<user>!epc-<id>` (acts as the person, expires with the connection), sealed in the vault and listed under their API tokens as "App: Claude (Full control)". The app never sees it. Everything the app does goes through that token, so **Proxmox decides**: a person who can't stop machine 101 can't let an app do it either. Disabling or deleting the person, revoking the token in Access control, or revoking the app all end its access within the minute. Only salted SHA-256 hashes of the app's tokens are kept.

### Access levels

| Level | Scope | Tools |
| --- | --- | --- |
| Read only | `paperclip:read` | Read tools only. The Proxmox client the app acts through also refuses everything but GET, so a mistake in a tool still can't write. |
| Full control | `paperclip:control` | Read tools plus the control tools below. |

Read tools: `host_status`, `list_machines`, `machine_detail` (credentials stripped), `machine_snapshots`, `storage_overview`, `recent_tasks`, `cluster_status`, `list_organizations`, `org_summary`, `list_agents`, `get_agent`, `list_issues`, `get_issue`, `list_approvals`, `list_goals`, `list_projects`, `org_costs`, `current_time`, `calculate`.

Control tools, engine side (as the person's engine account, only in the organizations they shared): `create_issue`, `comment_issue`, `update_issue`, `wake_agent`, `pause_agent`, `resume_agent`, `decide_approval`, `create_goal`. A task, agent or approval id is looked up first and refused if it belongs to an organization the app wasn't given.

Control tools, host side: `power_machine`, `snapshot_machine`, `delete_snapshot`, `rollback_snapshot`, `propose_plan`. **By default these write a plan** (Pin, Plans in the console) that the person approves one step at a time, with the typed phrase for anything that interrupts a machine, exactly like Pin's own plans. A person may allow an app to **act without asking** (consent page or Connected apps): then starts and snapshots run at once; stopping, rebooting, deleting snapshots and rolling back need the phrase as the `confirm` argument; machines tagged `protected` are refused for destructive steps.

Optional, off until an administrator switches it on: `fetch_url` reads a public https page (public addresses only, 2 MB, 15 seconds).

Every tool call is in the app log (`GET /api/connect/activity`: tool name, outcome, never arguments or results). Control calls are also in the audit trail (`app.tool`), with consent, token, refresh, revoke and update events (`oauth.*`).

## Connections: model services

`GET /api/connect/catalog` lists what ePaperclip can talk to. Hosted: Anthropic, OpenAI, Gemini, OpenRouter (built in), xAI, Mistral, Groq, DeepSeek, Together AI, Fireworks AI, Perplexity, Cerebras, NVIDIA NIM, DeepInfra, Hugging Face, SambaNova, Moonshot, Z.ai. Local: Ollama, LM Studio, llama.cpp, vLLM, Jan, and "Other OpenAI-compatible" for LocalAI, LiteLLM or a company gateway.

- **Addresses.** Hosted providers have a fixed address. A local or custom address is typed by an administrator and checked: `http` only for machines on your own network (loopback, private addresses, `.local`/`.lan` names, single-word names), `https` for anything else, no credentials, query or fragment, and never a cloud metadata address. Note that `localhost` means this Proxmox host; use the address of the machine or container that runs the model.
- **Keys** are write-only and sealed in the vault; local servers need none, and then no credential header is sent. Provider errors are redacted of the key before anyone sees them.
- **Test connection** makes one real request with the stored key (the model list, or a one-token question where a provider has no list) and says in words what happened: wrong key, quota, outage, "couldn't reach Ollama at 10.0.0.9:11434, is it running?". One test every 3 seconds.
- **Model discovery.** Models are read from the service, never written down here. A default model per connection is used for tests and fallbacks.
- **Scopes.** Per connection: switched on or off, whether Pin may use it, and which organizations' agents may use it.
- **Usage and cost.** Pin records calls and tokens per connection and model per day (62 days, no text). Set a price per million tokens on a connection and Usage shows an estimated cost; without one it says "No price set" rather than guessing.
- **Fallbacks.** An ordered chain: when the provider Pin uses is rate-limited, out of quota, overloaded, unreachable or rejects the key, and nothing has been shown yet, Pin tries the next connection with its default model. The answer says which one replied.

Routes (administrators change, anyone signed in reads): `GET/POST /api/connect/connections`, `PATCH/DELETE /api/connect/connections/:id`, `PUT .../:id/key`, `POST .../:id/test`, `GET .../:id/models`, `PUT /api/connect/fallbacks`, `GET /api/connect/usage?days=`.

## Agents' AI accounts, per organization

An organization's owners and admins (the engine enforces it) manage these on the organization's Connectors page.

- **Hand over a key.** `POST /api/connect/orgs/:id/apply/:connection`. The connection must be switched on and shared with that organization. The host sends the sealed key to the engine as the organization's shared AI connection (`ai-connections`, `api_key`) and never shows it. The engine accepts Anthropic, OpenAI, OpenRouter and xAI for agents; other providers say so plainly. The engine has no removal call for these, so removing one is done in the engine.
- **Sign in with a subscription.** `POST /api/connect/orgs/:id/login` `{provider: anthropic | openai, flow?: device | setup-token}`. The **engine runs the provider's own CLI login in a terminal (a PTY) inside the organization's agent container**, found as the environment tagged `agent-containers`; this service never starts a login process and never runs anything on the host (a test greps for it). The person polls `GET .../login/:session`, opens the provider's sign-in address in their own browser, enters the one-time code if there is one (for Claude's setup-token flow they paste the browser's code into `.../code`), and the engine stores the resulting credential in its own secret store. What reaches the browser is rebuilt from an allow-list: status, the sign-in address (https, only on the provider's own hosts, otherwise dropped), the device code, expiry and a redacted message. Fields that look like credentials, raw terminal output and any other address are dropped, and the browser code is never echoed back, even in an error. A person sees only their own sessions; 5 starts per 10 minutes.

Not checked against a real engine (this build has none): the exact fields of the engine's login-session answers (parsed defensively, with the address and code also read out of its terminal text), and whether it accepts `allAgents` for a shared subscription. Both fail visibly, not silently.

## Adapters in the Store

`GET /api/connect/adapters` merges the engine's `/api/adapters` with Paperclip's 15 built-in types (`BUILTIN_ADAPTERS`, kept equal to the engine's API description by a test). Built-in adapters are **verified**; "Enable" switches them on in the engine (`PATCH /api/adapters/:type`), "Disable" off. They can't be removed. Adapters from the **signed marketplace index** (npm, exact version, sha512 integrity) are installed by `POST /api/connect/adapters/install`: the host re-reads the package's integrity from the npm registry and refuses with `integrity_mismatch` unless it is exactly what the catalog was signed for, then asks the engine to install it. Anything else the engine happens to have registered is shown as unverified and can only be removed, never enabled from here. The signed index flow itself is unchanged (`marketplace/README.md`).

## Tools for Pin and agents

Pin keeps its own tools (`docs/PIN.md`); the bridge's tool set above is the same registry of read tools plus the control tools, so what an outside app may do equals what Pin may propose. For the agents themselves, the engine owns tool connections (`/api/companies/{id}/tools/connections`) and plugin tools; wiring this device's MCP endpoint in as an agent tool source is not done here because it can't be tested without a real engine. The safe generic tools (`current_time`, `calculate`, and the admin-gated `fetch_url`) are in the registry for both.

## Console

Settings, Connectors (connections, fallbacks, usage); Settings, Connected apps (address and setup steps for Claude, ChatGPT, Codex and others, the list, level, organizations, act-without-asking, revoke, activity); `/oauth/authorize` (consent); an organization's Connectors page (AI accounts); the Store (adapters).

## Testing

`services/epaperclip/test/connect.test.ts` (OAuth, MCP, tools, revoke, limits), `connect-connections.test.ts`, `connect-login.test.ts`, `connect-adapters.test.ts` with `fakes-connect.ts` (a fake Proxmox, an engine overlay, a fake OpenAI-compatible server); `apps/console/test/connect.test.tsx`. Screenshots: `services/epaperclip/scripts/connect-shots.mts`.
