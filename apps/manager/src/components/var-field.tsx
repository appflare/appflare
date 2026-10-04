import { Input, InputArea, Radio, Select } from "@cloudflare/kumo";
import { useState } from "react";
import { type InstallVarField, MAX_CARD_OPTIONS, varValueProblem } from "../installs/install-vars";
import { FieldLabel, fieldDescription } from "./field-label";
import {
  describeChip,
  hasChips,
  type KnownPlaceholders,
  type PlaceholderOption,
} from "./placeholder-chips";
import { PlaceholderInput } from "./placeholder-input";
import { SEED_ONLY_VAR_NOTE } from "./secret-fields";

/** The choice cards' grid (Kumo's element inside the group): one column, two from `sm`. */
export const CHOICE_GRID = "[&>div]:grid-cols-1 sm:[&>div]:grid-cols-2";

/** What a form knows about the placeholders its settings may hold, for their chips. */
export interface PlaceholderChips {
  /** What each field's Insert menu offers. */
  options: readonly PlaceholderOption[];
  /** What each placeholder is filled in with, as far as the form knows. */
  known: KnownPlaceholders;
}

/**
 * One setting: a text field, a JSON field checked as the admin types, or for
 * a catalog `type: "select"` var its choices (cards for up to
 * {@link MAX_CARD_OPTIONS}, a dropdown beyond). A text setting whose default
 * or value holds install placeholders shows them as chips
 * (./placeholder-input.tsx); the value keeps the placeholders. The label is
 * the catalog's; the variable name shows on hover and with the form's "Show
 * technical names". The catalog's `link` follows the help. Shared with the
 * Settings section of the app page.
 */
export function VarField({
  field,
  value,
  onChange,
  when = "when it installs",
  chips,
}: {
  field: InstallVarField;
  value: string;
  onChange: (value: string) => void;
  /** When placeholders are filled in, for the chips' tooltips. */
  when?: string;
  /** Placeholders the field may hold; without them it is a plain text field. */
  chips?: PlaceholderChips;
}) {
  const workers = Object.keys(chips?.known.entryWorkers ?? {});
  // Decided once, so the field never swaps under the caret when the last chip goes.
  const [withChips] = useState(
    () =>
      chips !== undefined && (hasChips(field.shownDefault, workers) || hasChips(value, workers)),
  );
  if (field.derivedFrom !== undefined) {
    return <DerivedVarField field={field} value={value} when={when} />;
  }
  const label = <FieldLabel label={field.label} name={field.name} />;
  const note = field.seedOnly === true ? SEED_ONLY_VAR_NOTE : undefined;
  const description = fieldDescription({ help: field.help, note, link: field.link });
  const problem = varValueProblem(field, value) ?? undefined;
  if (field.options !== null && field.options.length <= MAX_CARD_OPTIONS) {
    return (
      <Radio.Group
        value={value}
        onValueChange={(next: string) => onChange(next)}
        orientation="horizontal"
        appearance="card"
        error={problem}
        // Kumo lays a horizontal card group out as a two-column grid of its
        // children, legend included; the legend and help take a whole row above
        // the choices, which get one column on a narrow screen.
        className={CHOICE_GRID}
      >
        <div data-choice-heading className="col-span-full grid gap-1.5">
          <Radio.Legend>{label}</Radio.Legend>
          {description !== undefined && <p className="text-kumo-subtle text-sm">{description}</p>}
        </div>
        {field.options.map((option) => (
          <Radio.Item key={option.value} value={option.value} label={option.label} />
        ))}
      </Radio.Group>
    );
  }
  if (field.options !== null) {
    return (
      <Select
        label={label}
        placeholder="Choose one"
        value={value === "" ? null : value}
        onValueChange={(next) => onChange(typeof next === "string" ? next : "")}
        items={field.options.map((option) => ({ value: option.value, label: option.label }))}
        required={field.required}
        description={description}
        error={problem}
      />
    );
  }
  if (field.kind === "json") {
    return (
      <InputArea
        label={
          <>
            {label} <span className="font-normal text-kumo-subtle">JSON</span>
          </>
        }
        value={value}
        required={field.required}
        autoComplete="off"
        spellCheck={false}
        autoResize
        minRows={1}
        maxRows={8}
        className="font-mono"
        onChange={(e) => onChange(e.currentTarget.value)}
        description={
          hasChips(value, workers) ? (
            <>
              {description} Parts in double braces are filled in {when}.
            </>
          ) : (
            description
          )
        }
        error={problem}
      />
    );
  }
  if (withChips && chips !== undefined) {
    return (
      <PlaceholderInput
        label={label}
        accessibleName={field.label}
        value={value}
        required={field.required}
        onChange={onChange}
        description={description}
        error={problem}
        options={chips.options}
        workers={workers}
        describeChip={(chip) => describeChip(chip, chips.known, when)}
      />
    );
  }
  return (
    <Input
      label={label}
      value={value}
      required={field.required}
      autoComplete="off"
      onChange={(e) => onChange(e.currentTarget.value)}
      description={description}
    />
  );
}

/**
 * A derived var (the catalog's `derive`), read-only: Appflare computes it from
 * a secret, at install and whenever that secret gets a new value. Empty until
 * the install computes it.
 */
function DerivedVarField({
  field,
  value,
  when,
}: {
  field: Pick<InstallVarField, "name" | "label" | "help" | "link">;
  value: string;
  /** When the value is computed, for the empty field's placeholder. */
  when: string;
}) {
  return (
    <Input
      label={<FieldLabel label={field.label} name={field.name} />}
      value={value}
      readOnly
      placeholder={`Computed ${when}`}
      autoComplete="off"
      spellCheck={false}
      className="font-mono"
      description={fieldDescription({
        help: field.help ?? "Appflare sets it for you.",
        note: field.help === undefined ? undefined : "Appflare sets it for you.",
        link: field.link,
      })}
    />
  );
}
