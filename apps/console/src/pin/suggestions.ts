import type { EngineData } from "../data/types.ts";

/**
 * What Pin suggests on each page, like the toolbar Proxmox shows above each panel, but scoped to where you are.
 * Pure data, so every page's suggestions can be tested: RouteActions turns them into buttons.
 *
 *  - "do"  acts on this page (create, review, start). The first three fill the island's row.
 *  - "ask" hands Pin a question about what you're looking at.
 *  - "go"  jumps to a related page. Never the page you're on.
 */

export type IconName = "shield" | "upload" | "download" | "package" | "plus" | "box" | "org" | "task" | "vote" | "users" | "list" | "gauge" | "terminal" | "tree" | "database" | "archive" | "refresh" | "network" | "activity" | "dollar" | "settings" | "sparkles" | "check" | "target" | "folder" | "repeat" | "inbox" | "plug" | "zap";

export interface Suggestion {
  id: string;
  label: string;
  icon: IconName;
  group: "do" | "go" | "ask";
  to?: string; // a path, or "?modal=..." to open a modal over the page
  ask?: string;
  action?: "read-inbox";
  disabled?: boolean;
  title?: string;
}

export interface PageRef {
  device: string;
  org: string | null; // org slug when inside an organization
  page: string; // "home", "machines", "machine", "tasks", "" (org dashboard), ...
}

export function pageOf(pathname: string, orgSlugs: string[]): PageRef {
  const [, device = "pve", a = "home", b = "", c = ""] = pathname.split("/");
  if (orgSlugs.includes(a)) return { device, org: a, page: b === "machines" && c ? "machine" : b };
  return { device, org: null, page: a === "machines" && b ? "machine" : a === "storage" && b ? "storage-item" : a };
}

const go = (id: string, label: string, icon: IconName, to: string): Suggestion => ({ id: `go-${id}`, label, icon, group: "go", to });
const ask = (label: string, question = label): Suggestion => ({ id: "ask", label, icon: "sparkles", group: "ask", ask: question });

export function suggestionsFor(ref: PageRef, data: EngineData): { context: string; items: Suggestion[] } {
  const d = `/${ref.device}`;
  if (ref.org) {
    const org = data.orgs.find((o) => o.slug === ref.org);
    if (!org) return { context: ref.device, items: [] };
    const b = `${d}/${org.slug}`;
    const pending = org.approvals.filter((a) => a.status === "pending").length;
    const unread = org.inbox.filter((i) => !i.read).length;
    const idle = org.agents.filter((a) => a.status === "idle").length;
    const newTask: Suggestion = { id: "new-task", label: "New task", icon: "plus", group: "do", to: `${b}/tasks?new=1` };
    const newMachine: Suggestion = { id: "new-machine", label: "New machine", icon: "box", group: "do", to: "?modal=new-machine" };
    const review: Suggestion = { id: "review", label: pending ? `Review ${pending} decision${pending === 1 ? "" : "s"}` : "Decisions", icon: "vote", group: pending ? "do" : "go", to: `${b}/decisions` };
    const nav = [
      go("dashboard", "Dashboard", "gauge", b),
      go("inbox", unread ? `Inbox (${unread})` : "Inbox", "inbox", `${b}/inbox`),
      go("decisions", pending ? `Decisions (${pending})` : "Decisions", "vote", `${b}/decisions`),
      go("tasks", "Tasks", "task", `${b}/tasks`),
      go("projects", "Projects", "folder", `${b}/projects`),
      go("goals", "Goals", "target", `${b}/goals`),
      go("routines", "Routines", "repeat", `${b}/routines`),
      go("machines", "Machines", "box", `${b}/machines`),
      go("agents", "Agents", "users", `${b}/agents`),
      go("org", "Org chart", "network", `${b}/org`),
      go("costs", "Costs", "dollar", `${b}/costs`),
      go("activity", "Activity", "activity", `${b}/activity`),
      go("connectors", "Connectors", "plug", `${b}/connectors`),
      go("settings", "Settings", "settings", `${b}/settings`),
    ].filter((s) => s.to !== `${b}${ref.page ? `/${ref.page}` : ""}`);
    const goFirst = (...ids: string[]) => [...ids.map((id) => nav.find((n) => n.id === `go-${id}`)).filter((n): n is Suggestion => !!n), ...nav.filter((n) => !ids.includes(n.id.slice(3)))];

    const page: Record<string, Suggestion[]> = {
      "": [newTask, ...(pending ? [review] : []), newMachine, ask(`How is ${org.name} doing?`), ...goFirst("tasks", "agents")],
      inbox: [{ id: "read-all", label: "Mark all read", icon: "check", group: "do", action: "read-inbox", disabled: unread === 0, title: unread ? undefined : "Nothing unread" }, ...(pending ? [review] : []), ask("What needs my attention?"), ...goFirst("decisions", "tasks")],
      decisions: [ask("Summarize what's waiting for me"), newTask, ...goFirst("agents", "costs")],
      tasks: [newTask, { id: "new-project", label: "New project", icon: "folder", group: "do", to: "?modal=new-project" }, ask("What's blocked?"), ...goFirst("projects", "agents")],
      projects: [{ id: "new-project", label: "New project", icon: "plus", group: "do", to: "?modal=new-project" }, newTask, ask("Which project is behind?"), ...goFirst("tasks", "goals")],
      goals: [{ id: "new-goal", label: "New goal", icon: "plus", group: "do", to: "?modal=new-goal" }, { id: "new-project", label: "New project", icon: "folder", group: "do", to: "?modal=new-project" }, ask("Are we on track for our goals?"), ...goFirst("projects", "tasks")],
      routines: [{ id: "new-routine", label: "New routine", icon: "plus", group: "do", to: "?modal=new-routine" }, ask("Which routines failed recently?"), ...goFirst("agents", "activity")],
      machines: [newMachine, ask(`Is ${org.name} close to its limits?`), ...goFirst("costs", "settings")],
      machine: [newMachine, ...goFirst("machines")],
      agents: [newTask, ask(idle ? `Give the ${idle} idle agent${idle === 1 ? "" : "s"} something to do` : "Who's busiest?"), ...goFirst("org", "costs")],
      org: [ask("Is anyone managing too many agents?"), newTask, ...goFirst("agents")],
      costs: [ask("Who's spending the most this month?"), ...goFirst("agents", "machines")],
      activity: [ask("What happened today?"), newTask, ...goFirst("tasks")],
      connectors: [ask("Which connectors can this organization use?"), ...goFirst("settings", "agents")],
      settings: [newMachine, ask(`Is ${org.name}'s resource group the right size?`), ...goFirst("machines", "costs")],
    };
    return { context: org.name, items: page[ref.page] ?? [newTask, ...goFirst()] };
  }

  const stopped = data.guests.filter((g) => g.status === "stopped").length;
  const newMachine: Suggestion = { id: "new-machine", label: "New machine", icon: "box", group: "do", to: "?modal=new-machine" };
  const newOrg: Suggestion = { id: "new-org", label: "New organization", icon: "org", group: "do", to: "?modal=new-org" };
  const nav = [
    go("home", "Overview", "gauge", `${d}/home`),
    go("summary", "Summary", "activity", `${d}/summary`),
    go("resources", "Resources", "tree", `${d}/resources`),
    go("machines", stopped ? `Machines (${stopped} stopped)` : "Machines", "box", `${d}/machines`),
    go("shell", "Host shell", "terminal", `${d}/shell`),
    go("storage", "Storage", "database", `${d}/storage`),
    go("network", "Network", "network", `${d}/network`),
    go("firewall", "Firewall", "shield", `${d}/firewall`),
    go("backups", "Backups", "archive", `${d}/backups`),
    go("automations", "Automations", "zap", `${d}/automations`),
    go("tasks", "Tasks", "list", `${d}/tasks`),
    go("store", "Store", "package", `${d}/store`),
    go("pin", "Pin's page", "sparkles", `${d}/pin`),
    go("updates", "Updates", "refresh", "?settings=updates"),
  ].filter((s) => s.to !== `${d}/${ref.page}`);
  const goFirst = (...ids: string[]) => [...ids.map((id) => nav.find((n) => n.id === `go-${id}`)).filter((n): n is Suggestion => !!n), ...nav.filter((n) => !ids.includes(n.id.slice(3)))];

  const page: Record<string, Suggestion[]> = {
    home: [newMachine, newOrg, ask("How is my server?"), ...goFirst("machines", "resources", "summary", "shell")],
    machines: [newMachine, ask("Which machines use the most memory?"), ...goFirst("resources", "summary")],
    machine: [newMachine, ...goFirst("machines", "resources")],
    resources: [newMachine, ask("What's using the most resources?"), ...goFirst("machines", "summary")],
    summary: [newMachine, ask("How is my server?"), ...goFirst("shell", "resources")],
    shell: [ask("What can I check from the host shell?"), ...goFirst("summary", "machines")],
    storage: [
      { id: "upload-iso", label: "Upload ISO", icon: "upload", group: "do", to: "?modal=upload&content=iso" },
      { id: "templates", label: "Templates", icon: "package", group: "do", to: "?modal=templates" },
      { id: "download-url", label: "Download from URL", icon: "download", group: "do", to: "?modal=download-url" },
      ask("How much space is left?"),
      ...goFirst("backups", "tasks"),
    ],
    "storage-item": [ask("How much space is left?"), ...goFirst("storage", "tasks", "backups")],
    tasks: [ask("Did anything fail recently?"), newMachine, ...goFirst("storage", "summary")],
    store: [newMachine, ask("What should I install first?"), ...goFirst("storage", "machines")],
    pin: [ask("What have you done today?"), ...goFirst("automations", "home")],
    network: [ask("Which machines are on which bridge?"), ...goFirst("firewall", "machines", "resources")],
    firewall: [ask("Is anything exposed that shouldn't be?"), ...goFirst("network", "summary")],
    backups: [ask("When did the last backup run?"), ...goFirst("storage", "machines")],
    automations: [{ id: "new-automation", label: "New automation", icon: "zap", group: "do", to: "?modal=new-automation" }, ask("What did my automations do today?"), ...goFirst("machines", "summary")],
  };
  return { context: ref.device, items: page[ref.page] ?? [newMachine, ...goFirst()] };
}

/** The island's row: up to three actions, preferring things to do, then a question for Pin. */
export function splitSuggestions(items: { group?: string; more?: boolean }[], max = 3) {
  const main: number[] = [];
  const order = ["do", "ask", "go"];
  for (const g of order) for (let i = 0; i < items.length && main.length < max; i++) if (!items[i].more && (items[i].group ?? "do") === g && !main.includes(i)) main.push(i);
  main.sort((a, b) => a - b);
  return { main, rest: items.map((_, i) => i).filter((i) => !main.includes(i)) };
}
