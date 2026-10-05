import { useEffect, useRef, useState } from "react";
import {
  type TakenWorkerNames,
  WORKER_NAME_CHECK_DELAY_MS,
  type WorkerNameCheck,
  workerNameFormatProblem,
  workerNameVerdict,
} from "../installs/worker-name-check";
import { listTakenWorkerNames } from "../installs/worker-names.functions";

/**
 * The live check of the install form's Worker name (`worker-name-check.ts`),
 * or null while it does not apply (`enabled` false: a fixed name, or a form
 * that cannot install). The format is checked on every keystroke; whether the
 * name is free, once typing pauses, against the names in use, which are read
 * from the server once for the form's lifetime (again only after a failed
 * read).
 */
export function useWorkerNameCheck(
  name: string,
  enabled: boolean,
  /**
   * "Install again": the failed install the new one replaces. The server
   * leaves its names out, by install, since its removal frees them first.
   */
  replaces: string | null = null,
): WorkerNameCheck | null {
  const taken = useRef<Promise<TakenWorkerNames | null> | null>(null);
  const [answer, setAnswer] = useState<{ name: string; check: WorkerNameCheck } | null>(null);
  const formatProblem = workerNameFormatProblem(name);

  useEffect(() => {
    if (!enabled || formatProblem !== null) return;
    let live = true;
    const timer = setTimeout(() => {
      taken.current ??= listTakenWorkerNames(
        replaces === null ? undefined : { data: { replaces } },
      ).catch(() => {
        taken.current = null;
        return null;
      });
      void taken.current.then((names) => {
        if (live) setAnswer({ name, check: workerNameVerdict(name, names) });
      });
    }, WORKER_NAME_CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [name, enabled, formatProblem, replaces]);

  if (!enabled) return null;
  if (formatProblem !== null) return { state: "invalid", message: formatProblem };
  return answer?.name === name ? answer.check : { state: "checking" };
}

/** Under the field when the account's Workers could not be read, so only the format was checked. */
export const UNCHECKED_NOTE = "Could not check the account's Workers; installing checks again.";
