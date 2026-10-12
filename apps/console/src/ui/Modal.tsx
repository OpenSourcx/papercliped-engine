import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, X } from "lucide-react";
import { cn } from "../lib/storage.ts";

/**
 * Modals: everything that isn't a main view opens over the page, scales and fades in, and closes with Esc, the close
 * button or a click outside. Modals stack; Esc only closes the top one. Focus moves in, stays in (Tab wraps), and
 * returns to whatever opened the modal when it closes.
 */

const stack: string[] = [];
/** Matches --duration-fast, the exit animation's length. */
const EXIT_MS = 150;

/** Lets pages render compactly when they are shown inside a modal. */
const InModal = createContext(false);
export const useInModal = () => useContext(InModal);

/** True while any modal is open, so floating chrome (Pin's island) can step back. */
export function useAnyModalOpen() {
  const [open, setOpen] = useState(stack.length > 0);
  useEffect(() => {
    const on = () => setOpen(stack.length > 0);
    window.addEventListener("epc:modals", on);
    return () => window.removeEventListener("epc:modals", on);
  }, []);
  return open;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useModalLifecycle(onClose: () => void, panel: React.RefObject<HTMLElement | null>) {
  const id = useId();
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const close = useCallback(() => {
    setClosing(true);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => closeRef.current(), reduce ? 0 : EXIT_MS);
  }, []);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    stack.push(id);
    window.dispatchEvent(new Event("epc:modals"));
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
      if (e.key === "Tab" && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      window.dispatchEvent(new Event("epc:modals"));
      if (stack.length === 0) document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [id, close, panel]);

  return { id, closing, close };
}

const SIZES = { sm: "sm:max-w-md", md: "sm:max-w-xl", lg: "sm:max-w-3xl" } as const;

export function Modal({ title, subtitle, icon, onClose, children, size = "md", footer }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; size?: "sm" | "md" | "lg"; footer?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const { id, closing, close } = useModalLifecycle(onClose, panel);
  useEffect(() => {
    // Leave focus where it is if a field inside asked for it (autoFocus); otherwise focus the dialog itself.
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
  }, []);
  const hasBody = children !== null && children !== undefined && children !== false;
  return createPortal(
    <div className="fixed inset-0 z-(--z-modal) flex items-end sm:items-center justify-center p-2 sm:p-6">
      <div aria-hidden className={cn("absolute inset-0 bg-scrim backdrop-blur-xs", closing ? "modal-backdrop-out" : "modal-backdrop-in")} onMouseDown={close} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={cn("relative w-full max-h-[calc(100dvh-16px)] sm:max-h-[calc(100dvh-48px)] flex flex-col rounded-2xl bg-surface border border-line-strong shadow-modal outline-none", SIZES[size], closing ? "modal-out" : "modal-in")}
      >
        <div className={cn("flex items-start gap-3 px-5 pt-5", hasBody ? "pb-4" : "pb-5")}>
          {icon && <span className="mt-0.5 shrink-0 text-ink-2">{icon}</span>}
          <div className="flex-1 min-w-0">
            <h2 id={`${id}-title`} className="text-lg font-semibold text-balance">{title}</h2>
            {subtitle && <div className="text-compact text-ink-3 mt-1 text-pretty">{subtitle}</div>}
          </div>
          <button type="button" onClick={close} className="transition-control -mr-1.5 -mt-1 h-9 w-9 rounded-full hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-ink shrink-0" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        {hasBody && (
          <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
            <InModal.Provider value={true}>{children}</InModal.Provider>
          </div>
        )}
        {footer && <div className="px-5 py-3.5 border-t border-line bg-surface-2/40 rounded-b-2xl flex flex-wrap items-center justify-end gap-2">{footer}</div>}
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

/** The full-screen settings modal: categories on the left, the section on the right. */
export function SettingsModal({ sections, active, onSelect, onClose, footer }: { sections: SettingsSection[]; active: string; onSelect: (id: string) => void; onClose: () => void; footer?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const { id, closing, close } = useModalLifecycle(onClose, panel);
  const current = sections.find((s) => s.id === active) ?? sections[0];
  const groups = [...new Set(sections.map((s) => s.group))];
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
  }, []);
  return createPortal(
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className={cn("fixed inset-0 z-(--z-modal) flex bg-bg outline-none", closing ? "settings-out" : "settings-in")}>
      <nav aria-label="Settings" className={cn("w-full sm:w-auto sm:flex-[1_0_220px] bg-surface/70 border-r border-line justify-end overflow-y-auto", navOpen ? "flex absolute inset-0 z-(--z-raised) sm:static" : "hidden sm:flex")}>
        <div className="w-full sm:w-58 pt-16 pb-10 px-3 sm:px-2.5">
          {groups.map((g) => (
            <div key={g} className="mb-5">
              <div className="px-2.5 mb-1 text-micro font-semibold uppercase tracking-label text-ink-3">{g}</div>
              {sections.filter((s) => s.group === g).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => { onSelect(s.id); setNavOpen(false); }}
                  aria-current={s.id === current.id ? "page" : undefined}
                  className={cn("transition-control w-full flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-sm text-left", s.id === current.id ? "bg-surface-3 text-ink font-medium" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}
                >
                  <span className={s.id === current.id ? "text-ink-2" : "text-ink-3"}>{s.icon}</span>
                  {s.label}
                </button>
              ))}
            </div>
          ))}
          {footer && <div className="mt-2 pt-3 border-t border-line">{footer}</div>}
        </div>
      </nav>
      <div className="flex-[1_1_800px] min-w-0 overflow-y-auto">
        <div className="max-w-190 px-4 sm:px-10 pt-16 pb-14 relative">
          <button type="button" onClick={() => setNavOpen(true)} className="sm:hidden mb-5 -ml-1 inline-flex items-center gap-1.5 h-9 px-1 text-compact text-ink-3 hover:text-ink"><ArrowLeft className="h-4 w-4" />All settings</button>
          <h1 id={`${id}-title`} className="sr-only">{current.label}</h1>
          <InModal.Provider value={true}>
            <div key={current.id} className="fade-in">{current.render()}</div>
          </InModal.Provider>
        </div>
      </div>
      <div className="hidden sm:block flex-[0_0_88px] pt-16">
        <button type="button" onClick={close} className="transition-control group flex flex-col items-center gap-1.5 text-ink-3 hover:text-ink" aria-label="Close settings">
          <span className="h-9 w-9 rounded-full border-2 border-current flex items-center justify-center"><X className="h-4 w-4" /></span>
          <span className="text-xs font-semibold">Esc</span>
        </button>
      </div>
      <button type="button" onClick={close} className="sm:hidden absolute right-3 top-3 h-10 w-10 rounded-full bg-surface-2 border border-line flex items-center justify-center z-(--z-popover)" aria-label="Close settings"><X className="h-4 w-4" /></button>
    </div>,
    document.body,
  );
}
