import { InputGroup } from "@cloudflare/kumo";
import { CheckCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { WORKER_NAME_MAX_LENGTH } from "../installs/install-input";
import {
  type TakenWorkerNames,
  WORKER_NAME_CHECK_DELAY_MS,
  type WorkerNameCheck,
  workerNameFormatProblem,
  workerNameVerdict,
} from "../installs/worker-name-check";
import { listTakenWorkerNames } from "../installs/worker-names.functions";
import { AppflareLoader } from "./appflare-loader";
import { tooltipContent } from "./tooltip";

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

/** What a screen reader hears as the check changes (the icons say it visually). */
function announcement(check: WorkerNameCheck | null): string {
  switch (check?.state) {
    case "checking":
      return "Checking the name.";
    case "free":
      return "The name is free.";
    case "taken":
    case "invalid":
      return check.message;
    case "unknown":
      return UNCHECKED_NOTE;
    default:
      return "";
  }
}

/** Under the field when the account's Workers could not be read, so only the format was checked. */
export const UNCHECKED_NOTE = "Could not check the account's Workers; installing checks again.";

/**
 * The install form's Worker name, shown as the app's workers.dev address,
 * with its live check at the end of the field the way Kumo's InputGroup
 * shows one: a spinner while checking, a check mark when the name is free,
 * and a cross with the reason when it is taken or breaks the rules.
 */
export function WorkerNameField({
  value,
  onChange,
  check,
  subdomain,
  description,
  readOnly,
}: {
  value: string;
  onChange(value: string): void;
  /** `useWorkerNameCheck`; null shows no state. */
  check: WorkerNameCheck | null;
  /** The account's workers.dev subdomain, or null when unknown. */
  subdomain: string | null;
  description: string;
  /** The app only works under this name. */
  readOnly: boolean;
}) {
  const refused = check?.state === "invalid" || check?.state === "taken" ? check.message : null;
  return (
    <>
      <InputGroup
        label="Worker name"
        labelTooltip={tooltipContent(
          "Resources are named after it. Each install of an app needs its own Worker name.",
        )}
        error={refused === null ? undefined : { message: refused, match: true }}
        description={
          check?.state === "unknown" ? (
            <>
              {description}
              <span data-name-unchecked className="block">
                {UNCHECKED_NOTE}
              </span>
            </>
          ) : (
            description
          )
        }
      >
        <InputGroup.Addon>https://</InputGroup.Addon>
        <InputGroup.Input
          aria-label="Worker name"
          value={value}
          onChange={(e) => onChange(e.currentTarget.value.trim())}
          readOnly={readOnly}
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={WORKER_NAME_MAX_LENGTH}
        />
        <InputGroup.Suffix>.{subdomain ?? "<your subdomain>"}.workers.dev</InputGroup.Suffix>
        {check !== null && check.state !== "unknown" && (
          <InputGroup.Addon align="end">
            <span data-name-check={check.state} className="flex">
              {check.state === "checking" ? (
                <AppflareLoader />
              ) : check.state === "free" ? (
                <CheckCircleIcon aria-hidden weight="duotone" className="text-kumo-success" />
              ) : (
                <XCircleIcon aria-hidden weight="duotone" className="text-kumo-danger" />
              )}
            </span>
          </InputGroup.Addon>
        )}
      </InputGroup>
      {/* Absolutely placed, so it takes no cell of the form's grid. */}
      <span role="status" data-name-status className="sr-only">
        {announcement(check)}
      </span>
    </>
  );
}
