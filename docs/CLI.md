# The `epaperclip` command

Two commands cover everything: one for the Proxmox host, one for any machine that should run work for it.

## On your Proxmox host

```
sudo npx epaperclip setup        # or, once installed:  epaperclip setup
```

`setup` goes in four steps and asks before it changes anything:

1. **Checks the host** (`epaperclip doctor` does only this): Proxmox version, memory, free disk, internet, whether a ZFS pool exists (fast sandboxes, see FAST-STORAGE.md) and whether the private sandbox network exists. A line marked `no` stops the run; `check` is advice.
2. **Private network** for agent containers (`vmbr1`, NAT), created with your yes.
3. **Installs** the newest signed release (the signature is verified before anything runs).
4. **Checks it answers**, then prints what to do next: sign in at `https://<host>/`, let Agent Containers set itself up, create an organization, connect a Claude or Codex account, give Pin a task.

Day to day: `epaperclip status`, `update`, `rollback`, `uninstall [--purge]`, `device status|logs|restart`.

## On a worker machine (Linux or macOS)

```
npm install -g epaperclip-worker
epaperclip-worker connect
```

`connect` looks at the machine, asks who sets it up (Pin with your approval each time, or you running the commands Pin shows), asks for the code from **Workers → Add worker** in the console, connects out (no port is opened) and waits for you to approve it. Pin then guides the rest in the console: installing Ollama, choosing a model that fits, verifying the result. Pass `--mode pin|self`, `--name NAME` or the code on the command line to skip questions.

## What is not done yet

- Both npm packages and an `apt install epaperclip` repository need the project's release signing key and npm account to publish; until then use the pinned from-source install in SETUP-PROXMOX.md.
- `setup` and `connect` are covered by tests only where noted in the pull request; they have not yet been run on a fresh Proxmox host or a Mac.
