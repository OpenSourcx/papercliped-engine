import type { ReactNode } from "react";

/** One quick action Pin offers for the current page, like a button in Proxmox's toolbar. */
export interface QuickAction {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  disabled?: boolean;
  title?: string; // why it is disabled, or a hint
  danger?: boolean;
  /** Ask before running; for actions that cut power or lose work. */
  confirm?: { title: string; body: string; label: string };
  /** Shown in the More panel instead of the main row. */
  more?: boolean;
  /** do: acts on this page; ask: a question for Pin; go: a related page. Decides where it shows in the island. */
  group?: "do" | "ask" | "go";
}

export interface QuickActions {
  context: string; // what the actions apply to, e.g. "lab #109"
  items: QuickAction[];
}
