import type { CatalogFieldLink } from "@appflare/schema";
import { Button, Link, Switch } from "@cloudflare/kumo";
import { createContext, type ReactNode, useContext, useState } from "react";
import { localChoice } from "./local-choice";
import { MessageText } from "./message-text";
import { Tooltip } from "./tooltip";

/**
 * Labels of the install and settings forms: the catalog's human label only.
 * The variable or secret name the app reads is technical detail, shown on
 * hover and, with the form's "Show technical names" switch on, inline after
 * the label in muted monospace. A field's help is plain text; the catalog's
 * `link` for the field (where to get the value) follows it.
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

/**
 * A line of help with more behind a "More" toggle, for help that is
 * written in parts rather than split from one text ({@link FieldHelp}). The
 * folded part stays in the page, hidden, so its words are found in the
 * page's text and announced once shown. Inline content, like FieldHelp.
 */
export function MoreText({ children, more }: { children: ReactNode; more: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children}
      <span hidden={!open}> {more}</span>{" "}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-expanded={open}
        className="inline-flex align-baseline"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Less" : "More"}
      </Button>
    </>
  );
}

/** Help longer than this shows its first sentence, and the rest behind "More". */
export const SHORT_HELP_LENGTH = 140;

/**
 * A folded summary shorter than this (or of fewer than {@link MIN_SUMMARY_WORDS}
 * words) takes the next sentence too: "Optional." alone says nothing.
 */
export const MIN_SUMMARY_LENGTH = 24;
export const MIN_SUMMARY_WORDS = 4;

/**
 * `text` as one line of help and the rest: the first sentence when the whole
 * is longer than {@link SHORT_HELP_LENGTH}, else all of it. A first sentence
 * too short to stand alone takes the next ones until it can; when that
 * leaves little behind, the whole help shows.
 */
export function splitHelp(text: string): { short: string; more: string | null } {
  const trimmed = text.trim();
  if (trimmed.length <= SHORT_HELP_LENGTH) return { short: trimmed, more: null };
  const ends = [...trimmed.matchAll(/[.!?](?=\s+\S)/g)].map((m) => m.index + 1);
  const cut = ends.find((end) => {
    const summary = trimmed.slice(0, end);
    return summary.length >= MIN_SUMMARY_LENGTH && summary.split(/\s+/).length >= MIN_SUMMARY_WORDS;
  });
  if (cut === undefined) return { short: trimmed, more: null };
  const more = trimmed.slice(cut).trim();
  // A fold for a few words is more work than reading them.
  if (more.length < MIN_SUMMARY_LENGTH) return { short: trimmed, more: null };
  return { short: trimmed.slice(0, cut), more };
}

/**
 * Help of a field already labelled "(optional)", without a leading
 * "Optional." or "Optional:" that only repeats the label (catalog entries
 * often start that way); the next word gets its capital.
 */
export function withoutOptionalPrefix(text: string): string {
  const rest = text.trim().replace(/^optional\s*[.:]\s*/i, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * A field's help: one line, the rest behind "More". Every part is inline
 * content, so it sits inside a field's description paragraph.
 */
export function FieldHelp({
  text,
  after,
  links = false,
  optional = false,
}: {
  text: string;
  /** The field is labelled "(optional)": a leading "Optional." in `text` is dropped. */
  optional?: boolean;
  after?: ReactNode;
  /**
   * Render `[label](/path)` in `text` as links (`message-links.ts`). Only for
   * Appflare's own wording: help from a catalog entry stays plain text.
   */
  links?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { short, more } = splitHelp(optional ? withoutOptionalPrefix(text) : text);
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

/**
 * A catalog field's `link`, such as "Get a key": opens its https:// URL in a
 * new tab, without telling the site where the admin came from.
 */
export function FieldLink({ link }: { link: CatalogFieldLink }) {
  return (
    <Link href={link.url} target="_blank" rel="noopener noreferrer">
      {link.label}
      <Link.ExternalIcon />
    </Link>
  );
}

/**
 * What a catalog field says under its label: its help (the rest behind
 * "More"), then `note`, then its link; undefined when it has none of them.
 * Inline content, for a field's description paragraph.
 */
export function fieldDescription({
  help,
  note,
  link,
  optional = false,
}: {
  help?: string | undefined;
  note?: ReactNode;
  link?: CatalogFieldLink | undefined;
  /** The field is labelled "(optional)": a leading "Optional." in `help` is dropped. */
  optional?: boolean;
}): ReactNode {
  const hasNote = note !== undefined && note !== null && note !== "";
  const after =
    link === undefined ? (
      hasNote ? (
        note
      ) : undefined
    ) : (
      <>
        {hasNote && <>{note} </>}
        <FieldLink link={link} />
      </>
    );
  return help === undefined ? after : <FieldHelp text={help} after={after} optional={optional} />;
}
