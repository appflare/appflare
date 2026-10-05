import { Banner, Collapsible, LinkButton } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ArrowRightIcon, InfoIcon } from "@phosphor-icons/react";
import type { InstallAgainRecord } from "../installs/install-again";
import { resourceKindLabel } from "./format";

const mono = "font-mono text-[0.9em]";

/**
 * Above the install form on "Install again": what happens (the install that
 * did not finish is uninstalled first, keeping nothing, then the app is
 * installed with the choices from last time), what must be entered again,
 * and what changed in the catalog since. When it cannot be installed again
 * now, why, and that the form installs the app anew.
 */
export function InstallAgainBanner({
  again,
  appName,
  changes,
  reenter,
}: {
  again: InstallAgainRecord;
  appName: string;
  /** What changed since the failed install, one sentence each (`installAgainPrefill`). */
  changes: readonly string[];
  /** What must be entered again (`reenterNote`); null when nothing. */
  reenter: string | null;
}) {
  if (again.refusal !== null) {
    return (
      <Banner
        variant="secondary"
        icon={<InfoIcon weight="fill" />}
        title={`${again.label} cannot be installed again from here`}
        description={`${again.refusal} The form below installs ${appName} anew.`}
      />
    );
  }
  const left = again.leftovers.length;
  return (
    <Banner
      variant="secondary"
      icon={<ArrowCounterClockwiseIcon />}
      title={`Installing ${again.label} again`}
      description={
        <span className="grid gap-2">
          <span>
            The form has the choices from the install that did not finish.{" "}
            {left === 0
              ? "It left nothing in your account."
              : `Installing removes what it left in your account first (${left === 1 ? "1 item" : `${left} items`}), keeping nothing, so nothing is created twice.`}
          </span>
          {reenter !== null && <span>{reenter}</span>}
          {changes.map((change) => (
            <span key={change}>{change}</span>
          ))}
          {left > 0 && (
            <Collapsible.Root>
              <Collapsible.DefaultTrigger>What it left</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <ul className="grid list-disc gap-1 pl-5">
                  {again.leftovers.map((r) => (
                    <li key={`${r.kind}:${r.name}`}>
                      {resourceKindLabel(r.kind)} <span className={mono}>{r.name}</span>
                    </li>
                  ))}
                </ul>
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </span>
      }
      action={
        again.failedJobId === null ? undefined : (
          <LinkButton
            href={`/jobs/${again.failedJobId}`}
            variant="secondary"
            icon={<ArrowRightIcon />}
          >
            View log
          </LinkButton>
        )
      }
    />
  );
}
