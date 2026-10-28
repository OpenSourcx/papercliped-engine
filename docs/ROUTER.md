# Router

The Router puts every model connection on this device behind one local address. Agents and scripts send requests in their own format, OpenAI's Chat Completions or Anthropic's Messages, with a Router key. The Router picks a connection, translates between the two formats when needed, and moves down the fallback chain when a service is busy, out of credit or down. Provider keys stay in the vault, and no client ever holds one.

It runs inside the ePaperclip host service (`epaperclip.service`), on its own listener. It starts and updates with everything else; nothing extra to install.

The design follows OmniRoute (MIT): one endpoint, fallback chains, a circuit breaker for each connection, and translation between formats. The code is our own. OmniRoute's providers that sign in to consumer chat websites (browser fingerprinting, solving bot challenges) are deliberately not part of it.

## Where it listens

| Setting | Default | |
| --- | --- | --- |
| `EPC_ROUTER_LISTEN` in `/etc/default/epaperclip` | `127.0.0.1:3120` | `host:port`, or `off` |

For now it is reachable from this host only, over plain HTTP on loopback: Pin, the engine and scripts on the host. Agents in containers reach it once the Router learns to listen on the agent bridge (step 2 below). Don't point `EPC_ROUTER_LISTEN` at a public address: the listener has no TLS.

## Keys

An administrator makes a key per client under **Connectors → Router**. The key (`epr_…`) is shown once. Only a SHA-256 hash is stored, and checking a key compares every stored hash, so timing reveals nothing. Revoking a key stops it at once. Making and revoking keys go in the audit log.

Clients send the key the way they already send one:

- `Authorization: Bearer <key>`: OpenAI clients, and Claude Code's `ANTHROPIC_AUTH_TOKEN`
- `x-api-key: <key>`: Anthropic clients, and Claude Code's `ANTHROPIC_API_KEY`

A request with an `Origin` header is refused, so a web page can't use the Router.

## Pointing a client at it

```sh
# Claude Code
export ANTHROPIC_BASE_URL=http://127.0.0.1:3120
export ANTHROPIC_AUTH_TOKEN=epr_...

# OpenAI SDKs and anything that speaks Chat Completions
export OPENAI_BASE_URL=http://127.0.0.1:3120/v1
export OPENAI_API_KEY=epr_...
```

Codex talks OpenAI's newer Responses API by default. The Router doesn't speak that yet, so give Codex a custom provider that uses the Chat Completions wire format, pointing at `http://127.0.0.1:3120/v1` with the Router key. The Responses API is on the list below.

## Endpoints

| | |
| --- | --- |
| `GET /health` | No key needed |
| `GET /v1/models` | The names a client can use. Anthropic's list shape when the request carries `anthropic-version`, otherwise OpenAI's |
| `POST /v1/chat/completions` | OpenAI format in and out, streamed or whole |
| `POST /v1/messages` | Anthropic format in and out, streamed or whole |
| `POST /v1/messages/count_tokens` | An estimate (about four characters per token), for clients that ask before sending |

Errors come back in the client's own format, with the status the client expects.

## Choosing a connection

The `model` a client sends decides where the request goes first:

| `model` | Goes to |
| --- | --- |
| `auto` | The fallback chain, each connection with its default model |
| `<connection>/<model>` | That connection: `deepseek/deepseek-chat`, `x:ollama/llama3.1`, `openrouter/anthropic/claude-sonnet-4` |
| `claude-…`, `gpt-…`, `o3…`, `gemini-…` | The provider that makes it, if connected |
| Another name | The connection whose default model it is |

After that comes the rest of the chain, each with its default model. So Claude Code, which always names a Claude model, is still answered by DeepSeek or a local model when Anthropic isn't connected. A name that matches no connection goes straight to the chain.

Only connections that are switched on and have a key (or need none) are used. The chain is the one under **Connectors → If a provider can't answer**, shared with Pin.

## Passing through and translating

- **Same format** (an Anthropic client to Anthropic, an OpenAI client to an OpenAI-compatible service): the request goes through untouched except for `model` and the credential. Provider features survive: thinking, prompt caching, `anthropic-beta` headers, sampling options. The answer comes back byte for byte, read alongside only to count tokens.
- **Different formats**: the request is translated, and the answer is always streamed from the provider, then turned back into the client's format.
  - Covered: the system prompt, instructions in the middle of a conversation (Claude Code sends these), text, images, tools, tool calls, tool results, `tool_choice`, stop sequences, `max_tokens`, temperature and usage.
  - Anthropic's server tools (web search and the like) are dropped, because only Anthropic can run them.
- **Gemini** is reached through its OpenAI-compatible address, which also gives it tools.

## Falling back and resting

- **What triggers a fallback.** A connection is skipped for the next one when:
  - it can't be reached, or doesn't send headers within 120 seconds
  - it answers 401, 402, 403, 404, 408, 409, 425, 429, 5xx or 529
  - it answers 400 about tools or the model

  Any other 400 is the request's own fault, and it goes back to the client.
- **Only before the answer starts.** Fallback happens only before any of the answer has been sent.
- **Resting.**
  - A 429 rests the connection for its `Retry-After` (30 seconds without one, five minutes at most).
  - Three failures in a row rest it for a minute.
  - A resting connection is skipped unless nothing else is left.
  - The console shows what is resting.

## Limits

- 32 requests at once, 12 per key
- Request bodies up to 20 MB
- A client that sends nothing for 10 minutes is dropped

## What is recorded

- **Usage.** Calls and tokens go into the same ledger as Pin's, per connection and model (**Connectors → Usage**), with an estimated cost where a price is set.
- **Activity log.** Each request is logged under the `router` source: key name, connection, model, whether it was translated, time and token counts. Never any text.

## Managing it (console API)

Administrators only, signed in (not with an API token):

- `GET /api/router`: address, models, resting connections, keys (never the keys themselves)
- `POST /api/router/keys` `{ name }` → `{ key, view }`
- `DELETE /api/router/keys/:id`

## Next steps

1. **Agents use it.** Listen on the agent bridge as well, with keys made per organization and agent. Agents in every organization get `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` and their own key through the Vault.
2. **Budgets and routes.** Monthly caps per organization and per agent. Named routes ("everyday work: DeepSeek, then Kimi"). A "test with a tool call" check before a model can join a route.
3. **OpenAI's Responses API** (`/v1/responses`), so Codex works with its defaults.
4. **Pin through the Router.** Pin already uses the same connections, chain and ledger. Sending its calls through the Router as well would add resting connections to Pin.
