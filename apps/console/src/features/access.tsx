import { ShieldCheck } from "lucide-react";
import { LiveAccess } from "../pages/access/LiveAccess.tsx";
import type { Feature } from "./registry.ts";

/**
 * Access control as a full page in the Access section of the sidebar: users, groups, API tokens, two-factor, roles and
 * permissions, realms and resource groups. The same screen opens from Settings. Live only: the demo has no Proxmox.
 */
export const accessFeature: Feature = {
  id: "access",
  routes: [{ path: "access-control", element: <LiveAccess /> }],
  nav: [{ section: "Access", to: "access-control", label: "Access control", icon: ShieldCheck, order: 10, liveOnly: true }],
};
