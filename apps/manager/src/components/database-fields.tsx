import {
  type CatalogHyperdrive,
  connectionStringExample,
  databaseProtocolName,
  hyperdriveFieldLabel,
  parseConnectionString,
} from "@appflare/schema";
import { SensitiveInput, Text } from "@cloudflare/kumo";

/**
 * The connection string fields of an app that reaches databases elsewhere
 * through Hyperdrive (its catalog manifest's `resources.hyperdrive`), one
 * per database. Shared by the install form and the app's Settings section.
 * A value is checked as it is typed; the check never repeats any part of it,
 * since it holds a password. Appflare never stores it: the job turns it into
 * a Hyperdrive configuration in the account.
 */

/** The problem with an entered connection string, or null when it is usable (or still empty). */
export function connectionFieldProblem(decl: CatalogHyperdrive, value: string): string | null {
  if (value.trim().length === 0) return null;
  const parsed = parseConnectionString(value, decl.protocol);
  return parsed.ok ? null : parsed.problem;
}

/** Whether every database has a usable connection string. */
export function connectionsComplete(
  databases: readonly CatalogHyperdrive[],
  values: Readonly<Record<string, string>>,
): boolean {
  return databases.every(
    (d) => parseConnectionString(values[d.binding] ?? "", d.protocol).ok === true,
  );
}

/** One database's connection string field. */
export function DatabaseField({
  decl,
  value,
  onChange,
  label = hyperdriveFieldLabel(decl),
}: {
  decl: CatalogHyperdrive;
  value: string;
  onChange(value: string): void;
  label?: string;
}) {
  const problem = connectionFieldProblem(decl, value);
  const help = [
    decl.help,
    `A ${databaseProtocolName(decl.protocol)} connection string, such as ${connectionStringExample(decl.protocol)}. The database must accept connections from the internet.`,
  ]
    .filter((t) => t !== undefined)
    .join(" ");
  return (
    <SensitiveInput
      label={label}
      value={value}
      onValueChange={(next: string) => onChange(next)}
      autoComplete="off"
      spellCheck={false}
      required
      description={help}
      variant={problem === null ? "default" : "error"}
      error={problem === null ? undefined : { message: problem, match: true }}
    />
  );
}

/** The install form's "Databases" group: one field per database the app connects to. */
export function DatabaseFields({
  databases,
  values,
  onChange,
}: {
  databases: readonly CatalogHyperdrive[];
  values: Readonly<Record<string, string>>;
  onChange(binding: string, value: string): void;
}) {
  if (databases.length === 0) return null;
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Text bold>Databases</Text>
        <Text variant="secondary" size="sm">
          This app keeps its data in a database you run elsewhere, reached through Cloudflare
          Hyperdrive. Appflare creates a Hyperdrive configuration from each connection string and
          never stores the string itself.
        </Text>
      </div>
      {databases.map((decl) => (
        <DatabaseField
          key={decl.binding}
          decl={decl}
          value={values[decl.binding] ?? ""}
          onChange={(value) => onChange(decl.binding, value)}
        />
      ))}
    </div>
  );
}
