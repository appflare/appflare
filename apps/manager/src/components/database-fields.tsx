import {
  connectionStringExample,
  databaseProtocolName,
  type HyperdriveDeclaration,
  parseConnectionString,
} from "@appflare/schema";
import { SensitiveInput, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { FieldHelp, FieldLabel } from "./field-label";

/**
 * The connection string fields of an app that reaches databases elsewhere
 * through Hyperdrive (its catalog manifest's `resources.hyperdrive`), one
 * per database. Shared by the install form and the app's Settings section.
 * A value is checked as it is typed; the check never repeats any part of it,
 * since it holds a password. Appflare never stores it: the job turns it into
 * a Hyperdrive configuration in the account.
 */

/** The problem with an entered connection string, or null when it is usable (or still empty). */
export function connectionFieldProblem(decl: HyperdriveDeclaration, value: string): string | null {
  if (value.trim().length === 0) return null;
  const parsed = parseConnectionString(value, decl.protocol);
  return parsed.ok ? null : parsed.problem;
}

/** Whether every database has a usable connection string. */
export function connectionsComplete(
  databases: readonly HyperdriveDeclaration[],
  values: Readonly<Record<string, string>>,
): boolean {
  return databases.every(
    (d) => parseConnectionString(values[d.binding] ?? "", d.protocol).ok === true,
  );
}

/** Whether every optional connection string is left empty or usable. */
export function optionalConnectionsValid(
  databases: readonly HyperdriveDeclaration[],
  values: Readonly<Record<string, string>>,
): boolean {
  return databases.every((d) => connectionFieldProblem(d, values[d.binding] ?? "") === null);
}

/** One database's connection string field. */
export function DatabaseField({
  decl,
  value,
  onChange,
  label = (
    <FieldLabel
      label={decl.label ?? `${databaseProtocolName(decl.protocol)} connection string`}
      name={decl.binding}
    />
  ),
  required = true,
  disabled = false,
}: {
  decl: HyperdriveDeclaration;
  value: string;
  onChange(value: string): void;
  label?: ReactNode;
  /** False: empty is allowed (and keeps what is there); marked "(optional)" by the label. */
  required?: boolean;
  disabled?: boolean;
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
      required={required}
      disabled={disabled}
      description={<FieldHelp text={help} />}
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
  withHeading = true,
  replacing = false,
  disabled = false,
}: {
  databases: readonly HyperdriveDeclaration[];
  values: Readonly<Record<string, string>>;
  onChange(binding: string, value: string): void;
  /**
   * False inside a form group with a heading of its own: the fields then
   * follow the group's other fields, and the note sits under them.
   */
  withHeading?: boolean;
  /**
   * The update's optional fields for databases an earlier update already
   * connected: empty keeps that connection, a string replaces it.
   */
  replacing?: boolean;
  /** While the form is being sent: nothing can be changed. */
  disabled?: boolean;
}) {
  if (databases.length === 0) return null;
  const note = (
    <Text variant="secondary" size="sm">
      {replacing
        ? "An earlier update of this app already connected these databases. Leave a field empty to keep that connection, or enter a connection string to replace it. Appflare never stores the connection string."
        : "The app keeps its data in a database you run elsewhere. Appflare never stores the connection string."}
    </Text>
  );
  const fields = databases.map((decl) => (
    <DatabaseField
      key={decl.binding}
      decl={decl}
      value={values[decl.binding] ?? ""}
      onChange={(value) => onChange(decl.binding, value)}
      required={!replacing}
      disabled={disabled}
    />
  ));
  if (!withHeading) {
    return (
      <>
        {fields}
        {note}
      </>
    );
  }
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Text bold>{replacing ? "Databases already connected" : "Databases"}</Text>
        {note}
      </div>
      {fields}
    </div>
  );
}
