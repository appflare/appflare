import { Banner, Input, LayerDialog } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { type ComponentProps, type FormEvent, type ReactNode, useId, useState } from "react";

type TriggerRender = ComponentProps<typeof LayerDialog.Trigger>["render"];

/**
 * Kumo's confirmation for an action that removes or deletes something: a
 * `LayerDialog.Alert` (no dismissal by clicking outside) whose title says
 * what goes, a body with the details, and, when `confirmText` is set, the
 * delete-resource pattern of typing the resource's name before the
 * destructive button enables. The body scrolls when it is taller than the
 * viewport; the actions stay in view.
 *
 * `onConfirm` does the work; when it throws, its message is shown and the
 * dialog stays open. When it returns, the dialog closes (unless the page
 * already navigated away, as after starting a job).
 *
 * Without `trigger`, the dialog is controlled through `open` and
 * `onOpenChange`, for an action picked from a menu such as a table row's.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  children,
  confirmText,
  actionLabel,
  destructive = true,
  onConfirm,
  onOpen,
  disabled = false,
  size = "base",
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: {
  /** The button that opens the dialog; receives the trigger props to spread. */
  trigger?: TriggerRender;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** The name to type before the action enables. */
  confirmText?: string;
  actionLabel: string;
  destructive?: boolean;
  /** Receives the typed confirmation (trimmed; empty without `confirmText`). */
  onConfirm: (typed: string) => Promise<void>;
  /** Runs each time the dialog opens, to reset or load what the body shows. */
  onOpen?: () => void;
  /** Keeps the action disabled, for example until the body's own choices are complete. */
  disabled?: boolean;
  size?: "sm" | "base" | "lg" | "xl";
  /** Controlled mode (no `trigger`): whether the dialog is open. */
  open?: boolean;
  /** Controlled mode: asked to close (Cancel, Escape, or after `onConfirm`). */
  onOpenChange?: (open: boolean) => void;
}) {
  const formId = useId();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmText === undefined || typed.trim() === confirmText;

  // A controlled dialog opens without `onOpenChange(true)`: start it clean
  // when `open` turns true.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTyped("");
      setError(null);
    }
  }

  function setOpen(next: boolean) {
    if (openProp === undefined) setOwnOpen(next);
    onOpenChangeProp?.(next);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setTyped("");
      setError(null);
      onOpen?.();
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || disabled || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm(typed.trim());
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
    setPending(false);
  }

  return (
    <LayerDialog.Alert open={open} onOpenChange={onOpenChange} dismissDisabled={pending}>
      {trigger !== undefined && <LayerDialog.Trigger render={trigger} />}
      <LayerDialog.Content size={size}>
        <LayerDialog.Title>{title}</LayerDialog.Title>
        {description !== undefined && (
          <LayerDialog.Description>{description}</LayerDialog.Description>
        )}
        <LayerDialog.Body>
          <form id={formId} className="grid gap-5" onSubmit={onSubmit}>
            {children}
            {confirmText !== undefined && (
              <Input
                label={
                  <>
                    Type <strong className="font-medium text-kumo-default">{confirmText}</strong> to
                    confirm
                  </>
                }
                placeholder={confirmText}
                value={typed}
                onChange={(e) => setTyped(e.currentTarget.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={pending}
              />
            )}
            {error !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary
            type="submit"
            form={formId}
            variant={destructive ? "destructive" : "primary"}
            loading={pending}
            disabled={!confirmed || disabled}
          >
            {actionLabel}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Alert>
  );
}
