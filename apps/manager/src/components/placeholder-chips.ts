/**
 * The model behind a text field that shows install placeholders (the
 * schema's `INSTALL_PLACEHOLDERS`, such as `{{appUrl}}` and `{{accountId}}`,
 * and their per-Worker forms such as `{{appUrl:<name>}}`) as chips: the value
 * is split into text parts with one chip between each two, a chip is removed
 * or inserted whole, and the stored value keeps each placeholder exactly as
 * it was written. Positions are a part index and an offset in that part's
 * text.
 */

import {
  ENTRY_WORKER_PLACEHOLDER_SOURCE,
  type EntryWorkerPlaceholders,
  INSTALL_PLACEHOLDER_SOURCE,
  type InstallPlaceholder,
  urlHostname,
} from "@appflare/schema";

/** The placeholders a chip can stand for. */
export type PlaceholderKey = InstallPlaceholder;

export interface Chip {
  /** The placeholder as the value holds it, spaces inside the braces kept. */
  raw: string;
  key: PlaceholderKey;
  /** For a per-Worker placeholder (`{{appUrl:<name>}}`): the entry's Worker. */
  worker: string | null;
}

/** A value as the field shows it: `texts.length` is always `chips.length + 1`. */
export interface Segments {
  texts: string[];
  chips: Chip[];
}

/** Where the caret is: in text part `part`, `offset` characters in. */
export interface Caret {
  part: number;
  offset: number;
}

/** A value after an edit, and where the caret goes. */
export interface Edit {
  value: string;
  caret: Caret;
}

/**
 * The names of the app's Workers (an app of several Workers), for the
 * per-Worker placeholders (`{{appUrl:<name>}}`). A placeholder naming a
 * Worker the app does not have is never filled in, so it stays text.
 */
export type EntryWorkers = readonly string[];

// The placeholders the schema fills in, from the schema's own patterns so
// the two cannot drift: groups 1 (an install placeholder), 2 and 3 (an
// entry Worker placeholder's kind and Worker).
const CHIP_SOURCE = `(?:${INSTALL_PLACEHOLDER_SOURCE})|(?:${ENTRY_WORKER_PLACEHOLDER_SOURCE})`;

/** `value` split into text parts and chips. */
export function toSegments(value: string, workers: EntryWorkers = []): Segments {
  const texts: string[] = [];
  const chips: Chip[] = [];
  let from = 0;
  for (const match of value.matchAll(new RegExp(CHIP_SOURCE, "g"))) {
    const worker = match[3] ?? null;
    if (worker !== null && !workers.includes(worker)) continue;
    texts.push(value.slice(from, match.index));
    const key = (match[1] ?? match[2]) as PlaceholderKey;
    chips.push({ raw: match[0], key, worker });
    from = match.index + match[0].length;
  }
  texts.push(value.slice(from));
  return { texts, chips };
}

/** The value `segments` stand for. */
export function fromSegments({ texts, chips }: Segments): string {
  return texts.map((text, i) => text + (chips[i]?.raw ?? "")).join("");
}

/** Whether `value` holds a placeholder a chip shows. */
export function hasChips(value: string, workers: EntryWorkers = []): boolean {
  return toSegments(value, workers).chips.length > 0;
}

/** The offset in the value where `caret` is. */
export function absoluteOffset({ texts, chips }: Segments, caret: Caret): number {
  let at = 0;
  for (let i = 0; i < caret.part; i++) at += (texts[i]?.length ?? 0) + (chips[i]?.raw.length ?? 0);
  return at + caret.offset;
}

/**
 * The caret at `offset` in `value`. An offset inside a chip (a placeholder
 * just typed or pasted in full) lands right after it.
 */
export function caretAt(value: string, offset: number, workers: EntryWorkers = []): Caret {
  const { texts, chips } = toSegments(value, workers);
  let start = 0;
  for (let part = 0; part < texts.length; part++) {
    const end = start + (texts[part]?.length ?? 0);
    if (offset <= end) return { part, offset: Math.max(0, offset - start) };
    const chipEnd = end + (chips[part]?.raw.length ?? 0);
    if (offset < chipEnd) return { part: part + 1, offset: 0 };
    start = chipEnd;
  }
  const last = texts.length - 1;
  return { part: last, offset: texts[last]?.length ?? 0 };
}

/** `value` with text part `part` replaced; the caret at `offset` in the new text. */
export function setPart(
  value: string,
  part: number,
  text: string,
  offset: number,
  workers: EntryWorkers = [],
): Edit {
  const segments = toSegments(value, workers);
  const texts = segments.texts.map((t, i) => (i === part ? text : t));
  const next = fromSegments({ texts, chips: segments.chips });
  return {
    value: next,
    caret: caretAt(
      next,
      absoluteOffset({ texts, chips: segments.chips }, { part, offset }),
      workers,
    ),
  };
}

/** `value` without chip `index`; the caret where it was. */
export function removeChip(value: string, index: number, workers: EntryWorkers = []): Edit {
  const { texts, chips } = toSegments(value, workers);
  if (index < 0 || index >= chips.length) {
    return { value, caret: caretAt(value, value.length, workers) };
  }
  const before = texts[index] ?? "";
  const merged = before + (texts[index + 1] ?? "");
  const next = fromSegments({
    texts: [...texts.slice(0, index), merged, ...texts.slice(index + 2)],
    chips: chips.filter((_, i) => i !== index),
  });
  return { value: next, caret: { part: index, offset: before.length } };
}

/** `value` with `placeholder` (such as `{{accountId}}`) at `caret`; the caret right after it. */
export function insertPlaceholder(
  value: string,
  caret: Caret,
  placeholder: string,
  workers: EntryWorkers = [],
): Edit {
  const segments = toSegments(value, workers);
  const at = Math.min(absoluteOffset(segments, caret), value.length);
  const next = value.slice(0, at) + placeholder + value.slice(at);
  return { value: next, caret: caretAt(next, at + placeholder.length, workers) };
}

/**
 * Backspace at the start of a text part, or Delete at its end, removes the
 * whole chip next to it. Null for any other key or place: the text part
 * edits its own text.
 */
export function chipKeyEdit(
  value: string,
  caret: Caret,
  key: string,
  workers: EntryWorkers = [],
): Edit | null {
  const { texts, chips } = toSegments(value, workers);
  if (key === "Backspace" && caret.offset === 0 && caret.part > 0) {
    return removeChip(value, caret.part - 1, workers);
  }
  if (
    key === "Delete" &&
    caret.part < chips.length &&
    caret.offset === (texts[caret.part]?.length ?? 0)
  ) {
    return removeChip(value, caret.part, workers);
  }
  return null;
}

/** A placeholder the field's Insert menu offers. */
export interface PlaceholderOption {
  /** What the value holds, such as `{{appUrl}}`. */
  placeholder: string;
  label: string;
}

/** What a chip says, for the app as a whole. */
const CHIP_LABELS: Readonly<Record<PlaceholderKey, string>> = {
  appUrl: "App address",
  appHostname: "App hostname",
  workerUrl: "workers.dev address",
  workerHostname: "workers.dev hostname",
  workerName: "Worker name",
  accountId: "Account ID",
  wildcardHostname: "Wildcard domain",
};

/** What a chip says after the name of one of the app's Workers. */
const WORKER_CHIP_LABELS: Readonly<Record<PlaceholderKey, string>> = {
  ...CHIP_LABELS,
  appUrl: "address",
  appHostname: "hostname",
};

/** What a chip stands for, in words, for the app as a whole. */
const CHIP_MEANINGS: Readonly<Record<PlaceholderKey, string>> = {
  appUrl: "the app's address",
  appHostname: "the app's hostname",
  workerUrl: "the app's workers.dev address",
  workerHostname: "the app's workers.dev hostname",
  workerName: "the app's Worker name",
  accountId: "your Cloudflare account ID",
  wildcardHostname: "the app's wildcard domain",
};

/** What a chip says. */
export function chipLabel(chip: Pick<Chip, "key" | "worker">): string {
  return chip.worker === null
    ? CHIP_LABELS[chip.key]
    : `${chip.worker} ${WORKER_CHIP_LABELS[chip.key]}`;
}

/** The addresses and names a placeholder is filled in from. */
interface PlaceholderSources {
  /** The address the app is served at: its custom domain while workers.dev is off. */
  appUrl?: string | null;
  /** The Worker's workers.dev URL. */
  workerUrl?: string | null;
  workerName?: string | null;
  accountId?: string | null;
  wildcardHostname?: string | null;
}

/** What the form knows a placeholder stands for; null or absent where it does not. */
export interface KnownPlaceholders extends PlaceholderSources {
  entryWorkers?: EntryWorkerPlaceholders;
}

/** The value `key` is filled in with, from what is known; null when it is not known. */
function knownValue(key: PlaceholderKey, known: PlaceholderSources): string | null {
  switch (key) {
    case "appHostname":
      return known.appUrl == null ? null : urlHostname(known.appUrl);
    case "workerHostname":
      return known.workerUrl == null ? null : urlHostname(known.workerUrl);
    default:
      return known[key] ?? null;
  }
}

/**
 * What a chip's tooltip says: the value it is filled in with when the form
 * knows it, else what it stands for and `when` it is filled in ("when the
 * app installs").
 */
export function describeChip(
  chip: Pick<Chip, "key" | "worker">,
  known: KnownPlaceholders,
  when: string,
): string {
  const entry = known.entryWorkers;
  const sources =
    chip.worker === null
      ? known
      : entry !== undefined && Object.hasOwn(entry, chip.worker)
        ? entry[chip.worker]
        : undefined;
  const value = sources === undefined ? null : knownValue(chip.key, sources);
  if (value !== null && value !== "") return `Filled in with ${value}`;
  if (chip.key === "wildcardHostname") {
    return "Filled in with the app's wildcard domain once it has one";
  }
  if (chip.worker !== null) {
    return `Filled in with the ${WORKER_CHIP_LABELS[chip.key]} of the app's ${chip.worker} Worker ${when}`;
  }
  return `Filled in with ${CHIP_MEANINGS[chip.key]} ${when}`;
}

/**
 * The placeholders the Insert menu offers: the app's address and hostname,
 * its Worker name and the account's id always; the wildcard domain for an
 * app that has one; each Worker's address and name for an app of several
 * Workers. The workers.dev forms stay out of the menu: a setting almost
 * always wants the address people use. Typed in, they show as chips too.
 */
export function placeholderOptions({
  wildcard = false,
  workers = [],
}: {
  wildcard?: boolean;
  workers?: readonly string[];
} = {}): PlaceholderOption[] {
  const keys: PlaceholderKey[] = ["appUrl", "appHostname", "workerName", "accountId"];
  if (wildcard) keys.push("wildcardHostname");
  return [
    ...keys.map((key) => ({ placeholder: `{{${key}}}`, label: chipLabel({ key, worker: null }) })),
    ...workers.flatMap((worker) =>
      (["appUrl", "workerName"] as const).map((key) => ({
        placeholder: `{{${key}:${worker}}}`,
        label: chipLabel({ key, worker }),
      })),
    ),
  ];
}
