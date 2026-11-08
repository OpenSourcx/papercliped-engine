import { BRAND_ICONS } from "./brandIcons.ts";

/** Generic glyphs, for things that have no vendor mark. They are labelled as generic, never as a vendor's logo. */
export type Glyph = "disc" | "driver" | "app" | "gateway" | "process" | "http" | "skill" | "runner" | "custom";

export type Mark =
  | { kind: "brand"; title: string; path: string; evenodd: boolean }
  | { kind: "image"; title: string; src: string }
  | { kind: "generic"; glyph: Glyph; label: string };

/** Marks that ship as files (colour artwork the SVG-path set can't hold). Slack's comes from Paperclip's vendor artwork (MIT). */
const IMAGES: Record<string, { title: string; src: string }> = {
  slack: { title: "Slack", src: "/brands/slack.svg" },
};

/**
 * Known entries that deliberately show a labelled generic glyph, because no openly licensed official mark exists
 * or the entry is ours (brand authority is the Papercliped kit; no new marks). Anything else known must have a real mark.
 */
export const GENERIC_ENTRIES: Record<string, Glyph> = {
  "windows-11": "disc", "windows-server": "disc",
  paperclip_runner: "runner", openclaw_gateway: "gateway", http: "http", process: "process",
  "update-guardian": "skill", "security-auditor": "skill", "cost-watcher": "skill", "weekly-report": "skill",
};

/** Container-template and TurnKey names to marks, in the order they are tried. */
const APPS: [RegExp, string][] = [[/nextcloud/, "nextcloud"], [/gitea/, "gitea"], [/wordpress/, "wordpress"]];
const DISTROS: [RegExp, string][] = [
  [/ubuntu/, "ubuntu-lts"], [/debian/, "debian"], [/alpine/, "alpine"], [/^arch|archlinux/, "arch"], [/rocky/, "rocky-9"], [/alma/, "alma-9"], [/fedora/, "fedora"], [/opensuse/, "opensuse"], [/centos/, "centos"],
];

const GLYPH_LABEL: Record<Glyph, string> = {
  disc: "installer disc", driver: "driver disk", app: "app", gateway: "gateway", process: "command", http: "web address", skill: "skill", runner: "runner", custom: "custom",
};

const generic = (glyph: Glyph, name: string): Mark => ({ kind: "generic", glyph, label: `${name} (generic ${GLYPH_LABEL[glyph]} icon)` });

/**
 * The mark for a Store item, provider, connection or library entry: its official mark when we ship one, otherwise a
 * labelled generic glyph. Never a letter tile. `id` is a Store id, a provider slug or a "ct:<template>" id.
 */
export function resolveMark(id: string, name: string = id): Mark {
  const key = id.toLowerCase();
  const img = Object.hasOwn(IMAGES, key) ? IMAGES[key] : undefined;
  if (img) return { kind: "image", ...img };
  let b = Object.hasOwn(BRAND_ICONS, key) ? BRAND_ICONS[key] : undefined;
  if (!b && key.startsWith("ct:")) {
    const t = key.slice(3);
    const hit = [...APPS, ...(t.includes("turnkey") ? [] : DISTROS)].find(([re]) => re.test(t));
    if (hit) b = BRAND_ICONS[hit[1]];
    if (!b) return generic(key.includes("turnkey") ? "app" : "disc", name);
  }
  if (b) return { kind: "brand", title: b.title, path: b.path, evenodd: !!b.evenodd };
  const g = Object.hasOwn(GENERIC_ENTRIES, key) ? GENERIC_ENTRIES[key] : undefined;
  return generic(g ?? "custom", name);
}

/** Whether an id gets a vendor's own mark (as opposed to a generic glyph). */
export const hasOfficialMark = (id: string, name?: string): boolean => resolveMark(id, name).kind !== "generic";
