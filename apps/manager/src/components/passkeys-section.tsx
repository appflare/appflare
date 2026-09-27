import { Badge, Banner, Button, Empty, Input, LayerDialog, Table, Text } from "@cloudflare/kumo";
import { FingerprintIcon, PlusIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { authClient } from "../auth/client";
import {
  PASSKEY_MESSAGES,
  passkeyRegistrationErrorMessage,
  passkeysSupported,
} from "../auth/passkey-errors";
import { type PasskeyRow, removePasskey } from "../server/passkeys.functions";
import { passkeyNameInput } from "../server/schemas";
import { ConfirmDialog } from "./confirm-dialog";
import { ResponsiveTable } from "./responsive-table";
import { Timestamp } from "./timestamp";

/**
 * Settings → Passkeys: the signed-in user's own passkeys. Adding one runs the
 * browser's passkey prompt; removing one only deletes it here, so the device or
 * password manager keeps an unusable copy until the user deletes it there too.
 */
export function PasskeysSection({ passkeys }: { passkeys: PasskeyRow[] }) {
  const supported = passkeysSupported();
  return (
    // The account menu links here; the margin keeps the section title above in view.
    <div id="passkeys" className="grid scroll-mt-16 gap-3">
      <div className="flex items-center justify-between gap-4">
        <Text variant="secondary">
          Sign in with your fingerprint, face, screen lock, or a security key instead of your
          password. Your password keeps working.
        </Text>
        {supported && passkeys.length > 0 && <AddPasskeyDialog />}
      </div>
      {!supported && (
        <Banner
          icon={<WarningCircleIcon weight="fill" />}
          title={PASSKEY_MESSAGES.registerUnsupported}
          description="Open Settings in a current browser to add a passkey."
        />
      )}
      {passkeys.length === 0 ? (
        <Empty
          icon={<FingerprintIcon size={48} className="text-kumo-inactive" />}
          title="No passkeys yet"
          description="Add a passkey to sign in without typing your password."
          contents={supported ? <AddPasskeyDialog /> : undefined}
        />
      ) : (
        <ResponsiveTable label="Passkeys" minWidth="sm" stickyFirstColumn>
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head>Kind</Table.Head>
              <Table.Head>Added</Table.Head>
              <Table.Head>
                <span className="sr-only">Actions</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {passkeys.map((p) => (
              <Table.Row key={p.id}>
                <Table.Cell>
                  {passkeyLabel(p)}
                  {p.name !== null && p.provider !== null && (
                    <Text as="span" variant="secondary" size="sm">
                      {" "}
                      ({p.provider})
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Badge variant={p.synced ? "primary" : "neutral"}>
                    {p.synced ? "Synced" : "This device only"}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <Timestamp iso={p.createdAt} dateOnly fallback="Unknown" />
                </Table.Cell>
                <Table.Cell>
                  <div className="flex justify-end">
                    <RemovePasskeyDialog passkey={p} />
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </ResponsiveTable>
      )}
    </div>
  );
}

function passkeyLabel(p: PasskeyRow): string {
  return p.name ?? p.provider ?? "Unnamed passkey";
}

/** Names the passkey, then hands over to the browser's passkey prompt. */
function AddPasskeyDialog() {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) setError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = passkeyNameInput.safeParse({
      name: String(new FormData(event.currentTarget).get("name") ?? ""),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Give the passkey a name.");
      return;
    }
    if (!passkeysSupported()) {
      setError(PASSKEY_MESSAGES.registerUnsupported);
      return;
    }
    setPending(true);
    setError(null);
    const { error: addError } = await authClient.passkey.addPasskey({ name: parsed.data.name });
    setPending(false);
    if (addError) {
      setError(passkeyRegistrationErrorMessage(addError));
      return;
    }
    setOpen(false);
    await router.invalidate();
  }

  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={pending}>
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="primary" icon={<PlusIcon />}>
            Add passkey
          </Button>
        )}
      />
      <LayerDialog.Content>
        <LayerDialog.Title>Add a passkey</LayerDialog.Title>
        <LayerDialog.Description>
          Name it after the device or password manager that keeps it, so you can tell your passkeys
          apart. Your browser then asks you to create it.
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
            {error !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}
            <Input
              label="Name"
              name="name"
              placeholder="Work laptop"
              autoComplete="off"
              required
              maxLength={100}
              disabled={pending}
            />
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary type="submit" form={formId} loading={pending}>
            Create passkey
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function RemovePasskeyDialog({ passkey }: { passkey: PasskeyRow }) {
  const router = useRouter();
  const label = passkeyLabel(passkey);
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button
          {...p}
          variant="secondary-destructive"
          size="sm"
          icon={<TrashIcon />}
          aria-label={`Remove ${label}`}
        >
          Remove
        </Button>
      )}
      title={`Remove ${label}`}
      description="You will no longer be able to sign in with it. Delete it from your device or password manager as well."
      actionLabel="Remove passkey"
      onConfirm={async () => {
        await removePasskey({ data: { id: passkey.id } });
        await router.invalidate();
      }}
    />
  );
}
