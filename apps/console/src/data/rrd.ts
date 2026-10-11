import type { RrdCf, RrdPoint, RrdTimeframe } from "@papercliped-engine/proxmox-client";

/**
 * Demo usage history in the exact shape Proxmox returns from `.../rrddata` (see proxmox-client's RrdPoint), so the
 * graphs stay the same when they switch to the broker's /v1/stats endpoints.
 */

export const TIMEFRAMES: { id: RrdTimeframe; label: string; stepSec: number }[] = [
  { id: "hour", label: "Hour", stepSec: 60 },
  { id: "day", label: "Day", stepSec: 30 * 60 },
  { id: "week", label: "Week", stepSec: 3 * 3600 },
  { id: "month", label: "Month", stepSec: 12 * 3600 },
  { id: "year", label: "Year", stepSec: 7 * 86400 },
];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RrdBase {
  cpu: number; // fraction of maxcpu, typical
  maxcpu: number;
  mem: number;
  maxmem: number;
  net: number; // bytes/s typical
  disk: number; // bytes/s typical
  running: boolean;
}

export function demoRrd(seed: number, timeframe: RrdTimeframe, cf: RrdCf, base: RrdBase, nowSec = Math.floor(Date.now() / 1000), points = 60): RrdPoint[] {
  const tf = TIMEFRAMES.find((t) => t.id === timeframe)!;
  const rand = rng(seed * 31 + tf.stepSec);
  const peak = cf === "MAX" ? 1.35 : 1;
  const out: RrdPoint[] = [];
  let walk = 0;
  const end = nowSec - (nowSec % tf.stepSec);
  for (let i = 0; i < points; i++) {
    const time = end - (points - 1 - i) * tf.stepSec;
    walk = Math.max(-0.6, Math.min(0.6, walk + (rand() - 0.5) * 0.25));
    const spike = rand() > 0.9 ? 1 + rand() * 0.8 : 1;
    if (!base.running) {
      out.push({ time, cpu: 0, maxcpu: base.maxcpu, mem: 0, maxmem: base.maxmem, netin: 0, netout: 0, diskread: 0, diskwrite: 0 });
      continue;
    }
    const f = (1 + walk) * spike * peak;
    out.push({
      time,
      cpu: Math.min(1, base.cpu * f),
      maxcpu: base.maxcpu,
      mem: Math.min(base.maxmem, base.mem * (1 + walk * 0.15)),
      maxmem: base.maxmem,
      netin: base.net * f * (0.6 + rand() * 0.8),
      netout: base.net * 0.4 * f * (0.6 + rand() * 0.8),
      diskread: base.disk * f * (rand() > 0.7 ? 2 : 0.4),
      diskwrite: base.disk * 0.7 * f * (0.5 + rand()),
      loadavg: base.cpu * base.maxcpu * f,
      iowait: 0.002 + rand() * 0.01 * spike,
    });
  }
  return out;
}
