import { Button, Switch } from "@cloudflare/kumo";
import { createContext, type ReactNode, useContext, useState } from "react";
import { localChoice } from "./local-choice";
import { MessageText } from "./message-text";
import { Tooltip } from "./tooltip";

/**
 * Labels of the install and settings forms: the catalog's human label only.
 * The variable or secret name the app reads is technical detail, shown on
 * hover and, with the form's "Show technical names" switch on, inline after
 * the label in muted monospace.
 */

const TechnicalNamesContext = createContext(false);

/** Whether the fields inside show their technical names inline. */
export const TechnicalNamesProvider = TechnicalNamesContext.Provider;

/** Whether the form shows technical names, for detail beyond labels (such as a configuration's name). */
export function useTechnicalNames(): boolean {
  return useContext(TechnicalNamesContext);
}

/** What the switch at the top of a form says. */
export const TECHNICAL_NAMES_LABEL = "Show technical names";

/** Where the browser remembers whether technical names are shown. */
export const TECHNICAL_NAMES_KEY = "appflare:technical-names";

export type TechnicalNamesChoice = "shown" | "hidden";

/** A stored value as the choice: anything but "shown" hides technical names. */
export function parseTechnicalNames(value: string | null | undefined): TechnicalNamesChoice {
  return value === "shown" ? "shown" : "hidden";
}

const technicalNames = localChoice(TECHNICAL_NAMES_KEY, parseTechnicalNames);

/**
 * Whether technical names are shown, and a setter: one choice for every
 * "Show technical names" switch, remembered per browser (`local-choice.ts`),
 * so turning it on in one place shows them everywhere, on every page.
 */
export function useShowTechnicalNames(): [boolean, (show: boolean) => void] {
  const [choice, setChoice] = technicalNames.useChoice();
  return [choice === "shown", (show) => setChoice(show ? "shown" : "hidden")];
}

/** The switch that shows technical names; every instance shows and sets the same choice. */
export function TechnicalNamesSwitch() {
  const [show, setShow] = useShowTechnicalNames();
  return (
    <Switch
      size="sm"
      label={TECHNICAL_NAMES_LABEL}
      checked={show}
      onCheckedChange={(next: boolean) => setShow(next)}
    />
  );
}

/**
 * A field's label: `label`, with `name` on hover, and inline after it while
 * the form shows technical names. A label that is the name itself (a secret
 * the installed version no longer declares) is shown as the name.
 */
export function FieldLabel({ label, name }: { label: string; name: string }) {
  const show = useContext(TechnicalNamesContext);
  if (label === name) return <span className="font-mono text-[0.9em]">{name}</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <Tooltip
        content={
          <>
            The app reads it as <span className="font-mono text-[0.9em]">{name}</span>
          </>
        }
        render={<span />}
      >
        {label}
      </Tooltip>
      {show && (
        <span className="font-mono text-[0.9em] font-normal text-kumo-subtle" data-technical-name>
          {name}
        </span>
      )}
    </span>
  );
}

/** Help longer than this shows its first sentence, and the rest behind "More". */
export const SHORT_HELP_LENGTH = 140;

/**
 * `text` as one line of help and the rest: the first sentence when the whole
 * is longer than {@link SHORT_HELP_LENGTH}, else all of it.
 */
export function splitHelp(text: string): { short: string; more: string | null } {
  const trimmed = text.trim();
  if (trimmed.length <= SHORT_HELP_LENGTH) return { short: trimmed, more: null };
  const end = /[.!?](?=\s+\S)/.exec(trimmed);
  if (end === null) return { short: trimmed, more: null };
  const cut = end.index + 1;
  return { short: trimmed.slice(0, cut), more: trimmed.slice(cut).trim() };
}

/**
 * A field's help: one line, the rest behind "More". Every part is inline
 * content, so it sits inside a field's description paragraph.
 */
export function FieldHelp({
  text,
  after,
  links = false,
}: {
  text: string;
  after?: ReactNode;
  /**
   * Render `[label](/path)` in `text` as links (`message-links.ts`). Only for
   * Appflare's own wording: help from a catalog entry stays plain text.
   */
  links?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { short, more } = splitHelp(text);
  return (
    <>
      {links ? <MessageText message={short} /> : short}
      {more !== null && open && <> {links ? <MessageText message={more} /> : more}</>}
      {after !== undefined && after !== null && <> {after}</>}
      {more !== null && (
        <>
          {" "}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={open}
            // Kumo's Button is a block-level flex box; inline, "More" follows the text.
            className="inline-flex align-baseline"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Less" : "More"}
          </Button>
        </>
      )}
    </>
  );
}
