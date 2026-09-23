import {
  Badge,
  Banner,
  Button,
  Dialog,
  Empty,
  Input,
  LayerCard,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  FingerprintIcon,
  PlusIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { authClient } from "../auth/client";
import {
  PASSKEY_MESSAGES,
  passkeyRegistrationErrorMessage,
  passkeysSupported,
} from "../auth/passkey-errors";
import { type PasskeyRow, removePasskey } from "../server/passkeys.functions";
import { passkeyNameInput } from "../server/schemas";
import { formatDate, formatExactDateTime } from "./format";

/**
 * Settings → Passkeys: the signed-in user's own passkeys. Adding one runs the
 * browser's passkey prompt; removing one only deletes it here, so the device or
 * password manager keeps an unusable copy until the user deletes it there too.
 */
export function PasskeysSection({ passkeys }: { passkeys: PasskeyRow[] }) {
  const supported = passkeysSupported();
  return (
    <div className="grid gap-3">
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
        <LayerCard className="p-0">
          <Table>
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
                    {p.createdAt === null ? (
                      "Unknown"
                    ) : (
                      <span title={formatExactDateTime(p.createdAt)}>
                        {formatDate(p.createdAt)}
                      </span>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end">
                      <RemovePasskeyDialog passkey={p} />
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </div>
  );
}

function passkeyLabel(p: PasskeyRow): string {
  return p.name ?? p.provider ?? "Unnamed passkey";
}

function DialogHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-1.5">
        <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">{description}</Dialog.Description>
      </div>
      <Dialog.Close
        aria-label="Close"
        render={(props) => (
          <Button
            {...props}
            variant="secondary"
            shape="square"
            icon={<XIcon />}
            aria-label="Close"
          />
        )}
      />
    </div>
  );
}

/** Names the passkey, then hands over to the browser's passkey prompt. */
function AddPasskeyDialog() {
  const router = useRouter();
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="primary" icon={<PlusIcon />}>
            Add passkey
          </Button>
        )}
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <DialogHeader
          title="Add a passkey"
          description="Name it after the device or password manager that keeps it, so you can tell your passkeys apart. Your browser then asks you to create it."
        />
        <form className="grid gap-4" onSubmit={onSubmit}>
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
          <div className="flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button {...props} disabled={pending}>
                  Cancel
                </Button>
              )}
            />
            <Button type="submit" variant="primary" loading={pending} icon={<FingerprintIcon />}>
              Create passkey
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

function RemovePasskeyDialog({ passkey }: { passkey: PasskeyRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = passkeyLabel(passkey);

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) setError(null);
  }

  async function onRemove() {
    setPending(true);
    setError(null);
    try {
      await removePasskey({ data: { id: passkey.id } });
      setOpen(false);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the passkey.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        render={(p) => (
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
      />
      <Dialog className="grid gap-6 px-6 py-5">
        <DialogHeader
          title={`Remove ${label}?`}
          description="You will no longer be able to sign in with it. Delete it from your device or password manager as well."
        />
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} disabled={pending}>
                Cancel
              </Button>
            )}
          />
          <Button variant="destructive" loading={pending} onClick={onRemove}>
            Remove passkey
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
