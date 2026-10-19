# Activity and status

What ePaperclip and Pin are doing, so a failure can be seen without the browser: in the service's journal, and through two routes for administrators and scripts.

```sh
journalctl -u epaperclip -f                 # live, one line per event
curl -sk -H "Authorization: Bearer $TOKEN" https://pve:443/api/status
curl -sk -H "Authorization: Bearer $TOKEN" "https://pve:443/api/activity?source=pin&level=warn"
```

The caller must be a Proxmox administrator (`Sys.Modify` on `/`), signed in to the console or holding an API token that acts as one.

## What is recorded

Names, codes, counts and timings. Never what anyone said: no prompts, answers, tool arguments or results, and no keys (anything key-like in an outside error message is replaced with `[key]`). The last 500 events are kept in memory and every event is also printed to the journal; a restart starts a fresh list, the journal keeps the history.

| Event | When |
| --- | --- |
| `pin.chat.start` | A chat begins: provider, model, mode, whether it is saved, how many messages it carries |
| `pin.model.call` | A request goes to the model. A call with no `pin.model.turn` after it is a model that has not answered yet |
| `pin.model.turn` | The model answered: milliseconds, tool calls asked for, tokens |
| `pin.model.retry` / `failed` / `fallback` / `quiet` | A rate limit being waited out, a failure and why, a fallback model used, a model that said nothing after its tools |
| `pin.tool` | A tool ran: its name and how long it took, or why it failed |
| `pin.chat.done` / `error` / `stopped` / `crash` | How the chat ended, with total time, steps and tool calls |
| `engine.*`, `host.start`, `proxmox.error`, `http.error`, `http.crash` | The engine starting, Proxmox refusing a call, a server fault, with the route |

## `GET /api/activity`

Query: `source` (`pin`, `engine`, `host`), `level` (the lowest wanted: `info`, `warn`, `error`), `event` (a prefix such as `pin.model`), `after` (an event number from an earlier read), `since` (milliseconds), `limit` (1 to 500, default 100). Returns `{ events, latest, now }`, oldest first; pass `latest` as `after` to follow along.

## `GET /api/status`

One answer for "is it all right?": the installed version and uptime, the engine's state, and for Pin the last hour (chats, answered, failed, stopped, retries, fallbacks, tool failures, errors by code), the median and slowest model answer, how many chats are in flight, the last chat's model and mode, the last error, and the latest warnings and errors from anywhere.
