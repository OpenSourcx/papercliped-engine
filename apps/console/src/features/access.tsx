import { ShieldCheck } from "lucide-react";
import { AccessHub } from "../pages/access/AccessHub.tsx";
import type { Feature } from "./registry.ts";

/**
 * Access as a full page in the Access section of the sidebar, the same destination as Settings, Access: people and permissions
 * (users, groups, API tokens, two-factor, roles, realms and resource groups) and remote access (local only, Cloudflare, Papercliped Connect). Live only: the demo has no Proxmox.
 */
export const accessFeature: Feature = {
  id: "access",
  routes: [{ path: "access-control", element: <AccessHub /> }],
  nav: [{ section: "Access", to: "access-control", label: "Access", icon: ShieldCheck, order: 10, liveOnly: true }],
};
