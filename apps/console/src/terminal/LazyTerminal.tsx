import { lazy, Suspense, type ComponentProps } from "react";

// xterm.js is large, so the terminal loads only when a console is opened.
const TerminalImpl = lazy(() => import("./Terminal.tsx").then((m) => ({ default: m.Terminal })));

export function Terminal(props: ComponentProps<typeof TerminalImpl>) {
  return (
    <Suspense fallback={<div className={`rounded-xl border border-line bg-bg flex items-center justify-center text-[13px] text-ink-3 ${props.className ?? ""}`}>Opening console…</div>}>
      <TerminalImpl {...props} />
    </Suspense>
  );
}
