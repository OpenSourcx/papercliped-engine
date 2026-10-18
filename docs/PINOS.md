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

- Nothing about the name: **the name is PinOS** (decided). The name check below found an existing product called pinOS; the decision was made knowing that, and the steps under "Name risk" are how we reduce it.
- Whether any change to Proxmox's own code is needed beyond the overlay.
- The business model (support, a hosted Pin service, paid add-ons under our own license, a marketplace share).
- Whether the image defaults to the no-subscription repository, with a plain "testing only" note, or asks for a key.

## Name check: "PinOS" (October 2026, not a trademark search)

- **A product already uses the name.** Pintexx GmbH sells **pinOS**, a Linux-based thin-client operating system that boots to a configured web address. It is an operating system with the same name, which is the strongest reason to pick another name or get advice first. Its trademark status is unknown: the vendor's page could not be read from here.
- **Other results:** none for an exact "PinOS" product or trademark. Near names exist ("Pintos", a teaching kernel; "PINO", a trademarked robot platform; "PINN", a Raspberry Pi installer), which matter for search results and confusion more than for ownership.
- **npm:** `pinos`, `pin-os` and `pinos-dev` are not on the registry (404), and no `@pinos` scope was found.
- **GitHub:** could not be checked from here (the API refused the request); check `github.com/pinos` and `github.com/pin-os` by hand.
- **Domains:** `pinos.com`, `.dev`, `.org`, `.net` and `pin-os.com` are registered. `pinos.org` shows a renew period, so it may free up. `pinos.io`, `.co`, `.app` and `.sh` returned "not found" from the registry lookup, which suggests they are unregistered, but a lookup is not a purchase; confirm at a registrar. `pinos.ai` could not be checked (rate limited).
- **Not done:** a real trademark search (USPTO, EUIPO and others). Do that, or pay for one, before spending on branding.

If the name changes, `docs/PINOS.md` is the only place that assumes it.

## Licensing finding for any bundled image

The engine's dependency tree contains two packages under their own, non-open-source terms (`@anthropic-ai/claude-agent-sdk` and `@cursor/sdk`, both declared as "SEE LICENSE IN ..."), and the sharp image library's libvips builds under the LGPL. Today the installer fetches them from npm on the host, so our downloads do not redistribute them. An image that bundles `node_modules` would, and then those terms must be read and followed. `NOTICE` and the generated `THIRD_PARTY_LICENSES.md` record this.

## Name risk (PinOS is the chosen name)

An existing Linux thin-client product is called pinOS (Pintexx GmbH). Using the same name for another operating system carries a real chance of a complaint or a refused trademark registration. Steps that cost little now and a lot later:

1. Run a trademark search (USPTO, EUIPO, UKIPO) for "PinOS" and "Pin OS" in the software and operating-system classes, before any paid branding or a launch. Ask a trademark lawyer to read the result.
2. Look at Pintexx's actual product, market and any registrations, so we know how close the overlap is (a thin client for enterprise workplaces versus a Proxmox-based agent host).
3. Always show the name with its purpose ("PinOS, the Pin host for AI agents") and a different logo and colors than theirs; never position it as a thin client or a workplace product.
4. Register what is free early (the domains marked unregistered, the npm name, the GitHub organization) so a rename is not forced by a squatter.
5. Keep the product name in one place in the code (`docs/PINOS.md` today, a brand constant later) so a rename stays a day of work.
