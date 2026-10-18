# PinOS

PinOS is the planned operating system built around Pin: an installer image that installs Proxmox VE's packages and adds the console, Pin and the engine, under its own brand. This page records the decisions so the build stays consistent. It is a plan, not a shipped product: today ePaperclip installs onto an existing Proxmox VE host (`docs/INSTALL.md`).

## Branding rule

PinOS carries no Proxmox branding.

- Proxmox's name and logo are not used in the product, installer, console, website, domains, package names or the command.
- Their logos, installer text, login banner and the :8006 page title are replaced through an overlay package.
- The only mentions are the copyright notices and license texts that the AGPL and Debian require, in an About / Licenses screen and a `NOTICE` file. Those are legal attributions and are never removed.
- The product is described as independent and not endorsed by Proxmox Server Solutions GmbH.

## Licensing, as researched (not legal advice)

| Component | License | What it means for PinOS |
| --- | --- | --- |
| Proxmox VE code | AGPL-3.0-or-later (Proxmox Server Solutions GmbH) | Changes to Proxmox code are published under the AGPL, with source offered, including to users who reach a modified version over a network. Keep our own code a separate program that talks to Proxmox through its API. |
| Paperclip engine | MIT (Paperclip) | Selling and modifying are allowed; keep the copyright and permission notice in copies. Its telemetry is on by default and the installer turns it off. |
| Proxmox name and logo | Registered trademark | Not authorized for product, domain or company names; no use without written permission. |
| Everything else on an image (Debian packages, kernel, firmware, ZFS) | Various | Each needs its notices and a source offer. |

Repositories: Proxmox documents the no-subscription repository as for testing and non-production use, and the enterprise repository, which needs a subscription key, as the production one. A subscription agreement we found (an older copy) treats passing subscription packages to third parties as a breach. So PinOS never ships enterprise-repository access; customers who want it hold their own subscription.

Open questions are in the email to Proxmox (permission for a rebranded distribution, wording of the licensing notices, the default repository, partner options). Nothing is built on an assumed answer.

## Stages

1. **Installer image.** Boot, answer two questions, end up with a host running Pin on :443. Built from Proxmox's installer with its automated-install answer file, our branding overlay and a first-boot step that runs the signed ePaperclip installer.
2. **Pin first.** The console on :443 is the front door. The upstream interface stays on :8006 as the way back in, restyled by the overlay only as far as the branding rule needs.
3. **Own update channel.** An APT repository for PinOS packages, signed with the existing release pipeline, so updates arrive through `apt` and `epaperclip update`.
4. **Hardware and support.** Real-machine testing and a support policy.

## Not decided yet

- The final name (PinOS is the working name; availability on GitHub, npm, domains and trademark search is unchecked).
- Whether any change to Proxmox's own code is needed beyond the overlay.
- The business model (support, a hosted Pin service, paid add-ons under our own license, a marketplace share).
- Whether the image defaults to the no-subscription repository, with a plain "testing only" note, or asks for a key.
