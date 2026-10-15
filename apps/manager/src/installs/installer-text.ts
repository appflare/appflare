import {
  hasSelfDeployingPlaceholder,
  renderSelfDeployingPlaceholders,
  type SelfDeployingTextValues,
  selfDeployingStage,
} from "@appflare/schema";

/**
 * The text of a self-deploying entry that people read before and after the
 * install (its fields' help, its post-install notes), with the install's
 * stage and the account's workers.dev subdomain filled in. The install form
 * knows the stage before the install starts (the page made the install id),
 * so an entry can spell out an address of one of its installer's Workers
 * that the admin registers elsewhere first, such as an OAuth callback; the
 * form offers each such address to copy. Client-safe.
 */

/** The values for an install `installId` (null while it has none) on an account. */
export function installerTextValues(
  installId: string | null,
  workersDevSubdomain: string | null,
): SelfDeployingTextValues {
  return {
    stage: installId === null ? null : selfDeployingStage(installId),
    workersDevSubdomain,
  };
}

/** `help` with the stage and subdomain filled in; undefined stays undefined. */
export function installerHelp(
  help: string | undefined,
  values: SelfDeployingTextValues,
): string | undefined {
  return help === undefined ? undefined : renderSelfDeployingPlaceholders(help, values);
}

/** An address in running text, up to the next space. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;

/** Punctuation that ends a sentence after an address rather than belonging to it. */
const TRAILING = /[.,;:!?)\]]+$/;

/**
 * The addresses in `help` that name the install's stage or the account's
 * subdomain, filled in, each once and in order: what the form offers to
 * copy. One that cannot be filled in yet (the subdomain is not known) is
 * left out, so nothing half-filled is ever copied.
 */
export function installerAddresses(
  help: string | undefined,
  values: SelfDeployingTextValues,
): string[] {
  if (help === undefined) return [];
  const found: string[] = [];
  for (const match of help.matchAll(URL_PATTERN)) {
    const written = match[0].replace(TRAILING, "");
    if (!hasSelfDeployingPlaceholder(written)) continue;
    const filled = renderSelfDeployingPlaceholders(written, values);
    if (hasSelfDeployingPlaceholder(filled) || found.includes(filled)) continue;
    found.push(filled);
  }
  return found;
}
