/**
 * Placeholders: `{{name}}` in a catalog manifest's text that the manager
 * fills in with the install's own values. One list, with what each one
 * means and which fields take it, so the schema, the manager, the packer and
 * the catalog checks agree.
 *
 * This module imports nothing: `catalog.ts` imports it, and the JSON Schema
 * export runs `catalog.ts` directly under Node's type stripping.
 */

/** One placeholder: its name, whether it has a per-Worker form, and what it becomes. */
export interface PlaceholderInfo {
  name: string;
  /**
   * Whether `{{<name>:<worker>}}` names one Worker of an entry that installs
   * as several (`install.workers`), by its name within the entry.
   */
  perWorker: boolean;
  /** What the manager fills in, in plain words. */
  meaning: string;
}

/**
 * Every placeholder, in the order documentation lists them.
 *
 * The address forms: `{{appUrl}}` is where people reach the app, which is
 * what a link in the app's settings or its setup notes should use.
 * `{{workerUrl}}` is always the workers.dev address, for the rare app that
 * must name that address even when a custom domain serves it.
 */
export const PLACEHOLDERS = [
  {
    name: "appUrl",
    perWorker: true,
    meaning:
      "The address the app is served at, as an https:// URL without a trailing slash: its " +
      "custom domain while workers.dev is turned off for it, else its workers.dev URL. When a " +
      "domain is added or removed, the manager fills the app's settings in again.",
  },
  {
    name: "appHostname",
    perWorker: true,
    meaning: "The hostname of {{appUrl}}, without https://, for example `links.example.com`.",
  },
  {
    name: "workerUrl",
    perWorker: true,
    meaning:
      "The Worker's workers.dev URL, `https://<worker name>.<account subdomain>.workers.dev`, " +
      "without a trailing slash. Always the workers.dev address, even while a custom domain " +
      "serves the app.",
  },
  {
    name: "workerHostname",
    perWorker: true,
    meaning:
      "The hostname of {{workerUrl}}, without https://: " +
      "`<worker name>.<account subdomain>.workers.dev`.",
  },
  {
    name: "workerName",
    perWorker: true,
    meaning: "The name the Worker is installed under.",
  },
  {
    name: "accountId",
    perWorker: false,
    meaning:
      "The id of the Cloudflare account the app is installed in, for apps that call the " +
      "Cloudflare API about their own account.",
  },
  {
    name: "emailDomain",
    perWorker: false,
    meaning:
      "For an app with `install.emailRouting`, the name of the zone whose mail it receives, " +
      "the one the admin chose (`example.com`, no scheme), for an address such as " +
      "`accounts@{{emailDomain}}`. Empty while Appflare has no zone on record for the app. When " +
      "the admin moves the app's email to another zone, the manager fills the app's settings in " +
      "again.",
  },
  {
    name: "emailZoneId",
    perWorker: false,
    meaning:
      "For an app with `install.emailRouting`, the id of that zone, for apps that call the " +
      "Cloudflare API about it. Empty while Appflare has no zone on record for the app.",
  },
  {
    name: "wildcardHostname",
    perWorker: false,
    meaning:
      "For an app with `install.wildcardHostname`, the base hostname of its wildcard domain " +
      "(`tunnels.example.com`, no scheme); empty while none is assigned.",
  },
  {
    name: "accessTeamDomain",
    perWorker: false,
    meaning:
      "For an app Appflare protects with Cloudflare Access, the account's Zero Trust team " +
      "domain, `<team>.cloudflareaccess.com` (no scheme). The JWT Access sends the app in the " +
      "`Cf-Access-Jwt-Assertion` header is issued by `https://<team>.cloudflareaccess.com`. " +
      "Empty while the app is not protected.",
  },
  {
    name: "accessTeamName",
    perWorker: false,
    meaning:
      "For an app Appflare protects with Cloudflare Access, the account's Zero Trust team " +
      "name: the `<team>` of `<team>.cloudflareaccess.com`, for an app that builds the team's " +
      "addresses itself. Empty while the app is not protected.",
  },
  {
    name: "accessAud",
    perWorker: false,
    meaning:
      "For an app Appflare protects with Cloudflare Access, the audience (AUD) tag of the app's " +
      "Access application: the `aud` claim of the JWT Access sends the app. Empty while the app " +
      "is not protected. When protection is turned on or off, the manager fills the app's " +
      "settings in again.",
  },
  {
    name: "accessCertsUrl",
    perWorker: false,
    meaning:
      "For an app Appflare protects with Cloudflare Access, where the keys that sign its JWTs " +
      "are published: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Empty while " +
      "the app is not protected.",
  },
  {
    name: "stage",
    perWorker: false,
    meaning:
      "The install's stage, in the Worker names a self-deploying entry lists " +
      "(`install.selfDeploying.workerNames`) and nowhere else.",
  },
] as const satisfies readonly PlaceholderInfo[];

export type PlaceholderName = (typeof PLACEHOLDERS)[number]["name"];

/** Placeholders with a per-Worker form (`{{appUrl:api}}`). */
export type PerWorkerPlaceholderName = Extract<
  (typeof PLACEHOLDERS)[number],
  { perWorker: true }
>["name"];

/** The names of {@link PLACEHOLDERS}. */
export const PLACEHOLDER_NAMES: readonly PlaceholderName[] = PLACEHOLDERS.map((p) => p.name);

/** The placeholders that have a per-Worker form. */
export const PER_WORKER_PLACEHOLDER_NAMES: readonly PerWorkerPlaceholderName[] =
  PLACEHOLDERS.filter(
    (p): p is Extract<(typeof PLACEHOLDERS)[number], { perWorker: true }> => p.perWorker,
  ).map((p) => p.name);

/**
 * The placeholders of an app protected with Cloudflare Access: what the app
 * verifies Access's JWTs with. Only a var's value takes them; each is empty
 * while the app is not protected.
 */
export const ACCESS_PLACEHOLDERS = [
  "accessTeamDomain",
  "accessTeamName",
  "accessAud",
  "accessCertsUrl",
] as const satisfies readonly PlaceholderName[];
export type AccessPlaceholder = (typeof ACCESS_PLACEHOLDERS)[number];

/**
 * The placeholders of an app that receives email (`install.emailRouting`):
 * the zone whose mail it receives. Refused in an entry without it.
 */
export const EMAIL_PLACEHOLDERS = [
  "emailDomain",
  "emailZoneId",
] as const satisfies readonly PlaceholderName[];
export type EmailPlaceholder = (typeof EMAIL_PLACEHOLDERS)[number];

/** The placeholders a post-install note takes: the install's addresses and names. */
export const POST_INSTALL_PLACEHOLDERS = [
  "appUrl",
  "appHostname",
  "workerUrl",
  "workerHostname",
  "workerName",
  "accountId",
  ...EMAIL_PLACEHOLDERS,
  "wildcardHostname",
] as const satisfies readonly PlaceholderName[];

/**
 * The placeholders the manager fills in when it renders an app's text: every
 * one but `{{stage}}`, which only names a self-deploying entry's Workers.
 */
export const INSTALL_PLACEHOLDERS = [
  ...POST_INSTALL_PLACEHOLDERS,
  ...ACCESS_PLACEHOLDERS,
] as const satisfies readonly PlaceholderName[];
export type InstallPlaceholder = (typeof INSTALL_PLACEHOLDERS)[number];

/** The placeholder that names the install's stage in a self-deploying entry's Worker names. */
export const STAGE_PLACEHOLDER = "{{stage}}";

/**
 * The fields of a catalog manifest whose text may hold placeholders, and the
 * ones each takes:
 *
 * - `postInstall`: `postInstall[].content`, without the Access ones (a note
 *   people read has no use for a JWT audience tag);
 * - `varDefault`: `vars[].default`, and (for the packer) the string values
 *   of the wrangler config's `vars`, which the manager renders the same way;
 * - `selfDeployingWorkerName`: `install.selfDeploying.workerNames[]`.
 *
 * Secrets take none: their values are entered or generated, never filled in.
 */
export const PLACEHOLDER_FIELDS = {
  postInstall: POST_INSTALL_PLACEHOLDERS,
  varDefault: INSTALL_PLACEHOLDERS,
  selfDeployingWorkerName: ["stage"],
} as const satisfies Record<string, readonly PlaceholderName[]>;
export type PlaceholderField = keyof typeof PLACEHOLDER_FIELDS;

/** Lowercase letters, digits and inner hyphens: an entry Worker's name. */
const ENTRY_NAME = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

/**
 * The regular expression source of one {@link INSTALL_PLACEHOLDERS} entry as
 * written in a value (`{{ appUrl }}`), its name in the one capture group.
 * Exported as source text, not a shared `RegExp`, so callers build their own
 * and no `lastIndex` leaks between them.
 */
export const INSTALL_PLACEHOLDER_SOURCE = `\\{\\{\\s*(${INSTALL_PLACEHOLDERS.join("|")})\\s*\\}\\}`;

/**
 * The regular expression source of a per-Worker placeholder
 * (`{{appUrl:api}}`, `{{workerName:web}}`): the placeholder's name in the
 * first capture group, the entry Worker's name in the second.
 */
export const ENTRY_WORKER_PLACEHOLDER_SOURCE = `\\{\\{\\s*(${PER_WORKER_PLACEHOLDER_NAMES.join("|")}):(${ENTRY_NAME})\\s*\\}\\}`;

/**
 * The regular expression source of anything written like a placeholder:
 * `{{ word }}` or `{{ word:word }}`. The name in the first capture group,
 * the Worker (when there is one) in the second.
 */
export const PLACEHOLDER_LIKE_SOURCE =
  "\\{\\{\\s*([A-Za-z][A-Za-z0-9]*)(?::([A-Za-z0-9_-]+))?\\s*\\}\\}";

const PLACEHOLDER_PATTERN = new RegExp(INSTALL_PLACEHOLDER_SOURCE, "g");
const ENTRY_PLACEHOLDER_PATTERN = new RegExp(ENTRY_WORKER_PLACEHOLDER_SOURCE, "g");

/** Whether `text` holds a placeholder the manager fills in (not a per-Worker one). */
export function hasPlaceholder(text: string): boolean {
  return new RegExp(INSTALL_PLACEHOLDER_SOURCE).test(text);
}

/** The regular expression source of an {@link EMAIL_PLACEHOLDERS} entry as written in a value. */
export const EMAIL_PLACEHOLDER_SOURCE = `\\{\\{\\s*(?:${EMAIL_PLACEHOLDERS.join("|")})\\s*\\}\\}`;

/** Whether `text` holds `{{emailDomain}}` or `{{emailZoneId}}`. */
export function usesEmailPlaceholders(text: string): boolean {
  return new RegExp(EMAIL_PLACEHOLDER_SOURCE).test(text);
}

/** Whether `text` holds a per-Worker placeholder (`{{appUrl:api}}`). */
export function hasEntryWorkerPlaceholder(text: string): boolean {
  return new RegExp(ENTRY_WORKER_PLACEHOLDER_SOURCE).test(text);
}

/** The hostname of an `https://` URL: what follows the scheme, up to the first `/`. */
export function urlHostname(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "");
}

/** The values {@link renderPlaceholders} fills in. */
export interface PlaceholderValues {
  /** The installed Worker's name. */
  workerName: string;
  /**
   * The Worker's workers.dev URL, without a trailing slash. Null while the
   * account's workers.dev subdomain is unknown: `{{workerUrl}}` and
   * `{{workerHostname}}` are then kept as written.
   */
  workerUrl: string | null;
  /**
   * The address the app is served at: its custom domain while workers.dev is
   * off for it, else `workerUrl`. Null while it is unknown: `{{appUrl}}` and
   * `{{appHostname}}` are then kept as written.
   */
  appUrl: string | null;
  /**
   * The account's id. Absent or null where it is not known (a form rendering
   * a default before the install runs); `{{accountId}}` is then kept.
   */
  accountId?: string | null;
  /**
   * The base hostname of the install's wildcard domain; null or empty when
   * it has none, which fills in an empty string. Absent where it is not
   * known (a form showing a default); `{{wildcardHostname}}` is then kept.
   */
  wildcardHostname?: string | null;
  /**
   * What `{{emailDomain}}` and `{{emailZoneId}}` become: the zone whose mail
   * the app receives. Null when Appflare has no zone on record for it, which
   * fills both in empty. Absent where it is not known (a form showing a
   * default); they are then kept as written.
   */
  email?: EmailPlaceholderValues | null;
  /**
   * What `{{accessTeamDomain}}`, `{{accessTeamName}}`, `{{accessAud}}` and
   * `{{accessCertsUrl}}` become: the install's Cloudflare Access protection.
   * Null when the app is not protected, which fills all four in empty.
   * Absent where it is not known (a form showing a default); they are then
   * kept as written.
   */
  access?: AccessPlaceholderValues | null;
}

/** The values of the email placeholders: the zone whose mail an install receives. */
export interface EmailPlaceholderValues {
  /** The zone's name, `example.com`. */
  zoneName: string;
  /** The zone's id. */
  zoneId: string;
}

/** The values of the Access placeholders for a protected install. */
export interface AccessPlaceholderValues {
  /** `<team>.cloudflareaccess.com`. */
  teamDomain: string;
  /**
   * `<team>`. Absent in values recorded before it existed (a job's step
   * output): {@link accessTeamNameOf} works it out from `teamDomain`.
   */
  teamName?: string;
  /** The audience tag of the install's Access application. */
  aud: string;
  /** `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. */
  certsUrl: string;
}

/** The Zero Trust team domain's suffix: `<team>.cloudflareaccess.com`. */
const ACCESS_TEAM_DOMAIN_SUFFIX = ".cloudflareaccess.com";

/**
 * The team name of a Zero Trust team domain: `ada` for
 * `ada.cloudflareaccess.com`; empty for an empty domain.
 */
export function accessTeamNameOf(teamDomain: string): string {
  const domain = teamDomain.toLowerCase();
  return domain.endsWith(ACCESS_TEAM_DOMAIN_SUFFIX)
    ? domain.slice(0, -ACCESS_TEAM_DOMAIN_SUFFIX.length)
    : (domain.split(".")[0] ?? "");
}

/** `text` with every {@link INSTALL_PLACEHOLDERS} entry filled in; whitespace inside the braces is allowed. */
export function renderPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(PLACEHOLDER_PATTERN, (match, key: InstallPlaceholder) => {
    switch (key) {
      case "workerName":
        return values.workerName;
      case "workerUrl":
        return values.workerUrl ?? match;
      case "workerHostname":
        return values.workerUrl === null ? match : urlHostname(values.workerUrl);
      case "appUrl":
        return values.appUrl ?? match;
      case "appHostname":
        return values.appUrl === null ? match : urlHostname(values.appUrl);
      case "accountId":
        return values.accountId ?? match;
      case "wildcardHostname":
        return values.wildcardHostname === undefined ? match : (values.wildcardHostname ?? "");
      case "emailDomain":
        return values.email === undefined ? match : (values.email?.zoneName ?? "");
      case "emailZoneId":
        return values.email === undefined ? match : (values.email?.zoneId ?? "");
      case "accessTeamDomain":
        return values.access === undefined ? match : (values.access?.teamDomain ?? "");
      case "accessTeamName":
        return values.access === undefined
          ? match
          : values.access === null
            ? ""
            : (values.access.teamName ?? accessTeamNameOf(values.access.teamDomain));
      case "accessAud":
        return values.access === undefined ? match : (values.access?.aud ?? "");
      case "accessCertsUrl":
        return values.access === undefined ? match : (values.access?.certsUrl ?? "");
    }
  });
}

/** What the per-Worker placeholders become, by the Worker's name within the entry. */
export type EntryWorkerPlaceholders = Readonly<
  Record<string, { workerName: string; workerUrl: string | null; appUrl: string | null }>
>;

/**
 * `text` with every per-Worker placeholder filled in. A placeholder naming a
 * Worker the entry does not have, or an address not known yet, is kept as
 * written.
 */
export function renderEntryWorkerPlaceholders(
  text: string,
  workers: EntryWorkerPlaceholders,
): string {
  return text.replace(
    ENTRY_PLACEHOLDER_PATTERN,
    (match, key: PerWorkerPlaceholderName, name: string) => {
      const values = Object.hasOwn(workers, name) ? workers[name] : undefined;
      if (values === undefined) return match;
      switch (key) {
        case "workerName":
          return values.workerName;
        case "workerUrl":
          return values.workerUrl ?? match;
        case "workerHostname":
          return values.workerUrl === null ? match : urlHostname(values.workerUrl);
        case "appUrl":
          return values.appUrl ?? match;
        case "appHostname":
          return values.appUrl === null ? match : urlHostname(values.appUrl);
      }
    },
  );
}

/** A JSON value: what a wrangler config var holds when it is not a string. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * `value` with `render` applied to every string it holds, object keys
 * included (a JSON var keyed by `{{emailDomain}}`). Every key is copied as an
 * own property, `__proto__` included, so the value round-trips through
 * `JSON.stringify` unchanged; when two keys render alike, the later one wins,
 * as `JSON.parse` keeps the later of two equal keys.
 */
export function mapJsonText(value: JsonValue, render: (text: string) => string): JsonValue {
  if (typeof value === "string") return render(value);
  if (Array.isArray(value)) return value.map((item) => mapJsonText(item, render));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      // Plain assignment of `__proto__` would set the prototype instead.
      Object.defineProperty(out, render(key), {
        value: mapJsonText(item, render),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** `value` with placeholders filled in inside every string it holds, object keys included. */
export function renderJsonPlaceholders(value: JsonValue, values: PlaceholderValues): JsonValue {
  return mapJsonText(value, (text) => renderPlaceholders(text, values));
}

/** Every string inside a JSON value, object keys included: where placeholders are filled in. */
export function jsonTexts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(jsonTexts);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [key, ...jsonTexts(item)]);
  }
  return [];
}

/** Every object key inside a JSON value, at any depth. */
export function jsonKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonKeys);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [key, ...jsonKeys(item)]);
  }
  return [];
}

/**
 * Whether an object key inside a JSON value holds a placeholder, plain
 * (`{{appUrl}}`) or per-Worker (`{{appUrl:api}}`). Managers fill keys in
 * only since `"email-placeholders"`; an older one leaves such a key as
 * written.
 */
export function placeholderInJsonKey(value: unknown): boolean {
  return jsonKeys(value).some((key) => hasPlaceholder(key) || hasEntryWorkerPlaceholder(key));
}

/** What the placeholder checks read of an entry: its Workers, and whether it receives email. */
export interface PlaceholderWorkers {
  /** `install.workers`, or undefined for an entry of one Worker. */
  workers?: ReadonlyArray<{ name: string; workersDev: boolean }> | undefined;
  /**
   * Whether the entry sets `install.emailRouting`; without it,
   * `{{emailDomain}}` and `{{emailZoneId}}` are refused.
   */
  emailRouting?: boolean | undefined;
}

const ADDRESS_KINDS: ReadonlySet<string> = new Set([
  "appUrl",
  "appHostname",
  "workerUrl",
  "workerHostname",
]);

/**
 * What is wrong with the placeholders in `text` for `field`, one sentence
 * each; empty when nothing is. Refused: a placeholder the field does not
 * take (`{{stage}}` in a var's default), a known name in the wrong case
 * (`{{appURL}}`, which would be left as written), an email placeholder in
 * an entry that receives no email (`install.emailRouting`), a per-Worker
 * form on an entry of one Worker, one naming a Worker the entry does not
 * declare or that has no address (`workersDev: false`). Anything else in double braces
 * is not a placeholder and is left alone: an app may use that syntax itself.
 */
export function placeholderProblems(
  text: string,
  field: PlaceholderField,
  entry: PlaceholderWorkers = {},
): string[] {
  const allowed: readonly string[] = PLACEHOLDER_FIELDS[field];
  const problems: string[] = [];
  const byLowerName = new Map<string, PlaceholderInfo>(
    PLACEHOLDERS.map((p) => [p.name.toLowerCase(), p]),
  );
  for (const match of text.matchAll(new RegExp(PLACEHOLDER_LIKE_SOURCE, "g"))) {
    const written = match[0];
    const name = match[1] ?? "";
    const worker = match[2];
    const info = byLowerName.get(name.toLowerCase());
    if (info === undefined) continue;
    if (info.name !== name) {
      const fixed = worker === undefined ? `{{${info.name}}}` : `{{${info.name}:${worker}}}`;
      problems.push(
        `${written} is not a placeholder; placeholder names are case-sensitive, so write ${fixed}`,
      );
      continue;
    }
    if (!allowed.includes(info.name)) {
      problems.push(
        `${written} is not filled in here; this field takes ${allowed.map((n) => `{{${n}}}`).join(", ")}`,
      );
      continue;
    }
    if (
      entry.emailRouting !== true &&
      (EMAIL_PLACEHOLDERS as readonly string[]).includes(info.name)
    ) {
      problems.push(
        `${written} is filled in only for an app that receives email; this entry has no install.emailRouting`,
      );
      continue;
    }
    if (worker === undefined) continue;
    if (!info.perWorker) {
      problems.push(`${written} has no per-Worker form; write {{${info.name}}}`);
      continue;
    }
    const declared = entry.workers;
    if (declared === undefined) {
      problems.push(
        `${written} names one of an entry's Workers, but this entry installs one Worker (no install.workers); write {{${info.name}}}`,
      );
      continue;
    }
    const target = declared.find((w) => w.name === worker);
    if (target === undefined) {
      problems.push(
        `${written} names the Worker "${worker}", which install.workers does not declare`,
      );
    } else if (!target.workersDev && ADDRESS_KINDS.has(info.name)) {
      problems.push(
        `${written} names the Worker "${worker}", which sets workersDev to false and so has no address`,
      );
    }
  }
  return problems;
}
