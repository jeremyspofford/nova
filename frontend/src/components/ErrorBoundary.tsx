import { Component, type ErrorInfo, type ReactNode } from 'react';

/** The app had none, anywhere. A throw during render — a malformed SSE frame
 *  reaching renderItem was the reachable one — took out the whole page and
 *  left a white screen with the answer, the conversation and the canvas all
 *  gone. Losing one surface is survivable; losing the window is not.
 *
 *  Deliberately plain: no API calls, no hooks, no imports beyond React, so
 *  the fallback cannot fail the same way the thing it is catching did. */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[nova] render crash', this.props.label ?? '', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="p-4 m-4 rounded-lg border border-red-900/60 bg-red-950/30
                      text-sm text-stone-300 max-w-xl">
        <p className="font-medium text-red-300">
          {this.props.label ?? 'This part of the app'} hit an error and stopped.
        </p>
        <p className="mt-1 text-stone-400">
          The rest of Nova is still running. Reloading usually clears it.
        </p>
        <pre className="mt-2 p-2 rounded bg-black/40 text-[11px] text-stone-400
                        overflow-x-auto whitespace-pre-wrap">{String(error.message || error)}</pre>
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => this.setState({ error: null })}
            className="px-2 py-1 text-xs rounded bg-stone-800 hover:bg-stone-700">
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-2 py-1 text-xs rounded bg-stone-800 hover:bg-stone-700">
            Reload
          </button>
        </div>
      </div>
    );
  }
}
