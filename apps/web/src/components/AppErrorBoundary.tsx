import { Component, type ErrorInfo, type ReactNode } from 'react'
import { captureError } from '../lib/analytics.ts'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Root-shell error boundary: reports render-phase crashes to PostHog
 * (captureError no-ops when analytics is unconfigured) and shows a minimal
 * recovery card instead of a white page. The error is also re-logged to the
 * console — reporting never hides it.
 */
export default class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error:', error)
    captureError(error, {
      $exception_source: 'react-error-boundary',
      ...(info.componentStack ? { componentStack: info.componentStack } : {}),
    })
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-[var(--bg-base)] px-4">
          <section className="island-shell w-full max-w-md px-8 py-12 text-center">
            <h1 className="display-title m-0 mb-2 text-2xl font-bold tracking-tight text-[var(--ink)]">
              Something went wrong
            </h1>
            <p className="m-0 mb-6 text-sm text-[var(--ink-soft)]">
              The page hit an unexpected error. Your document edits are synced as you type, so nothing is lost.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-transparent bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--accent-deep)]"
            >
              Reload
            </button>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}
