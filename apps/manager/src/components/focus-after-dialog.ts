/**
 * Focuses an element once a dialog that is closing has let go of the focus.
 * As the dialog unmounts, Base UI queues a microtask that gives the focus
 * back: to what had it before the dialog opened or, when that is gone (the
 * row it was in was deleted), to the last element still on the page that
 * had it before some other popup opened, which may be another row's button.
 * An effect committed with the unmount runs before that microtask, so the
 * element is looked up and focused from a zero-delay timer instead.
 */
export function focusAfterDialog(element: () => HTMLElement | null | undefined): void {
  setTimeout(() => element()?.focus(), 0);
}
