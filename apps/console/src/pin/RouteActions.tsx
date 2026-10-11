import { useLocation, useNavigate } from "react-router-dom";
import { Activity, Archive, Box, CircleDollarSign, Database, Gauge, ListChecks, ListTree, Network, Plus, RefreshCw, Settings, Sparkles, SquareTerminal, Users, Vote } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { modalHref, settingsHref } from "../modals/useModals.ts";
import { usePin, usePinActions } from "./PinContext.tsx";
import type { QuickActions } from "./quickActions.ts";

/** Pin's default quick actions for the area you are in. Pages with something more specific (a machine) override them. */
export function RouteActions() {
  const { setup, data } = useEngine();
  const pin = usePin();
  const nav = useNavigate();
  const loc = useLocation();
  const d = setup?.deviceName ?? "pve";
  const org = data.orgs.find((o) => o.slug === loc.pathname.split("/")[2]);
  const i = (n: number) => `h-4 w-4 ${n}`.trim();

  let actions: QuickActions;
  if (org) {
    const b = `/${d}/${org.slug}`;
    const pending = org.approvals.filter((a) => a.status === "pending").length;
    actions = {
      context: org.name,
      items: [
        { id: "new-task", label: "New task", icon: <Plus className={i(0)} />, run: () => nav(`${b}/tasks?new=1`) },
        { id: "decisions", label: pending ? `Decisions (${pending})` : "Decisions", icon: <Vote className={i(0)} />, run: () => nav(`${b}/decisions`) },
        { id: "agents", label: "Agents", icon: <Users className={i(0)} />, run: () => nav(`${b}/agents`) },
        { id: "machines", label: "Machines", icon: <Box className={i(0)} />, run: () => nav(`${b}/machines`) },
        { id: "tasks", label: "Tasks", icon: <ListChecks className={i(0)} />, run: () => nav(`${b}/tasks`), more: true },
        { id: "org", label: "Org chart", icon: <Network className={i(0)} />, run: () => nav(`${b}/org`), more: true },
        { id: "costs", label: "Costs", icon: <CircleDollarSign className={i(0)} />, run: () => nav(`${b}/costs`), more: true },
        { id: "activity", label: "Activity", icon: <Activity className={i(0)} />, run: () => nav(`${b}/activity`), more: true },
        { id: "settings", label: "Settings", icon: <Settings className={i(0)} />, run: () => nav(`${b}/settings`), more: true },
        { id: "ask", label: `Ask Pin about ${org.name}`, icon: <Sparkles className={i(0)} />, run: () => pin.send(`Which agents are idle?`), more: true },
      ],
    };
  } else {
    actions = {
      context: d,
      items: [
        { id: "shell", label: "Host shell", icon: <SquareTerminal className={i(0)} />, run: () => nav(`/${d}/shell`) },
        { id: "resources", label: "Resources", icon: <ListTree className={i(0)} />, run: () => nav(`/${d}/resources`) },
        { id: "summary", label: "Summary", icon: <Gauge className={i(0)} />, run: () => nav(`/${d}/summary`) },
        { id: "new-org", label: "New organization", icon: <Plus className={i(0)} />, run: () => nav(modalHref("new-org")) },
        { id: "machines", label: "Machines", icon: <Box className={i(0)} />, run: () => nav(`/${d}/machines`), more: true },
        { id: "storage", label: "Storage", icon: <Database className={i(0)} />, run: () => nav(`/${d}/storage`), more: true },
        { id: "backups", label: "Backups", icon: <Archive className={i(0)} />, run: () => nav(`/${d}/backups`), more: true },
        { id: "updates", label: "Updates", icon: <RefreshCw className={i(0)} />, run: () => nav(settingsHref("updates")), more: true },
        { id: "ask", label: "How is my server?", icon: <Sparkles className={i(0)} />, run: () => pin.send("How is my server?"), more: true },
      ],
    };
  }
  usePinActions(actions, 0);
  return null;
}
