import { useEffect, useRef, type RefObject } from 'react'

/**
 * Standard popover/menu dismissal: while `open`, a pointerdown outside
 * `ref` or pressing Escape calls `onDismiss`. Listeners are attached only
 * while open. Focus is never moved or trapped — dismissal just closes the
 * popover, so focus stays wherever the user put it.
 *
 * Put `ref` on a wrapper that contains BOTH the toggle button and the
 * popover panel: pointerdown fires before click, so if the toggle were
 * outside the ref, opening clicks on it would dismiss-then-reopen.
 */
export function useDismissable(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismissRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissRef.current()
    }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, ref])
}
