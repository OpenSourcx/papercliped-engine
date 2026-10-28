import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { cn } from "../../lib/storage.ts";
import { usePin } from "../PinContext.tsx";
import { useThreadApi } from "../ThreadContext.tsx";
import type { PinPermission } from "../live.ts";
import { PERMISSION_INFO } from "../PermissionPicker.tsx";

/**
 * The line under the composer: what the conversation runs with, left to right — the mode, what Pin may do on its own, and
 * the model. Each is a button that opens a small menu, so the line is the fastest way to change them and reads the same
 * in Pin's island, on Pin's page and in PinView (the brief's `docs/design/reference/composer.png`).
 */

const MODES = [
  { id: "assistant" as const, label: "Assistant", body: "Pin answers, and proposes anything bigger for you to approve." },
  { id: "agent" as const, label: "Agent", body: "Pin does the work it is allowed to do on its own." },
];

function Piece({ label, value, onOpen }: { label: string; value: string; onOpen?: () => void | null }) {
  if (!onOpen) {
    return <span className="inline-flex min-h-8 items-center px-1.5 text-xs text-ink-3" title={`${label}: ${value}`}>{value}</span>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="menu"
      aria-label={`${label}: ${value}. Change it`}
      title={`${label}: ${value}`}
      className="transition-control inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="truncate">{value}</span>
      <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
    </button>
  );
}

/** A small menu under a piece of the line. Built here rather than from `Menu` because it has no icon button of its own. */
function LineMenu({ label, items, onClose }: { label: string; items: { key: string; label: string; detail?: string; on?: boolean; disabled?: boolean; onSelect: () => void }[]; onClose: () => void }) {
  return (
    <div
      role="menu"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="glass solid menu-in z-(--z-popover) w-64 rounded-xl p-1.5 shadow-overlay"
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          aria-disabled={it.disabled || undefined}
          onClick={() => {
            if (it.disabled) return;
            it.onSelect();
            onClose();
          }}
          className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm", it.disabled ? "cursor-default text-ink-3 opacity-60" : "text-ink hover:bg-surface-3")}
        >
          <Check aria-hidden className={cn("mt-1 h-3.5 w-3.5 shrink-0", it.on ? "opacity-100 text-accent" : "opacity-0")} />
          <span className="min-w-0">
            <span className="block truncate">{it.label}</span>
            {it.detail && <span className="block text-xs text-ink-3">{it.detail}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

export function StatusLine({ editable = true }: { /** False in an agent chat, where this line reads Pin's own settings and changing them would change Pin, not the agent. */ editable?: boolean }) {
  const pin = usePin();
  const engine = useEngine();
  const thread = useThreadApi();
  void thread;
  const [open, setOpen] = useState<null | "mode" | "permission" | "model">(null);
  const [models, setModels] = useState<{ id: string; name: string }[] | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const settings = pin.settings;
  // Agent chats in PinView draw this line but have no Pin settings of their own; they show Pin's.
  if (!settings) return null;

  const mode = settings.mode;
  const permission = PERMISSION_INFO.find((p) => p.id === settings.permission) ?? PERMISSION_INFO[0];
  const model = settings.model ?? "No model";

  const loadModels = async () => {
    setOpen("model");
    if (models || !settings.provider) return;
    try {
      setModels(await pin.settingsSource.models(settings.provider));
    } catch {
      setModels([]);
    }
  };

  return (
    <div ref={wrap} className="relative flex flex-wrap items-center gap-0.5 text-xs text-ink-3">
      <span className="sr-only">This conversation runs with</span>
      <div className="relative">
        <Piece label="Mode" value={mode === "agent" ? "Agent mode" : "Assistant mode"} onOpen={editable ? () => setOpen(open === "mode" ? null : "mode") : undefined} />
        {open === "mode" && (
          <div className="absolute bottom-full left-0 z-(--z-popover) pb-1">
            <LineMenu
              label="Mode"
              items={MODES.map((m) => ({ key: m.id, label: m.label, detail: m.body, on: settings.mode === m.id, onSelect: () => pin.setMode(m.id) }))}
              onClose={() => setOpen(null)}
            />
          </div>
        )}
      </div>
      {mode === "agent" && (
        <div className="relative">
          <Piece label="Permission" value={permission.label} onOpen={editable ? () => setOpen(open === "permission" ? null : "permission") : undefined} />
          {open === "permission" && (
            <div className="absolute bottom-full left-0 z-(--z-popover) pb-1">
              <LineMenu
                label="What Pin may do without asking"
                items={PERMISSION_INFO.map((p) => {
                  // Bypass needs the word typed, which this line has no room for: say where it lives instead of doing
                  // nothing. Leaving bypass works from here.
                  const locked = p.id === "bypass" && settings.permission !== "bypass";
                  return {
                    key: p.id,
                    label: p.label,
                    detail: locked ? "Turn this on in Pin's settings, where it asks you to type the word." : p.body,
                    on: settings.permission === p.id,
                    disabled: locked,
                    onSelect: () => void pin.setPermission(p.id as PinPermission),
                  };
                })}
                onClose={() => setOpen(null)}
              />
            </div>
          )}
        </div>
      )}
      <div className="relative">
        <Piece label="Model" value={model} onOpen={editable ? () => (open === "model" ? setOpen(null) : void loadModels()) : undefined} />
        {open === "model" && (
          <div className="absolute bottom-full left-0 z-(--z-popover) pb-1">
            <LineMenu
              label="Model"
              items={
                models === null
                  ? [{ key: "loading", label: "Reading the models…", onSelect: () => {} }]
                  : models.length
                    ? models.map((m) => ({ key: m.id, label: m.name, on: settings.model === m.id, onSelect: () => void saveModel(m.id) }))
                    : [{ key: "none", label: settings.provider ? "This provider listed no models" : "Choose a model provider in Connectors", onSelect: () => {} }]
              }
              onClose={() => setOpen(null)}
            />
          </div>
        )}
      </div>
      <span className="ml-auto hidden text-ink-3 sm:inline">{engine.live ? "" : "Demo"}</span>
    </div>
  );

  async function saveModel(id: string) {
    if (!settings) return;
    const next = { ...settings, model: id };
    pin.setSettings(next);
    if (!engine.live) return;
    try {
      await pin.settingsSource.save(next);
    } catch {
      pin.setSettings(settings);
    }
  }
}
