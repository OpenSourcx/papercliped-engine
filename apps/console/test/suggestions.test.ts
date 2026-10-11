import { describe, expect, it } from "vitest";
import { demoData } from "../src/data/demo.ts";
import { pageOf, splitSuggestions, suggestionsFor } from "../src/pin/suggestions.ts";

const data = demoData("Northwind Labs");
const slugs = data.orgs.map((o) => o.slug);
const org = slugs[0];
const at = (path: string) => suggestionsFor(pageOf(path, slugs), data);
const row = (path: string) => {
  const s = at(path);
  return splitSuggestions(s.items).main.map((i) => s.items[i].id);
};

const devicePages = ["home", "machines", "machines/109", "resources", "summary", "shell", "storage", "network", "backups", "automations"];
const orgPages = ["", "inbox", "decisions", "tasks", "projects", "goals", "routines", "machines", "machines/105", "agents", "org", "costs", "activity", "connectors", "settings"];

describe("Pin's suggestions", () => {
  it("reads where you are", () => {
    expect(pageOf("/pve/home", slugs)).toEqual({ device: "pve", org: null, page: "home" });
    expect(pageOf(`/pve/${org}/projects`, slugs)).toEqual({ device: "pve", org, page: "projects" });
    expect(pageOf(`/pve/${org}/machines/105`, slugs).page).toBe("machine");
    expect(pageOf(`/pve/${org}`, slugs).page).toBe("");
  });

  it("offers a quick machine from home, first in the row", () => {
    expect(row("/pve/home")[0]).toBe("new-machine");
    expect(row("/pve/home")).toContain("new-org");
  });

  it("scopes suggestions to the page: projects suggest a project, goals a goal, routines a routine", () => {
    expect(row(`/pve/${org}/projects`)[0]).toBe("new-project");
    expect(row(`/pve/${org}/goals`)[0]).toBe("new-goal");
    expect(row(`/pve/${org}/routines`)[0]).toBe("new-routine");
    expect(row(`/pve/${org}/tasks`)[0]).toBe("new-task");
    expect(row(`/pve/${org}/inbox`)[0]).toBe("read-all");
    expect(at(`/pve/${org}/projects`).context).toBe(data.orgs[0].name);
  });

  it("gives every page something to do or ask in at most three slots, and never links to the page you're on", () => {
    for (const p of [...devicePages.map((x) => `/pve/${x}`), ...orgPages.map((x) => `/pve/${org}${x ? `/${x}` : ""}`)]) {
      const s = at(p);
      const main = splitSuggestions(s.items).main.map((i) => s.items[i]);
      expect(main.length, p).toBeGreaterThan(0);
      expect(main.length, p).toBeLessThanOrEqual(3);
      expect(main.some((m) => m.group !== "go"), p).toBe(true);
      expect(s.items.some((i) => i.to === p), p).toBe(false);
      expect(new Set(s.items.map((i) => i.id)).size, p).toBe(s.items.length);
    }
  });

  it("surfaces pending decisions on the dashboard", () => {
    const pending = data.orgs[0].approvals.filter((a) => a.status === "pending").length;
    if (pending) expect(row(`/pve/${org}`)).toContain("review");
  });

  it("fills the row with actions before questions, and questions before links", () => {
    const items = [{ group: "go" }, { group: "ask" }, { group: "do" }, { group: "do", more: true }, { group: "do" }];
    expect(splitSuggestions(items).main).toEqual([1, 2, 4]);
  });
});
