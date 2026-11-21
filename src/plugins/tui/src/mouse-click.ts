/** Shared mouse-event helpers for OpenTUI shortcuts and dialog controls.
 *
 *  Opening or closing a dialog inside `onMouseDown` lets the subsequent
 *  `mouseup` event hit the newly-mounted (or underlying) surface — e.g. the
 *  dialog backdrop's `onMouseUp` immediately dismisses a freshly opened modal.
 *  Handling clicks on `onMouseUp` after stopping propagation on both `down`
 *  and `up` keeps opened windows persistent across mouse release. */

export function stopMouseEvent(event: unknown): void {
  const stop = (event as { stopPropagation?: () => void } | null | undefined)?.stopPropagation
  if (typeof stop === 'function') stop.call(event)
}

export function handleMouseClick(event: unknown, action: (() => void) | undefined): void {
  stopMouseEvent(event)
  action?.()
}
