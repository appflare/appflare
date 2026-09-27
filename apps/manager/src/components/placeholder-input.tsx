import { Badge, Button, cn, DropdownMenu, Field, inputVariants, Popover } from "@cloudflare/kumo";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import {
  type Caret,
  type Chip,
  chipKeyEdit,
  chipLabel,
  type Edit,
  type EntryWorkers,
  insertPlaceholder,
  type PlaceholderOption,
  removeChip,
  setPart,
  toSegments,
} from "./placeholder-chips";
import { TOOLTIP_CONTENT_CLASS } from "./tooltip";

/**
 * A one-line text field whose install placeholders show as chips ("App
 * address", "Account ID"). Kumo has no field that mixes text and tags (its
 * TagInput holds a list of tags only), so this one is built from Kumo parts:
 * Kumo's `Field` for the label, help and error, its input styling for the
 * box, a `Badge` per chip, a `Popover` for what a chip becomes and a
 * `DropdownMenu` to insert one. Between two chips is a plain text input;
 * Backspace at the start of one, or Delete at its end, removes the chip next
 * to it whole, and a chip's own × does too (the only way on keyboards that
 * report no key, as many Android ones do). What a chip becomes opens on
 * hover, and on click, tap or Enter on its name. A chip cannot be edited in
 * part. The value the form stores keeps each placeholder as written
 * (./placeholder-chips.ts).
 */
export function PlaceholderInput({
  label,
  accessibleName,
  description,
  error,
  required,
  value,
  onChange,
  options,
  describeChip,
  workers = [],
  disabled = false,
}: {
  label: ReactNode;
  /** The field's name for assistive technology (the label as text). */
  accessibleName: string;
  description?: ReactNode;
  error?: string | undefined;
  /** False shows Kumo's quiet "(optional)" after the label. */
  required: boolean;
  value: string;
  onChange(value: string): void;
  /** What the Insert menu offers. */
  options: readonly PlaceholderOption[];
  /** What a chip's tooltip says it is filled in with. */
  describeChip(chip: Chip): string;
  /** The app's Workers, for placeholders that name one; any other stays text. */
  workers?: EntryWorkers;
  disabled?: boolean;
}) {
  const { texts, chips } = toSegments(value, workers);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  /** Where the caret goes once the edit that moved it has rendered. */
  const pending = useRef<Caret | null>(null);
  /** Where the caret was last, for the Insert menu; the end of the value at first. */
  const last = useRef<Caret | null>(null);

  function focusAt(caret: Caret) {
    const input = inputs.current[caret.part];
    if (input == null) return;
    input.focus();
    input.setSelectionRange(caret.offset, caret.offset);
  }

  useEffect(() => {
    const caret = pending.current;
    if (caret === null) return;
    pending.current = null;
    // After the menu closes it hands focus back to its trigger; take it after that.
    const timer = setTimeout(() => focusAt(caret), 0);
    return () => clearTimeout(timer);
  });

  function apply(edit: Edit, moveCaret: boolean) {
    last.current = edit.caret;
    if (moveCaret) pending.current = edit.caret;
    onChange(edit.value);
  }

  function caretOf(part: number, input: HTMLInputElement): Caret {
    return { part, offset: input.selectionStart ?? input.value.length };
  }

  function onKeyDown(part: number, event: KeyboardEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    if (input.selectionStart !== input.selectionEnd) return;
    const caret = caretOf(part, input);
    const edit = chipKeyEdit(value, caret, event.key, workers);
    if (edit !== null) {
      event.preventDefault();
      apply(edit, true);
      return;
    }
    // The arrows step over a chip into the text part beyond it.
    if (event.key === "ArrowLeft" && caret.offset === 0 && part > 0) {
      event.preventDefault();
      focusAt({ part: part - 1, offset: texts[part - 1]?.length ?? 0 });
    } else if (
      event.key === "ArrowRight" &&
      caret.offset === input.value.length &&
      part < chips.length
    ) {
      event.preventDefault();
      focusAt({ part: part + 1, offset: 0 });
    }
  }

  const end: Caret = { part: texts.length - 1, offset: texts.at(-1)?.length ?? 0 };

  return (
    <Field
      label={label}
      description={description}
      error={error === undefined ? undefined : { message: error, match: true }}
      required={required}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the box's padding focuses its last text part, as a click inside a text box would */}
      <div
        className={cn(
          inputVariants({ parentFocusIndicator: true, variant: error ? "error" : "default" }),
          "flex h-auto min-h-9 flex-wrap items-center gap-x-0.5 gap-y-1 py-1 pr-1",
          disabled && "opacity-70",
        )}
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          focusAt(end);
        }}
      >
        {texts.map((text, part) => {
          const chip = chips[part];
          const isLast = part === texts.length - 1;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positions; a chip's removal merges the two around it
            <span key={part} className="contents">
              <input
                ref={(el) => {
                  inputs.current[part] = el;
                }}
                value={text}
                disabled={disabled}
                aria-label={part === 0 ? accessibleName : `${accessibleName}, continued`}
                aria-required={part === 0 ? required : undefined}
                autoComplete="off"
                spellCheck={false}
                size={Math.max(1, text.length)}
                className={cn(
                  "min-w-[1ch] border-0 bg-transparent p-0 text-kumo-default outline-none [field-sizing:content]",
                  isLast && "min-w-16 flex-1",
                )}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const edit = setPart(
                    value,
                    part,
                    input.value,
                    input.selectionStart ?? 0,
                    workers,
                  );
                  // A placeholder typed in full becomes a chip, and the parts move.
                  apply(edit, toSegments(edit.value, workers).chips.length !== chips.length);
                }}
                onKeyDown={(event) => onKeyDown(part, event)}
                onSelect={(event) => {
                  last.current = caretOf(part, event.currentTarget);
                }}
              />
              {chip !== undefined && (
                <span data-placeholder={chip.raw} className="inline-flex">
                  <Badge
                    variant="secondary"
                    className="h-7 gap-0 whitespace-nowrap py-0 pr-0.5 pl-0 text-sm"
                  >
                    <Popover>
                      <Popover.Trigger
                        openOnHover
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="h-6 rounded-full pr-1 pl-2 text-sm"
                          />
                        }
                      >
                        {chipLabel(chip)}
                      </Popover.Trigger>
                      <Popover.Content side="top">
                        <span className={TOOLTIP_CONTENT_CLASS}>{describeChip(chip)}</span>
                      </Popover.Content>
                    </Popover>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      shape="square"
                      disabled={disabled}
                      icon={<XIcon size={12} />}
                      aria-label={`Remove ${chipLabel(chip)}`}
                      className="size-6 rounded-full"
                      onClick={() => apply(removeChip(value, part, workers), true)}
                    />
                  </Badge>
                </span>
              )}
            </span>
          );
        })}
        {options.length > 0 && (
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon={<PlusIcon />}
                  disabled={disabled}
                  className="ml-auto"
                  aria-label={`Insert into ${accessibleName}`}
                >
                  Insert
                </Button>
              }
            />
            <DropdownMenu.Content align="end">
              {options.map((option) => (
                <DropdownMenu.Item
                  key={option.placeholder}
                  onClick={() =>
                    apply(
                      insertPlaceholder(value, last.current ?? end, option.placeholder, workers),
                      true,
                    )
                  }
                >
                  {option.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
        )}
      </div>
    </Field>
  );
}
