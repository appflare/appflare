import type { AccessOffer } from "@appflare/schema";
import { Checkbox, Link, Text } from "@cloudflare/kumo";
import { useEffect, useId, useState } from "react";
import {
  type AppAccessCheck,
  type AppAccessProblem,
  accessProblemFix,
  accessRequiredLine,
  publicPathsLine,
  signInNote,
  whoGetsIn,
  zeroTrustUsersNote,
} from "../access/app-access";
import { checkAppAccess } from "../installs/access-change.functions";
import { DocsLink } from "./docs-link";

/**
 * Runs the admin-only Access check (`checkAppAccess`) once while `enabled`:
 * whether the account can protect apps now, who gets in and how they sign
 * in. Null until it answers, and when it fails: the stored capability
 * probes stand in, and the server checks again when the install starts.
 */
export function useAppAccessCheck(enabled: boolean): AppAccessCheck | null {
  const [check, setCheck] = useState<AppAccessCheck | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    checkAppAccess().then(
      (result) => {
        if (live) setCheck(result);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return check;
}

/**
 * The install form's "Protect with Cloudflare Access": off by default, on
 * when the app's catalog entry recommends it, on and fixed when it requires
 * it. While the account cannot protect apps (no Zero Trust organization, or
 * the token lacks an Access permission) it is off and disabled, with the
 * reason and where to fix it; an app that requires it keeps it on and the
 * install waits for the fix. Under it: who gets in, how they sign in, and
 * what stays public.
 */
export function InstallAccessField({
  appName,
  offer,
  publicPaths,
  checked,
  onCheckedChange,
  problem,
  check,
  disabled,
}: {
  appName: string;
  offer: AccessOffer;
  /** The entry's `access.bypass`. */
  publicPaths: readonly string[];
  /** What the admin chose (the entry's suggestion until they change it). */
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  /** What stands in the way of protecting the app; null when nothing is known to. */
  problem: AppAccessProblem | null;
  /** The live check, once it answered. */
  check: AppAccessCheck | null;
  disabled: boolean;
}) {
  const required = offer === "required";
  const fix = problem === null ? null : accessProblemFix(problem.kind);
  const usersNote = zeroTrustUsersNote(check?.users ?? null);
  const explanationId = useId();
  // Kumo's Checkbox passes `aria-describedby` on to the control, but its
  // props type does not list it; the spread keeps the type check quiet.
  const describedBy: Record<string, string> = { "aria-describedby": explanationId };
  return (
    <div id="install-access" className="grid gap-2">
      <Checkbox
        label="Protect with Cloudflare Access"
        checked={required || (checked && problem === null)}
        disabled={disabled || required || problem !== null}
        onCheckedChange={(next: boolean) => onCheckedChange(next)}
        {...describedBy}
      />
      <div id={explanationId} className="grid gap-1 pl-6">
        {required && (
          <Text as="p" variant="secondary" size="sm">
            {accessRequiredLine(appName)}
          </Text>
        )}
        {problem !== null && fix !== null && (
          <Text as="p" size="sm">
            {problem.message} {/* In the middle of an install: the fix opens in a new tab. */}
            <Link href={fix.href} target="_blank" rel="noopener noreferrer">
              {fix.label}
            </Link>
          </Text>
        )}
        <Text as="p" variant="secondary" size="sm">
          {whoGetsIn(check?.users ?? null)}{" "}
          {signInNote(check ?? { loginMethods: null, oneTimePin: false })}
        </Text>
        <Text as="p" variant="secondary" size="sm">
          {publicPathsLine(publicPaths)} <DocsLink topic="protectApps" variant="inline" />
        </Text>
        {usersNote !== null && (
          <Text as="p" variant="secondary" size="sm">
            {usersNote}
          </Text>
        )}
      </div>
    </div>
  );
}
