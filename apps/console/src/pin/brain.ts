import { describeRule, validateRule, type Rule } from "@papercliped-engine/automations";
import { formatBytes, slugify } from "../lib/storage.ts";
import type { EngineData, HostMetrics, PinMode } from "../data/types.ts";

/**
 * Pin's demo brain. With no AI account connected it understands a few kinds of request by pattern, so the console can
 * be tried end to end. Automations go through the real rule validator and read-back from @papercliped-engine/automations:
 * the same path the model-backed Pin will use, where the model only drafts the rule and the validator decides.
 */

export type PinCard =
  | { type: "rule"; rule: Rule; readBack: string }
  | { type: "org"; name: string; size: { cores: number; memoryMb: number; diskGb: number; maxGuests: number }; why: string }
  | { type: "status" }
  | { type: "link"; label: string; to: string };

export interface PinReply {
  text: string;
  card?: PinCard;
}

interface Ctx {
  host: HostMetrics;
  data: EngineData;
  mode: PinMode;
  device: string;
}

const METRIC: [RegExp, Rule["when"]["metric"]][] = [
  [/\b(memory|ram|mem)\b/, "memory_percent"],
  [/\b(cpu|processor|compute)\b/, "cpu_percent"],
  [/\b(disk|storage|space)\b/, "disk_percent"],
];
const ACTION: [RegExp, Rule["then"]["action"]][] = [
  [/\bshut(\s*it)?\s*down\b|\bshutdown\b|\bturn (it )?off\b/, "shutdown"],
  [/\bsnapshot\b/, "snapshot"],
  [/\bstop\b|\bkill\b/, "stop"],
  [/\b(notify|tell|alert|warn|ping)\b/, "notify"],
  [/\bstart\b|\bturn (it )?on\b/, "start"],
];

export function draftRule(input: string): { ok: true; rule: Rule; readBack: string } | { ok: false; reason: string } | null {
  const t = input.toLowerCase();
  if (!/^\s*(if|when|whenever)\b/.test(t)) return null;
  const metric = METRIC.find(([re]) => re.test(t))?.[1];
  const pct = t.match(/(\d{1,3}(?:\.\d+)?)\s*(%|percent)/);
  const action = ACTION.find(([re]) => re.test(t.split(/,|\bthen\b/).slice(1).join(" ") || t))?.[1];
  if (!metric || !pct || !action) return { ok: false, reason: "I need a metric (memory, CPU or disk), a percentage, and what to do (shut down, stop, snapshot or notify)." };
  const op: Rule["when"]["op"] = /\b(less than|below|under|drops? below)\b/.test(t) ? "<" : /\bat least\b/.test(t) ? ">=" : ">";
  const guestType = /\b(container|containers|lxc|ct)\b/.test(t) ? "lxc" : /\b(vm|vms|virtual machine)\b/.test(t) ? "qemu" : "any";
  const dur = t.match(/for (\d+)\s*(seconds?|secs?|s|minutes?|mins?|m)\b/);
  const forSeconds = dur ? Number(dur[1]) * (dur[2].startsWith("m") ? 60 : 1) : 60;
  const value = Number(pct[1]);
  const v = validateRule({
    id: slugify(`${metric.split("_")[0]}-${op === "<" ? "under" : "over"}-${value}-${action}`).slice(0, 60),
    name: input.trim().replace(/^\w/, (c) => c.toUpperCase()).slice(0, 150).replace(/[^\p{L}\p{N} _.,:;%()'"/+-]/gu, ""),
    when: { metric, op, value, forSeconds },
    scope: { guestType },
    then: { action },
    createdBy: "pin",
  });
  if (!v.ok) return { ok: false, reason: v.errors.join(" ") };
  return { ok: true, rule: v.rule, readBack: describeRule(v.rule) };
}

/** Pin sizes a new org from what the host has left: a quarter of free memory and half of free cores, within sane bounds. */
export function suggestSize(host: HostMetrics, data: EngineData) {
  const allocatedCores = data.orgs.reduce((s, o) => s + o.resourceGroup.cores, 0);
  const allocatedMem = data.orgs.reduce((s, o) => s + o.resourceGroup.memoryMb, 0);
  const freeCores = Math.max(1, host.cpus - allocatedCores);
  const freeMemMb = Math.max(1024, host.memTotal / 1024 ** 2 - allocatedMem - host.memUsed / 1024 ** 2 * 0.5);
  return {
    cores: Math.max(1, Math.min(4, Math.floor(freeCores / 2))),
    memoryMb: Math.max(1024, Math.min(8192, Math.floor(freeMemMb / 4 / 512) * 512)),
    diskGb: 40,
    maxGuests: 3,
  };
}

export function think(input: string, ctx: Ctx): PinReply {
  const t = input.toLowerCase().trim();

  const rule = draftRule(input);
  if (rule?.ok) {
    return {
      text: ctx.mode === "assistant"
        ? "Here's the automation I'd set up. You're in Assistant mode, so when it fires I'll ask you before acting."
        : "Here's the automation. You're in Agent mode, so when it fires I'll act right away and tell you after.",
      card: { type: "rule", rule: rule.rule, readBack: rule.readBack },
    };
  }
  if (rule && !rule.ok) return { text: `I couldn't turn that into an automation yet. ${rule.reason}` };

  const org = input.match(/\b(?:create|make|set up|start|spin up)\s+(?:an?\s+)?(?:new\s+)?(?:company|org|organization)\s*(?:called|named|for)?\s*["“]?([\p{L}\p{N}][\p{L}\p{N} .&'-]{0,40}?)["”]?\s*$/iu);
  if (org) {
    const size = suggestSize(ctx.host, ctx.data);
    return {
      text: `I can set up ${org[1]} with its own resource group. I sized it from what's free on ${ctx.device}.`,
      card: { type: "org", name: org[1], size, why: `${ctx.host.cpus} CPUs and ${formatBytes(ctx.host.memTotal)} on this device; existing orgs already reserve ${ctx.data.orgs.reduce((s, o) => s + o.resourceGroup.cores, 0)} cores.` },
    };
  }

  if (/\b(status|health|how('s| is) (my |the )?(server|system|machine|device|box)|overview)\b/.test(t)) {
    const working = ctx.data.orgs.flatMap((o) => o.agents).filter((a) => a.status === "working").length;
    const running = ctx.data.guests.filter((g) => g.status === "running").length;
    return { text: `${ctx.device} is healthy. CPU is at ${ctx.host.cpuPct.toFixed(0)}%, memory ${formatBytes(ctx.host.memUsed)} of ${formatBytes(ctx.host.memTotal)}. ${running} guests are running and ${working} agents are working.`, card: { type: "status" } };
  }

  if (/\bupdates?\b|\bupgrade\b/.test(t)) {
    const u = ctx.data.notices.find((n) => n.kind === "update");
    return u
      ? { text: `${u.title}. ${u.body}`, card: { type: "link", label: "Open updates", to: `/${ctx.device}/updates` } }
      : { text: "Everything is up to date. I check Proxmox and Paperclip releases daily and will tell you when something lands." };
  }

  if (/\b(idle|which agents|agents (are )?(working|running))\b/.test(t)) {
    const lines = ctx.data.orgs.map((o) => {
      const w = o.agents.filter((a) => a.status === "working").map((a) => a.name);
      return `${o.name}: ${w.length ? `${w.join(", ")} working` : "idle"}`;
    });
    return { text: lines.join(". ") + "." };
  }

  if (/\b(access|permission|user|policy|policies)\b/.test(t)) {
    return { text: "Access is managed in Integrated Access Control: every ePaperclip user is also a Proxmox user, and policies apply to both.", card: { type: "link", label: "Open access control", to: `/${ctx.device}/access` } };
  }

  if (/\b(hi|hello|hey)\b/.test(t)) return { text: "Hi! I look after this device. Ask me for a status check, to create an organization, or to set up an automation like \"if a container uses more than 50% of its memory, shut it down\"." };

  return {
    text: "I'm running in demo mode, without an AI account, so I only understand a few things for now: status checks, creating organizations, updates, and automations that start with \"if\" or \"when\". Connect an AI account in Connectors and I can do much more.",
  };
}
