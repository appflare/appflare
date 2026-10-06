import type { Ref } from "react";

/**
 * Sets a ref of either kind, for an element that needs two: the one a Kumo
 * trigger passes in its render props, and one of the component's own.
 */
export function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref != null) ref.current = value;
}
