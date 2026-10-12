# epaperclip

Installs [ePaperclip](https://github.com/OpenSourcx/papercliped-engine) on a Proxmox VE host: a console on port 443 that people sign in to with their Proxmox accounts, and its engine (Paperclip) as a locked-down service on loopback. Proxmox's own web interface on port 8006 is never changed.

In the Proxmox host's shell, as root:

```sh
npx epaperclip install
```

or `npm install -g epaperclip`, then `epaperclip install`.

| Command | Does |
| --- | --- |
| `epaperclip install` | install, or upgrade to this package's version |
| `epaperclip status` | version, whether both services run and answer, where the data is |
| `epaperclip rollback` | go back to the previous version |
| `epaperclip uninstall` | remove it, keeping data and settings (`--purge` removes those too) |

This package carries the same installer as the release download and the Debian package. It checks the host first and changes nothing if something is missing. It brings its own pinned, checksum-verified Node.js and installs the engine from its lockfile, so it needs internet access. It test-starts everything and rolls back by itself if the new version doesn't come up. Node.js on the host is only used to start this command.

Requirements: Proxmox VE 8 or newer, 4 GB of memory recommended (2 GB minimum), about 3 GB of free disk. Full guide: [docs/INSTALL.md](https://github.com/OpenSourcx/papercliped-engine/blob/main/docs/INSTALL.md).

MIT licensed.
