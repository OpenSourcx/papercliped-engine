# Signing agents in: your account or an API key

Agents run harness programs (Claude Code, Codex, Gemini CLI, OpenCode, MiMo Code, Pi, Grok) inside the organization's agent container. Each harness needs a credential. There are two ways to give it one, and an API key always wins over a signed-in account:

| | Account | API key |
| --- | --- | --- |
| Claude Code | Settings → Agent sign-in → Claude Code. Open the page, sign in, paste the code Claude shows. Stored as the organization's `CLAUDE_CODE_OAUTH_TOKEN` secret. | `ANTHROPIC_API_KEY` |
| Codex | Open the page, enter the code shown here. Stored as the Codex login (`CODEX_HOME`). | `OPENAI_API_KEY` |
| Grok | Same device-code flow. | `XAI_API_KEY` |
| Gemini CLI | none (Paperclip has no sign-in for it) | `GEMINI_API_KEY` |
| OpenCode, Pi, MiMo Code | none | the provider's key (`OPENROUTER_API_KEY`, ...) |

For an API key, press **Use an API key** next to the harness in Settings → Agent sign-in. The key is saved in the Vault under the variable above and shared with that organization's agents of that harness (a blank key field keeps the one already saved; **Stop using it here** removes only this organization). It is sealed on the device; agents get it as a secret reference, never the value. Only Proxmox administrators can add keys.

## How the sign-in works

1. The console asks the engine to start a login for the organization's container (`/engine/api/companies/{id}/setup-token-login-sessions` for Claude, `/adapters/{type}/login-sessions` for Codex and Grok).
2. The engine asks our sandbox provider to open a real terminal in the container (`onLoginPtyOpen`, over `ssh -tt`) and run one fixed command in a throwaway home: `claude setup-token`, `codex login --device-auth` or `grok login --device-auth`. The engine sends only a key, never a command line, and the home must be `/tmp/paperclip-adapter-login/<uuid>`.
3. The console shows the sign-in page address (and the code, for device logins). The person opens it in a new tab and approves.
4. The engine reads the credential back from the container and keeps it as an encrypted secret bound to the organization. It is never sent to the browser.
5. Closing the window before the end cancels the session, so the next try isn't blocked.

Needs: agent containers set up (Settings → Agent containers) with a template that has the harness installed (`plugins/proxmox-sandbox/template`), and a Proxmox administrator or board member for the organization.

## Limits

- Account sign-in is per organization, not per agent.
- A pasted code and a device code travel through the engine; use https for the console (the engine adds an advisory when the transport isn't confidential).
- If the provider changes its sign-in screens, the engine's parser can fail and the sign-in times out; use an API key then.

## One credential for every agent (Connectors)

Paperclip ties a model connection to one company (personal or shared with the organization). On a device that is awkward, so Connectors → **Use for all agents** (Anthropic, OpenAI) saves one credential in the Vault and shares it with every agent of that harness in every organization:

- Anthropic: a Claude subscription token (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token` run on the person's own computer) or an API key (`ANTHROPIC_API_KEY`). OpenAI: `OPENAI_API_KEY`.
- No organization or container is needed to save it. Agents read it as an environment variable on their next run.
- The Vault shares by agent, so agents created later need the share refreshed: open the same dialog and press **Share with new agents** (the field can stay blank).
- Per-organization account sign-in in the agent container (Settings → Agent sign-in) remains for Codex and Grok accounts.

## Pin and containers that ask for a login

Pin runs commands in a container through its console. A console that asks for a login blocks that. `set_machine_config` accepts `console_mode: "shell"` (Proxmox `cmode`), which opens the console straight into a root shell; restart the container afterwards. Pin's error says this when it meets a login prompt.
