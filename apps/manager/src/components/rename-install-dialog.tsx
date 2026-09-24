import { Banner, Button, Input, LayerDialog } from "@cloudflare/kumo";
import { PencilSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameProblem,
  installLabel,
} from "../installs/display-name";
import { renameInstall } from "../installs/installs.functions";

/**
 * "Rename" on the app page (admins): a pencil button beside the title that
 * opens a small dialog with the install's display name. Saving an empty name
 * clears it, so the Worker name is shown again. Only Appflare's record
 * changes; nothing is deployed.
 */
export function RenameInstallDialog({
  install,
}: {
  install: { id: string; displayName: string | null; workerName: string };
}) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(install.displayName ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problem = displayNameProblem(value);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setValue(install.displayName ?? "");
      setFailure(null);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problem !== null || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await renameInstall({ data: { installId: install.id, displayName: value } });
      await router.invalidate();
      setOpen(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not rename the app.");
    } finally {
      setPending(false);
    }
  }

  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={pending}>
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
        <LayerDialog.Title>Rename {installLabel(install)}</LayerDialog.Title>
        <LayerDialog.Description>
          The name Appflare shows for this install. The Worker, its address and its resources keep
          their names.
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
            <Input
              label="Name"
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
              placeholder={install.workerName}
              autoComplete="off"
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              error={problem ?? undefined}
              description="Leave empty to show the Worker name."
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
            loading={pending}
            disabled={problem !== null}
          >
            Save
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
