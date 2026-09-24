import { freshSandboxId } from "./protocol";
import type { BuildSandbox } from "./sandbox";

/**
 * Every secret the manager stores on this Worker deploys a new version of it,
 * and a new version resets its Durable Objects, with them any container that
 * is just starting. The Sandbox SDK (0.12.10) then fails the call with one of
 * these messages: its own `OperationInterruptedError` ("Sandbox operation
 * sandbox.exec was interrupted while the platform was updating the sandbox
 * runtime"), or the runtime's "Durable Object reset because its code was
 * updated".
 */
const RUNTIME_UPDATE = [
  /interrupted while the platform was updating the sandbox runtime/i,
  /reset because its code was updated/i,
];

/** Whether an error (or one of its causes) says a new version of this Worker reset the container. */
export function isRuntimeUpdate(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    const message =
      typeof current === "object" && "message" in current ? String(current.message) : "";
    if (RUNTIME_UPDATE.some((pattern) => pattern.test(message))) return true;
    current = typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return false;
}

/** The run log's line for a restart: a note, not a failure. */
export function restartNote(reason: string): string {
  return `A new version of this Worker reset the container as it started (${reason}); starting again in a fresh container.`;
}

/**
 * The container of one run, which starts over once when a new version of
 * this Worker resets it before its first call has gone through: that call
 * goes to a fresh container (`<id>-r`), and the reset one is stopped if it
 * still can be. A run that is cut off later, or whose fresh container is
 * reset too, fails as before (retryable, so the manager may run it again).
 * `onRestart` gets the reason, for the run's log.
 */
export function restartOnRuntimeUpdate(
  open: (id: string) => BuildSandbox,
  id: string,
  onRestart: (reason: string) => void,
): BuildSandbox {
  let current = open(id);
  let started = false;

  async function call<T>(operation: (sandbox: BuildSandbox) => Promise<T>): Promise<T> {
    if (started) return operation(current);
    try {
      return await operation(current);
    } catch (error) {
      if (!isRuntimeUpdate(error)) throw error;
      onRestart(error instanceof Error ? error.message : String(error));
      const reset = current;
      try {
        await reset.destroy();
      } catch {
        // It was reset already; nothing is left to stop.
      }
      current = open(freshSandboxId(id));
      return await operation(current);
    } finally {
      started = true;
    }
  }

  return {
    gitCheckout: (repoUrl, options) => call((s) => s.gitCheckout(repoUrl, options)),
    exec: (command, options) => call((s) => s.exec(command, options)),
    writeFile: (path, content) => call((s) => s.writeFile(path, content)),
    mountBucket: (binding, mountPath, prefix) =>
      call((s) => s.mountBucket(binding, mountPath, prefix)),
    unmountBucket: (mountPath) => call((s) => s.unmountBucket(mountPath)),
    destroy: () => current.destroy(),
  };
}
