import { Banner, Link, Text } from "@cloudflare/kumo";
import { PowerIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { SANDBOX_CHECKLIST_HREF, SANDBOX_FIRST_NOTE } from "../sandbox/readiness";

/**
 * Sandbox builds turned on at first need, as the install and build
 * confirmations say it: the line added when this install or build turns
 * them on first, and the refusal when the account lacks something they
 * need, with a link to the account checklist's sandbox builds row.
 */

/** The label of every link to the checklist row. */
export const SANDBOX_CHECKLIST_LINK_LABEL = "Sandbox builds in the account checklist";

export function SandboxFirstNote() {
  return (
    <Text as="span" variant="secondary" size="sm">
      <span className="inline-flex items-center gap-1.5">
        <PowerIcon aria-hidden />
        {SANDBOX_FIRST_NOTE}
      </span>
    </Text>
  );
}

/** Why the sandbox cannot be turned on, with the checklist link. */
export function SandboxMissingBanner({ title, missing }: { title: string; missing: string }) {
  return (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title={title}
      description={
        <div className="grid gap-2">
          <span>{missing}</span>
          <Link href={SANDBOX_CHECKLIST_HREF}>{SANDBOX_CHECKLIST_LINK_LABEL}</Link>
        </div>
      }
    />
  );
}
