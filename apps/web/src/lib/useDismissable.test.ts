// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { renderHook } from '@testing-library/react'
import { useDismissable } from './useDismissable.ts'

const pointerDownOn = (target: EventTarget) =>
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }))

const pressEscape = () =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

function setup(open: boolean) {
  const wrapper = document.createElement('div')
  const inside = document.createElement('button')
  wrapper.appendChild(inside)
  const outside = document.createElement('div')
  document.body.appendChild(wrapper)
  document.body.appendChild(outside)

  const ref = createRef<HTMLElement>()
  ;(ref as { current: HTMLElement | null }).current = wrapper
  const onDismiss = vi.fn()
  const hook = renderHook(
    ({ open }: { open: boolean }) => useDismissable(open, ref, onDismiss),
    { initialProps: { open } },
  )
  return { wrapper, inside, outside, onDismiss, hook }
}

describe('useDismissable', () => {
  it('dismisses on pointerdown outside the ref', () => {
    const { outside, onDismiss } = setup(true)
    pointerDownOn(outside)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not dismiss on pointerdown inside the ref', () => {
    const { inside, onDismiss } = setup(true)
    pointerDownOn(inside)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('dismisses on Escape', () => {
    const { onDismiss } = setup(true)
    pressEscape()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    const { onDismiss } = setup(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('does nothing while closed, and detaches listeners on close', () => {
    const { outside, onDismiss, hook } = setup(false)
    pointerDownOn(outside)
    pressEscape()
    expect(onDismiss).not.toHaveBeenCalled()

    hook.rerender({ open: true })
    pointerDownOn(outside)
    expect(onDismiss).toHaveBeenCalledTimes(1)

    hook.rerender({ open: false })
    pointerDownOn(outside)
    pressEscape()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
