import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { disksFeature } from "./disks.tsx";
import { nodeFeature } from "./node.tsx";
import { accessFeature } from "./access.tsx";
import { clusterFeature } from "./cluster.tsx";
import { notesFeature } from "./notes.tsx";
import { diskClusterFeature } from "./diskcluster.tsx";

/**
 * Where new console areas go. A feature is one file in this folder exporting a Feature; adding it to FEATURES below is
 * the only change needed elsewhere (routes and sidebar entries are generated from it), so areas can be built side by
 * side. Pages follow DESIGN.md: tokens only, shared primitives, calm copy, and live mode never shows invented data.
 */
export interface FeatureRoute {
  /** Path under /<device>/, for example "disks" or "cluster/ha". */
  path: string;
  element: ReactNode;
}

export interface FeatureNav {
  /** Which sidebar group the entry lives in. "Datacenter" is the cluster-wide group; "Host" is this node. */
  section: "Datacenter" | "Host" | "Access";
  /** Path under /<device>/ the entry links to. */
  to: string;
  label: string;
  icon: LucideIcon;
  /** Sort order within the group (lower first). */
  order?: number;
  /** Live only: hide the entry in the demo, which has no host behind it. */
  liveOnly?: boolean;
}

export interface Feature {
  id: string;
  routes: FeatureRoute[];
  nav: FeatureNav[];
}

export const FEATURES: Feature[] = [disksFeature, nodeFeature, accessFeature, clusterFeature, notesFeature, diskClusterFeature];

/** Top-level paths features own, so an organization can never take one as its address. */
export const featurePaths = (): string[] => FEATURES.flatMap((f) => f.routes.map((r) => r.path.split("/")[0]));
