import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../lib/storage.ts";

/**
 * Modals, Discord style: everything that isn't a main view opens over the page, scales and fades in, and closes with
 * Esc, the close button or a click outside. Modals stack; Esc only closes the top one.
 */

const stack: string[] = [];
const EXIT_MS = 160;

/** Lets pages render compactly when they are shown inside a modal. */
const InModal = createContext(false);
export const useInModal = () => useContext(InModal);

function useModalLifecycle(onClose: () => void) {
  const id = useId();
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(() => closeRef.current(), EXIT_MS);
  }, []);

  useEffect(() => {
    stack.push(id);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stack[stack.length - 1] === id) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) document.body.style.overflow = prevOverflow;
    };
  }, [id, close]);

  return { id, closing, close };
}

export function Modal({ title, subtitle, icon, onClose, children, size = "md", footer }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; size?: "sm" | "md" | "lg"; footer?: ReactNode }) {
  const { id, closing, close } = useModalLifecycle(onClose);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Leave focus where it is if a field inside asked for it (autoFocus); otherwise focus the dialog itself.
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-6">
      <div className={cn("absolute inset-0 bg-black/60 backdrop-blur-[2px]", closing ? "modal-backdrop-out" : "modal-backdrop-in")} onMouseDown={close} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={cn(
          "relative w-full max-h-[calc(100dvh-24px)] flex flex-col rounded-2xl bg-surface border border-line-strong shadow-2xl outline-none",
          size === "sm" && "max-w-md",
          size === "md" && "max-w-xl",
          size === "lg" && "max-w-3xl",
          closing ? "modal-out" : "modal-in",
        )}
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-4">
          {icon}
          <div className="flex-1 min-w-0">
            <h2 id={`${id}-title`} className="text-[18px] font-semibold leading-tight">{title}</h2>
            {subtitle && <div className="text-[13px] text-ink-3 mt-1">{subtitle}</div>}
          </div>
          <button onClick={close} className="h-8 w-8 rounded-full hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-ink shrink-0" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          <InModal.Provider value={true}>{children}</InModal.Provider>
        </div>
        {footer && <div className="px-5 py-4 border-t border-line bg-surface-2/40 rounded-b-2xl flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface SettingsSection {
  id: string;
  label: string;
  icon: ReactNode;
  group: string;
  render: () => ReactNode;
}

/** The full-screen settings modal: categories on the left, the section on the right, like Discord's User Settings. */
export function SettingsModal({ sections, active, onSelect, onClose, footer }: { sections: SettingsSection[]; active: string; onSelect: (id: string) => void; onClose: () => void; footer?: ReactNode }) {
  const { id, closing, close } = useModalLifecycle(onClose);
  const current = sections.find((s) => s.id === active) ?? sections[0];
  const groups = [...new Set(sections.map((s) => s.group))];
  const [navOpen, setNavOpen] = useState(false);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className={cn("fixed inset-0 z-50 flex bg-bg", closing ? "settings-out" : "settings-in")}>
      <nav className={cn("w-full sm:w-auto sm:flex-[1_0_220px] bg-surface/70 border-r border-line justify-end overflow-y-auto", navOpen ? "flex absolute inset-0 z-10 sm:static" : "hidden sm:flex")}>
        <div className="w-full sm:w-[232px] py-14 px-3 sm:px-2.5">
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="px-2.5 mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">{g}</div>
              {sections.filter((s) => s.group === g).map((s) => (
                <button
                  key={s.id}
                  onClick={() => { onSelect(s.id); setNavOpen(false); }}
                  aria-current={s.id === current.id ? "page" : undefined}
                  className={cn("w-full flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[14px] text-left transition-colors", s.id === current.id ? "bg-surface-3 text-ink font-medium" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}
                >
                  <span className="text-ink-3">{s.icon}</span>
                  {s.label}
                </button>
              ))}
            </div>
          ))}
          {footer && <div className="mt-2 pt-3 border-t border-line">{footer}</div>}
        </div>
      </nav>
      <div className="flex-[1_1_800px] min-w-0 overflow-y-auto">
        <div className="max-w-[760px] px-4 sm:px-10 py-14 relative">
          <button onClick={() => setNavOpen(true)} className="sm:hidden mb-4 text-[13px] text-ink-3 hover:text-ink">← All settings</button>
          <h1 id={`${id}-title`} className="sr-only">{current.label}</h1>
          <InModal.Provider value={true}>
            <div key={current.id} className="fade-in">{current.render()}</div>
          </InModal.Provider>
        </div>
      </div>
      <div className="hidden sm:block flex-[0_0_88px] pt-14">
        <button onClick={close} className="group flex flex-col items-center gap-1.5 text-ink-3 hover:text-ink" aria-label="Close settings">
          <span className="h-9 w-9 rounded-full border-2 border-current flex items-center justify-center"><X className="h-4 w-4" /></span>
          <span className="text-[12px] font-semibold">ESC</span>
        </button>
      </div>
      <button onClick={close} className="sm:hidden absolute right-3 top-3 h-9 w-9 rounded-full bg-surface-2 flex items-center justify-center z-20" aria-label="Close settings"><X className="h-4 w-4" /></button>
    </div>,
    document.body,
  );
}
