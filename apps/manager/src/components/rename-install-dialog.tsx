import { Banner, Button, Input, LayerDialog } from "@cloudflare/kumo";
import { PencilSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameProblem,
  renameChange,
  renameStartValue,
} from "../installs/display-name";
import { renameInstall } from "../installs/installs.functions";
import { BusyMark, busyActionProps } from "./busy-button";

/**
 * "Rename" on the app page (admins): a pencil button beside the title that
 * opens a small dialog whose field holds the name the title shows, selected
 * so that typing replaces it. Saving an empty name (or the app's own) clears
 * the display name; saving it unchanged just closes the dialog. Only
 * Appflare's record changes; nothing is deployed.
 */
export function RenameInstallDialog({
  install,
}: {
  /** `name` is the app's name, which the page shows while there is no display name. */
  install: { id: string; displayName: string | null; name: string };
}) {
  const router = useRouter();
  const formId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => renameStartValue(install));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problem = displayNameProblem(value);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setValue(renameStartValue(install));
      setFailure(null);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problem !== null || pending) return;
    const change = renameChange(install, value);
    if (change === null) {
      setOpen(false);
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await renameInstall({ data: { installId: install.id, displayName: change } });
      await router.invalidate();
      setOpen(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not rename the app.");
    } finally {
      setPending(false);
    }
  }

  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      // Once the dialog is open, the name is selected, so typing replaces it.
      onOpenChangeComplete={(opened: boolean) => {
        if (!opened) return;
        field.current?.focus();
        field.current?.select();
      }}
      dismissDisabled={pending}
    >
      <LayerDialog.Trigger
        render={(p) => (
          <Button
            {...p}
            variant="ghost"
            size="sm"
            shape="square"
            icon={<PencilSimpleIcon />}
            aria-label="Rename"
            title="Rename"
          />
        )}
      />
      <LayerDialog.Content size="sm">
        <LayerDialog.Title>Rename {renameStartValue(install)}</LayerDialog.Title>
        <LayerDialog.Description>
          The name Appflare shows for this install. The Worker, its address and its resources keep
          their names.
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
            <Input
              ref={field}
              label="Name"
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
              placeholder={install.name}
              autoComplete="off"
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              error={problem ?? undefined}
              description={`Leave empty to use the app's name, ${install.name}.`}
            />
            {failure !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={failure} />
            )}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary
            type="submit"
            form={formId}
            {...busyActionProps(pending, problem !== null)}
          >
            <BusyMark pending={pending} />
            Save
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
