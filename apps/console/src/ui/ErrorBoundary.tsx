import { Component, type ErrorInfo, type ReactNode } from "react";
import { isStaleAssetError, reloadOnceForUpdate } from "../lib/staleAssets.ts";

/**
 * The last line of defence: a render or load error shows this page, not a blank screen. A stale tab after a deploy reloads itself
 * once; anything else says what happened and offers Reload. Plain elements and tokens only, so it still draws if a component failed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; updating: boolean }> {
  state = { error: null as Error | null, updating: false };

  static getDerivedStateFromError(error: Error) {
    return { error, updating: isStaleAssetError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ePaperclip console error:", error, info.componentStack);
    if (isStaleAssetError(error)) {
      const reloaded = reloadOnceForUpdate();
      if (!reloaded) this.setState({ updating: false });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const e = this.state.error;
    return (
      <div role="alert" className="min-h-screen flex items-center justify-center p-6 bg-surface text-ink">
        <div className="max-w-md">
          <h1 className="text-xl font-semibold mb-2">{this.state.updating ? "ePaperclip was updated" : "Something went wrong on this page"}</h1>
          <p className="mb-4 text-ink-2 leading-relaxed">{this.state.updating ? "Loading the new version…" : "Your work on the server is safe. Reload the page to continue. If it happens again, tell us what you did just before."}</p>
          <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 rounded-lg border border-line-strong text-sm hover:bg-surface-2">Reload</button>
          <details className="mt-4 text-xs text-ink-3"><summary className="cursor-pointer">Details</summary><pre className="whitespace-pre-wrap break-words">{e.name}: {e.message}</pre></details>
        </div>
      </div>
    );
  }
}
