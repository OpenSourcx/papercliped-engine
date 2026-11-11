import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { pinLibrary } from "../../data/engine/pinLibraryApi.ts";
import { useIac } from "../../pages/access/shared.tsx";
import { useEngine } from "../../data/store.tsx";
import { usePin } from "../PinContext.tsx";
import { useThreadApi } from "../ThreadContext.tsx";
import { popoverKey, type PopoverGroup, type PopoverItem } from "./ComposerPopover.tsx";
import { COMMANDS, filterCommands, type CommandId } from "./commands.ts";
import { appendMemoryLine, isMemoryLine, memoryLine } from "./memory.ts";
import { KIND_LABELS, groupMentions, mentionQuery, mentionToken, type Mention } from "./mentions.ts";

/**
 * The composer's behaviour, apart from how it looks: "/" commands, "@" mentions and a "#" memory line. One hook, so Pin's
 * island, Pin's page and PinView all behave the same (the brief: every conversation uses this composer).
 */

export type ComposerMode =
  | { kind: "none" }
  | { kind: "commands"; query: string }
  | { kind: "mentions"; query: string; start: number };

export interface ComposerShell {
  /** Starts a new chat. */
  newChat: () => void;
  /** Opens a tile in PinView; null when this composer isn't in the workspace. */
  openTile: ((kind: "plan" | "files" | "terminal" | "prs") => void) | null;
  /** The organization the open conversation belongs to, so "@" starts with its people, agents and projects. */
  org: string | null;
}

const TILE_FOR: Partial<Record<CommandId, "plan" | "files" | "terminal" | "prs">> = { plan: "plan", files: "files", terminal: "terminal", prs: "prs" };

export function useComposer(shell: ComposerShell, opts: { inPlace?: boolean } = {}) {
  const pin = usePin();
  const engine = useEngine();
  const thread = useThreadApi();
  // Live, the people are Proxmox's own users, read from the same query the Access pages use; the demo keeps its own.
  const iac = useIac();
  const area = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ComposerMode>({ kind: "none" });
  const [active, setActive] = useState(0);
  const [note, setNote] = useState<{ tone: "good" | "critical"; text: string; undo?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Chosen mentions, with the exact field text that stands for each, so trimming or a label with spaces can't lose it. */
  const [chosen, setChosen] = useState<{ mention: Mention; token: string }[]>([]);

  // ---- What can be mentioned: people, agents, organizations, projects and machines the person can already see.
  const mentions = useMemo<Mention[]>(() => {
    const out: Mention[] = [];
    const data = engine.data;
    // Nothing here is assumed to exist: a page may draw the composer before the console's data arrives.
    if (engine.live) {
      for (const u of iac.data?.users ?? []) {
        out.push({ kind: "person", id: u.userid, label: u.name || u.userid, detail: u.userid });
      }
    } else {
      for (const u of data.users ?? []) {
        const label = u.pveUser || u.email || u.name;
        out.push({ kind: "person", id: label, label, detail: u.role.charAt(0).toUpperCase() + u.role.slice(1) });
      }
    }
    for (const o of data.orgs ?? []) {
      out.push({ kind: "organization", id: o.slug, label: o.name, org: o.slug });
      for (const a of o.agents ?? []) out.push({ kind: "agent", id: a.id, label: a.name, detail: `${a.role} · ${o.name}`, org: o.slug });
      for (const p of o.projects ?? []) out.push({ kind: "project", id: p.id, label: p.name, detail: `Project · ${o.name}`, org: o.slug });
    }
    for (const g of data.guests ?? []) {
      out.push({ kind: "machine", id: String(g.vmid), label: g.name, detail: `${g.type === "lxc" ? "Container" : "Virtual machine"} · ${g.vmid}` });
    }
    return out;
  }, [engine.data.orgs, engine.data.users, engine.data.guests, engine.live, iac.data?.users]);

  // ---- The popover's rows
  const groups = useMemo<PopoverGroup[]>(() => {
    if (mode.kind === "commands") {
      return [{ items: filterCommands(mode.query).map((c): PopoverItem => ({ key: c.name, label: `/${c.name}`, detail: c.description, hint: c.needsWorkspace ? "workspace" : undefined })) }];
    }
    if (mode.kind === "mentions") {
      return groupMentions(mentions, mode.query, shell.org).map((g) => ({
        label: KIND_LABELS[g.kind],
        items: g.items.map((m): PopoverItem => ({ key: `${m.kind}:${m.id}`, label: m.label, detail: m.detail })),
      }));
    }
    return [];
  }, [mode, mentions, shell.org]);

  const rows = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const open = mode.kind !== "none" && rows.length > 0;

  // ---- Opening the popover as the field changes
  const detect = (text: string, caret: number) => {
    if (isMemoryLine(text)) return setMode({ kind: "none" });
    const before = text.slice(0, caret);
    const slash = /^\/(\S*)$/.exec(before);
    if (slash) {
      setMode({ kind: "commands", query: slash[1] });
      return setActive(0);
    }
    const m = mentionQuery(before);
    if (m) {
      setMode({ kind: "mentions", query: m.query, start: m.start });
      return setActive(0);
    }
    setMode({ kind: "none" });
  };

  /** Replaces the "@query" (or the "/command") the popover was opened for with `insert`, and puts the caret after it. */
  const replaceRange = (start: number, end: number, insert: string) => {
    const el = area.current;
    const next = draft.slice(0, start) + insert + draft.slice(end);
    setDraft(next);
    setMode({ kind: "none" });
    requestAnimationFrame(() => {
      el?.focus({ preventScroll: true });
      el?.setSelectionRange(start + insert.length, start + insert.length);
    });
  };

  // ---- Commands
  const runCommand = (id: CommandId) => {
    setMode({ kind: "none" });
    // A command that only fills the field keeps what is there; the rest clear it.
    const fills = id === "automation" || id === "remember" || id === "clear";
    if (!fills) setDraft("");
    setNote(null);
    switch (id) {
      case "new":
        return shell.newChat();
      case "mode":
        return pin.setMode(pin.settings?.mode === "agent" ? "assistant" : "agent");
      case "permission": {
        const order = ["ask", "accept", "auto", "plan"] as const;
        const now = (pin.settings?.permission ?? "ask") as (typeof order)[number];
        return void pin.setPermission(order[(order.indexOf(now) + 1) % order.length]);
      }
      case "model":
        return setNote({ tone: "good", text: "Choose the model on the line under this field." });
      case "plan":
        return pin.send("Write a plan for this.", { inPlace: opts.inPlace });
      case "automation":
        return setDraft("Set up a standing rule: ");
      case "remember":
        return setDraft("# ");
      case "clear":
        return setDraft("");
      default: {
        const tile = TILE_FOR[id];
        if (tile && shell.openTile) return shell.openTile(tile);
        return setNote({ tone: "good", text: `${id === "prs" ? "Pull requests" : id[0].toUpperCase() + id.slice(1)} opens from the workspace toolbar.` });
      }
    }
  };

  const chooseMention = (item: PopoverItem) => {
    if (mode.kind !== "mentions") return;
    const m = mentions.find((x) => `${x.kind}:${x.id}` === item.key);
    if (!m) return;
    const token = mentionToken(m);
    setChosen((c) => [...c, { mention: m, token }]);
    // A trailing space, so a second mention can follow straight away.
    replaceRange(mode.start, mode.start + 1 + mode.query.length, `${token} `);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      const action = popoverKey(e, rows.length);
      if (action) {
        e.preventDefault();
        if (action === "up") setActive((a) => (a <= 0 ? rows.length - 1 : a - 1));
        else if (action === "down") setActive((a) => (a + 1) % rows.length);
        else if (action === "first") setActive(0);
        else if (action === "last") setActive(rows.length - 1);
        else if (action === "close") {
          setMode({ kind: "none" });
          area.current?.focus({ preventScroll: true });
        } else {
          // Enter runs the highlighted row; Tab completes it. Either way the field keeps focus.
          const item = rows[active] ?? rows[0];
          if (mode.kind === "commands") runCommand(COMMANDS.find((c) => c.name === item.key)?.id ?? "clear");
          else chooseMention(item);
        }
        return;
      }
    }
  };

  // ---- Sending
  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (isMemoryLine(draft)) {
      const line = memoryLine(draft);
      setDraft("");
      if (!line) return setNote({ tone: "critical", text: "Type what to remember after the #." });
      return saveMemory(line);
    }
    // Mentions whose text is still in the field travel as ids, never names. Matching is against the untrimmed draft, so
    // a mention that is the whole message still counts, and a mention deleted from the text is not sent. The message
    // itself is trimmed, as Pin's composer has always sent it.
    const carried = chosen.filter(({ token }) => draft.includes(token)).map(({ mention }) => mention);
    const unique = [...new Map(carried.map((m) => [`${m.kind}:${m.id}`, m])).values()];
    thread.send(text, { ...(opts.inPlace ? { inPlace: true } : {}), ...(unique.length ? { context: { mentions: unique.map((m) => ({ kind: m.kind, id: m.id })) } } : {}) });
    setDraft("");
    setChosen([]);
    setMode({ kind: "none" });
  };

  const saveMemory = async (line: string) => {
    setBusy(true);
    setNote(null);
    try {
      if (engine.live) {
        const r = await pinLibrary.remember(line);
        setNote({ tone: "good", text: r.message, ...(r.line ? { undo: r.rev } : {}) });
      } else {
        // Read memory as it is now, not as it was when this render closed over it, so two quick saves don't lose one.
        const current = engine.pin?.memory ?? "";
        const { memory: next, added } = appendMemoryLine(current, line, new Date().toISOString().slice(0, 10));
        if (added) engine.savePinFile("memory", next);
        setNote({ tone: "good", text: added ? `Saved to MEMORY.md: ${line}` : `Already in MEMORY.md: ${line}` });
      }
    } catch (e) {
      setNote({ tone: "critical", text: e instanceof Error ? e.message : "That didn't save." });
    } finally {
      setBusy(false);
    }
  };

  /** Undo goes through the memory history that already exists, so there is only one way back. */
  const undo = async () => {
    if (!note?.undo) return;
    const rev = note.undo;
    setNote(null);
    try {
      await pinLibrary.restore(rev);
      setNote({ tone: "good", text: "Taken out of MEMORY.md again." });
    } catch {
      setNote({ tone: "critical", text: "Couldn't undo that. MEMORY.md is on Pin's Soul and memory tab." });
    }
  };

  /** Puts a quoted message above whatever is already being written ("Quote in reply"). */
  const quote = (text: string) => {
    const quoted = `${text.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
    setDraft((d) => `${quoted}${d}`);
    setMode({ kind: "none" });
    requestAnimationFrame(() => area.current?.focus({ preventScroll: true }));
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };
  const onClick = (e: MouseEvent<HTMLTextAreaElement>) => {
    if (mode.kind === "none") return;
    const caret = e.currentTarget.selectionStart ?? 0;
    if (mode.kind === "mentions" && caret < mode.start) setMode({ kind: "none" });
    if (mode.kind === "commands" && caret > 0) setMode({ kind: "none" });
  };

  const memoryHint = isMemoryLine(draft) && !memoryLine(draft) ? "Type what to remember after the #." : null;
  const hover = useCallback((i: number) => setActive(i), []);

  return {
    area,
    draft,
    setDraft,
    mode,
    groups,
    rows,
    active,
    open,
    note,
    setNote,
    busy,
    memoryHint,
    hover,
    onChange,
    onClick,
    onKeyDown,
    send,
    undo,
    quote,
    runCommand,
    chooseMention,
  };
}
