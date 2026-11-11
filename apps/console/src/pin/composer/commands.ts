/**
 * The composer's "/" commands. Each one is something the console can already do, or a way to start something it will do:
 * nothing here reaches past what the person could do from a button. A command is run with the composer's context, which
 * the shell provides (see `ComposerContext` in `PinInput`), so the list stays plain data and is easy to test.
 */

export type CommandId =
  | "new"
  | "mode"
  | "permission"
  | "model"
  | "plan"
  | "terminal"
  | "files"
  | "prs"
  | "clear"
  | "automation"
  | "remember";

export interface Command {
  id: CommandId;
  /** What the person types after the slash. */
  name: string;
  /** One line: what it does, in plain words. */
  description: string;
  /** Words that also match when filtering, so "/start over" finds `/new`. */
  keywords?: string;
  /** A command that needs the workspace (a tile, a Go to) says so instead of doing nothing. */
  needsWorkspace?: boolean;
  /** Shows the chosen argument after the name, e.g. "/mode agent". */
  arg?: () => string | null;
  run: () => void;
}

/** Every command the composer offers, in the order they appear when the menu opens. */
export const COMMANDS: { id: CommandId; name: string; description: string; keywords?: string; needsWorkspace?: boolean }[] = [
  { id: "new", name: "new", description: "Start a new chat", keywords: "clear reset start over fresh" },
  { id: "mode", name: "mode", description: "Switch Pin between Assistant mode and Agent mode", keywords: "agent assistant assistant-mode" },
  { id: "permission", name: "permission", description: "Choose what Pin may do without asking, in Agent mode", keywords: "ask accept auto plan bypass allow" },
  { id: "model", name: "model", description: "Choose the model Pin answers with", keywords: "provider model" },
  { id: "plan", name: "plan", description: "Ask Pin for a written plan", keywords: "propose steps" },
  { id: "terminal", name: "terminal", description: "Open the terminal tile", keywords: "shell console", needsWorkspace: true },
  { id: "files", name: "files", description: "Open the files tile", keywords: "machine file tree explorer", needsWorkspace: true },
  { id: "prs", name: "prs", description: "Open the pull requests tile", keywords: "pull requests github changes", needsWorkspace: true },
  { id: "automation", name: "automation", description: "Describe a standing rule and Pin sets it up", keywords: "rule trigger schedule when" },
  { id: "remember", name: "remember", description: "Save a line to Pin's memory, the same as starting a message with #", keywords: "memory save note soul" },
  { id: "clear", name: "clear", description: "Clear what you have typed", keywords: "empty reset" },
];

/** Filters the list by what is typed after the slash: the name starts it, or a keyword or the description contains it. */
export function filterCommands(query: string): typeof COMMANDS {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  const starts = COMMANDS.filter((c) => c.name.startsWith(q));
  const rest = COMMANDS.filter((c) => !starts.includes(c) && (c.name.includes(q) || (c.keywords ?? "").includes(q) || c.description.toLowerCase().includes(q)));
  return [...starts, ...rest];
}

/** True when the character before the caret starts a slash command: the field is empty, or only spaces come before it. */
export function isCommandStart(textBeforeCaret: string): boolean {
  return textBeforeCaret === "" || /\s$/.test(textBeforeCaret);
}
