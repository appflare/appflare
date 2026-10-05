import { MAX_CONNECTION_STRING_LENGTH } from "@appflare/schema";
import { z } from "zod";
import { VALIDATION_METHODS } from "../gateway/gateway";
import { displayNameInput } from "./display-name";

/**
 * Client-safe install input rules shared by the `/catalog/$slug` form and the
 * `startInstall` server function (which re-validates against the catalog entry).
 */

/** Worker names Appflare accepts at install (editable, default from the catalog). */
/** A DNS label (it becomes `<name>.<subdomain>.workers.dev`): no leading or trailing dash. */
export const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?$/;

/** Longest Worker name accepted (the pattern above allows 54 characters). */
export const WORKER_NAME_MAX_LENGTH = 54;

export const WORKER_NAME_HINT =
  "1 to 54 lowercase letters, digits, or dashes, not starting or ending with a dash.";

export const workerNameSchema = z
  .string()
  .regex(WORKER_NAME_PATTERN, `The Worker name must be ${WORKER_NAME_HINT}`);

/** Values are bounded so a pasted blob cannot bloat the Workflow payload. */
const MAX_VALUE_LENGTH = 4096;

/**
 * The address an install gets besides workers.dev, added by the install job
 * once the Worker serves: a custom domain (a hostname in one of the
 * account's zones), an external domain (a hostname in someone else's DNS,
 * through the gateway), or, for an app whose manifest sets
 * `install.wildcardHostname`, a wildcard domain (a base hostname in one of
 * the account's zones, served with every name under it).
 */
export const installDomainInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("custom"),
    zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Choose a domain."),
    hostname: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal("external"),
    hostname: z.string().min(1).max(300),
    validation: z.enum(VALIDATION_METHODS),
  }),
  z.object({
    kind: z.literal("wildcard"),
    zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Choose a domain."),
    hostname: z.string().min(1).max(300),
    /** The admin agreed that the base is the zone itself (every name in it). */
    wholeDomain: z.boolean().optional(),
  }),
]);
export type InstallDomainInput = z.infer<typeof installDomainInput>;

export const startInstallInput = z.object({
  slug: z.string().min(1).max(100),
  workerName: workerNameSchema,
  /**
   * The install's display name. Several installs of one app may coexist; the
   * Worker name tells them apart (two installs that are not uninstalled never
   * share one), and this optional name is what people see instead. Empty or
   * missing: none, so the install goes by the app's name.
   */
  displayName: displayNameInput.optional(),
  /** Secret values by name. Never logged, never stored outside the Workflow payload. */
  secrets: z.record(z.string().max(200), z.string().max(MAX_VALUE_LENGTH)),
  /**
   * Connection strings by Hyperdrive binding, for an app that reaches a
   * database elsewhere (its catalog manifest's `resources.hyperdrive`).
   * Like secret values: never logged, never stored outside the Workflow
   * payload. Missing for a client that predates the field.
   */
  hyperdrive: z
    .record(z.string().max(200), z.string().max(MAX_CONNECTION_STRING_LENGTH))
    .optional(),
  vars: z.record(z.string().max(200), z.string().max(MAX_VALUE_LENGTH)),
  paidConfirmed: z.boolean(),
  /**
   * With `paidConfirmed`: also record Workers Paid as the account's plan in
   * Settings, so later installs and updates stop asking.
   */
  rememberPaidPlan: z.boolean().optional(),
  /**
   * The admin confirmed the account meets the app's `requires` (R2 enabled, a
   * zone, and so on). Refused when the app lists requirements and this is not
   * true. Defaults to false for a client that predates the field.
   */
  requirementsConfirmed: z.boolean().default(false),
  /**
   * The admin confirmed the cost of building a sandbox tier app in the
   * account's sandbox Worker (Workers Paid). Refused for such an app when not
   * true; ignored for others.
   */
  buildConfirmed: z.boolean().optional(),
  /**
   * A self-deploying tier app's own Cloudflare API token, created from the
   * entry's `tokenPermissions`. The install stores it as a secret on the
   * sandbox Worker, where the app's installer runs; Appflare keeps no copy.
   * Required for such an app; refused for others.
   */
  appToken: z.string().max(1024).optional(),
  /**
   * The zone whose email the app receives, for an app whose manifest sets
   * `install.emailRouting`; refused for any other app.
   */
  emailRouting: z
    .object({ zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Choose a zone.") })
    .optional(),
  /** A custom or external domain the install job adds once the Worker serves. */
  domain: installDomainInput.optional(),
  /**
   * Protect the app with Cloudflare Access from its first request on: only
   * Appflare's users get in. Refused for an app deployed by its own installer.
   */
  access: z.boolean().optional(),
  /**
   * "Install again": the failed install of the same app this one replaces.
   * What it left in the account is removed first (nothing is kept), and its
   * Worker name is free for the new install.
   */
  replaces: z.string().min(1).max(64).optional(),
});
export type StartInstallInput = z.infer<typeof startInstallInput>;

/** Length of a value generated for a `generate: "password"` secret. */
export const GENERATED_SECRET_LENGTH = 32;
