# The system vault

Variables and secrets that belong to the whole host, not to one organization: a GitHub token, a deploy key, a cloud API key. An administrator adds each once; it is sealed on the host (AES-256-GCM, the same vault that holds model API keys) and is never shown again.

Each variable is either:

- **Pin only**: Pin knows it exists and what it is for, and no organization sees it.
- **Selected CEOs**: the CEO agents an administrator picks, in any organization.

## Who can use it

Only Proxmox administrators (`Sys.Modify` on `/`). The console page is Settings → Vault. Values are write-only: no route, tool or model sees one. Pin can list names and descriptions (`vault_list`), because a value sent to Pin would be sent to a model provider.

## The CEO picker

The console asks `GET /api/vault/ceos`, which looks at every organization the engine has and returns its CEO agents. An organization without a CEO adds nothing; with no CEOs anywhere the picker is empty and shows nothing to choose.

## How sharing works in Paperclip

Paperclip has no instance-wide variables. Its secrets belong to one company, and an agent's environment points at one with a `secret_ref`. So for each organization that has a chosen CEO, ePaperclip:

1. creates a company secret named `VAULT_<NAME>` (or rotates its value when the vault value changes),
2. sets `env.<NAME>` to `{ type: "secret_ref", secretId }` on each chosen CEO's adapter config, and removes it from any other agent that had it from us.

Unchoosing a CEO, switching to Pin only, or deleting the variable undoes this. A delete that can't take the variable out of every organization is refused, so nothing stays shared and forgotten.

## Routes

| Route | |
| --- | --- |
| `GET /api/vault` | variables without values, and whether you may manage them |
| `POST /api/vault` | `{ name, value, description?, share: "pin"\|"ceos", targets?: [{companyId, agentId}] }` |
| `PATCH /api/vault/:id` | change value, description or sharing |
| `DELETE /api/vault/:id` | remove here and from every organization |
| `GET /api/vault/ceos` | the CEO picker |
| `POST /api/vault/sync` | write every share again |

Names are environment-variable names (`GITHUB_TOKEN`); names that change how programs start (`PATH`, `LD_*`, `NODE_OPTIONS`) are refused.
