import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Activity, Archive, Box, Building2, Check, CircleDollarSign, Database, Download, FolderKanban, Gauge, Inbox, ListChecks, ListTree, Network, Package, Plug, Plus, RefreshCw, Repeat, Settings, Sparkles, SquareTerminal, Target, Upload, Users, Vote, Zap } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { usePin, usePinActions } from "./PinContext.tsx";
import type { QuickAction } from "./quickActions.ts";
import { pageOf, suggestionsFor, type IconName } from "./suggestions.ts";

const c = "h-4 w-4";
const ICONS: Record<IconName, ReactNode> = {
  upload: <Upload className={c} />, download: <Download className={c} />, package: <Package className={c} />,
  plus: <Plus className={c} />, box: <Box className={c} />, org: <Building2 className={c} />, task: <ListChecks className={c} />, vote: <Vote className={c} />,
  users: <Users className={c} />, list: <ListChecks className={c} />, gauge: <Gauge className={c} />, terminal: <SquareTerminal className={c} />, tree: <ListTree className={c} />,
  database: <Database className={c} />, archive: <Archive className={c} />, refresh: <RefreshCw className={c} />, network: <Network className={c} />, activity: <Activity className={c} />,
  dollar: <CircleDollarSign className={c} />, settings: <Settings className={c} />, sparkles: <Sparkles className={c} />, check: <Check className={c} />, target: <Target className={c} />,
  folder: <FolderKanban className={c} />, repeat: <Repeat className={c} />, inbox: <Inbox className={c} />, plug: <Plug className={c} />, zap: <Zap className={c} />,
};

/** Pin's suggestions for the page you are on (see suggestions.ts). Pages with something more specific, like a machine, add their own on top. */
export function RouteActions() {
  const { data, readInbox } = useEngine();
  const pin = usePin();
  const nav = useNavigate();
  const loc = useLocation();
  const ref = pageOf(loc.pathname, data.orgs.map((o) => o.slug));
  const s = suggestionsFor(ref, data);
  const items: QuickAction[] = s.items.map((x) => ({
    id: x.id,
    label: x.label,
    icon: ICONS[x.icon],
    group: x.group,
    disabled: x.disabled,
    title: x.title,
    run: () => {
      if (x.action === "read-inbox" && ref.org) readInbox(ref.org);
      else if (x.ask) pin.send(x.ask);
      else if (x.to) nav(x.to.startsWith("?") ? `${loc.pathname}${x.to}` : x.to);
    },
  }));
  usePinActions({ context: s.context, items }, 0);
  return null;
}
