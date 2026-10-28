import { describe, expect, it } from "vitest";
import { COMMANDS, filterCommands, isCommandStart } from "../src/pin/composer/commands.ts";
import { appendMemoryLine, isMemoryLine, memoryLine } from "../src/pin/composer/memory.ts";
import { groupMentions, mentionQuery, mentionToken, type Mention } from "../src/pin/composer/mentions.ts";
import { popoverKey } from "../src/pin/composer/ComposerPopover.tsx";

describe("the composer's slash commands", () => {
  it("lists every command when nothing is typed", () => {
    expect(filterCommands("").map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
  });

  it("puts a name that starts with the query first, then anything else that matches", () => {
    expect(filterCommands("m")[0].name).toBe("mode");
    expect(filterCommands("mode")[0].name).toBe("mode");
    // "clear" also matches /new by its keywords, and /clear by its name.
    const names = filterCommands("clear").map((c) => c.name);
    expect(names[0]).toBe("clear");
    expect(names).toContain("new");
  });

  it("finds a command by what it does, not only its name", () => {
    expect(filterCommands("shell").map((c) => c.name)).toContain("terminal");
    expect(filterCommands("rule").map((c) => c.name)).toContain("automation");
    expect(filterCommands("zzz")).toEqual([]);
  });

  it("only opens a command at the start of the field", () => {
    expect(isCommandStart("")).toBe(true);
    expect(isCommandStart("hello ")).toBe(true);
    expect(isCommandStart("hello")).toBe(false);
  });
});

describe("the composer's memory line", () => {
  it("is only a memory line when # is the very first character", () => {
    expect(isMemoryLine("# we need to focus on work")).toBe(true);
    expect(isMemoryLine(" # indented")).toBe(false);
    expect(isMemoryLine("remember # something")).toBe(false);
  });

  it("keeps what follows the #, on one line, and nothing when there is nothing", () => {
    expect(memoryLine("# we need to focus on work")).toBe("we need to focus on work");
    expect(memoryLine("#   spaced   out  ")).toBe("spaced out");
    expect(memoryLine("#")).toBeNull();
    expect(memoryLine("#    ")).toBeNull();
    expect(memoryLine("not a memory line")).toBeNull();
  });

  it("appends one dated line under a heading, and doesn't double one that is already there", () => {
    const first = appendMemoryLine("# MEMORY.md\n", "we need to focus on work", "2026-10-28");
    expect(first.added).toBe(true);
    expect(first.line).toBe("- 2026-10-28: we need to focus on work");
    expect(first.memory).toContain("## Remembered\n- 2026-10-28: we need to focus on work");
    const again = appendMemoryLine(first.memory, "we need to focus on work", "2026-10-29");
    expect(again.added).toBe(false);
    expect(again.memory).toBe(first.memory);
  });
});

describe("the composer's mentions", () => {
  const all: Mention[] = [
    { kind: "person", id: "sam@pve", label: "sam@pve", detail: "Owner" },
    { kind: "agent", id: "a1", label: "Ops lead", detail: "Operator · Acme", org: "acme" },
    { kind: "agent", id: "a2", label: "Night watch", detail: "Operator · Lumen", org: "lumen" },
    { kind: "organization", id: "acme", label: "Acme", org: "acme" },
    { kind: "project", id: "p1", label: "Website", detail: "Project · Acme", org: "acme" },
    { kind: "machine", id: "101", label: "discord-bot", detail: "Container · 101" },
  ];

  it("finds the @ being typed, and not the @ in an email address", () => {
    expect(mentionQuery("@")).toEqual({ start: 0, query: "" });
    expect(mentionQuery("hello @ops")).toEqual({ start: 6, query: "ops" });
    expect(mentionQuery("mail me at sam@pve")).toBeNull();
    expect(mentionQuery("try sam@pve please")).toBeNull();
  });

  it("starts with the open organization, then the rest, in kind order", () => {
    const groups = groupMentions(all, "", "acme");
    expect(groups.map((g) => g.kind)).toEqual(["person", "agent", "organization", "project", "machine"]);
    const agents = groups.find((g) => g.kind === "agent")!.items.map((m) => m.id);
    expect(agents).toEqual(["a1", "a2"]);
  });

  it("filters by label, id or detail, and drops kinds with no match", () => {
    const groups = groupMentions(all, "night", "acme");
    expect(groups.map((g) => g.kind)).toEqual(["agent"]);
    expect(groups[0].items[0].label).toBe("Night watch");
    expect(groupMentions(all, "101", "acme").map((g) => g.kind)).toEqual(["machine"]);
    expect(groupMentions(all, "acme", "acme").map((g) => g.kind)).toContain("project");
    expect(groupMentions(all, "nothing here", "acme")).toEqual([]);
  });

  it("writes a person as their Proxmox user and anything else by its label, without spaces", () => {
    expect(mentionToken({ kind: "agent", id: "a1", label: "Ops lead" })).toBe("@Ops-lead");
    expect(mentionToken({ kind: "person", id: "sam@pve", label: "Sam" })).toBe("@sam@pve");
  });
});

describe("the composer's keys", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, nativeEvent: { isComposing: false }, ...mods }) as unknown as React.KeyboardEvent;
  it("gives the popover the keys it needs, and leaves the rest to the field", () => {
    expect(popoverKey(key("ArrowDown"), 3)).toBe("down");
    expect(popoverKey(key("ArrowUp"), 3)).toBe("up");
    expect(popoverKey(key("Enter"), 3)).toBe("choose");
    expect(popoverKey(key("Tab"), 3)).toBe("complete");
    // Shift+Tab is the browser's own way back, so it is left alone.
    expect(popoverKey(key("Tab", { shiftKey: true }), 3)).toBeNull();
    expect(popoverKey(key("Escape"), 3)).toBe("close");
    expect(popoverKey(key("a"), 3)).toBeNull();
    // With nothing to choose from, Enter sends the message as it always did.
    expect(popoverKey(key("Enter"), 0)).toBeNull();
    expect(popoverKey(key("Tab"), 0)).toBeNull();
  });
});
