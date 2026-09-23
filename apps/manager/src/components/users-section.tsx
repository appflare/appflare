import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  Dialog,
  Input,
  LayerCard,
  Select,
  Table,
  Text,
} from "@cloudflare/kumo";
import { InfoIcon, UserPlusIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { Role } from "../auth/roles";
import { addUser, type UserRow } from "../server/users.functions";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Settings → Users. `users` is null for members, who see a read-only note. */
export function UsersSection({ users, viewerId }: { users: UserRow[] | null; viewerId: string }) {
  if (users === null) {
    return (
      <Banner
        variant="secondary"
        icon={<InfoIcon weight="fill" />}
        title="Only admins can view and add users."
        description="Ask an admin if you need an account for someone else."
      />
    );
  }
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <AddUserDialog />
      </div>
      <LayerCard className="p-0">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Email</Table.Head>
              <Table.Head>Name</Table.Head>
              <Table.Head>Role</Table.Head>
              <Table.Head>Created</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {users.map((u) => (
              <Table.Row key={u.id}>
                <Table.Cell>
                  {u.email}
                  {u.id === viewerId && (
                    <Text as="span" variant="secondary" size="sm">
                      {" "}
                      (you)
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>{u.name}</Table.Cell>
                <Table.Cell>
                  <Badge variant={u.role === "admin" ? "primary" : "neutral"}>{u.role}</Badge>
                </Table.Cell>
                <Table.Cell>{dateFormat.format(new Date(u.createdAt))}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </LayerCard>
    </div>
  );
}

const ROLE_ITEMS: Record<Role, string> = { member: "Member (read only)", admin: "Admin" };

type Created = {
  email: string;
  temporaryPassword: string;
  /** Whether the Cloudflare Access allow policy took the new admin in. */
  accessPolicy: "off" | "updated" | "failed";
};

/**
 * Creates a user with a random temporary password, shown once in this dialog.
 * Closing the dialog discards it from memory.
 */
function AddUserDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setCreated(null);
      setError(null);
      setRole("member");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const result = await addUser({
        data: {
          email: String(form.get("email") ?? ""),
          name: String(form.get("name") ?? ""),
          role,
        },
      });
      setCreated({
        email: result.user.email,
        temporaryPassword: result.temporaryPassword,
        accessPolicy: result.accessPolicy,
      });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the user.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="primary" icon={<UserPlusIcon />}>
            Add user
          </Button>
        )}
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-lg font-semibold">
              {created === null ? "Add user" : "User created"}
            </Dialog.Title>
            <Dialog.Description className="text-kumo-subtle">
              {created === null
                ? "Appflare has no email provider, so you share a temporary password with them."
                : `Give ${created.email} this temporary password. It is shown only once.`}
            </Dialog.Description>
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
        {created === null ? (
          <form className="grid gap-4" onSubmit={onSubmit}>
            {error !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}
            <Input label="Email" name="email" type="email" autoComplete="off" required />
            <Input label="Name" name="name" autoComplete="off" required maxLength={100} />
            <Select
              label="Role"
              value={role}
              onValueChange={(v) => setRole(v === "admin" ? "admin" : "member")}
              items={ROLE_ITEMS}
            />
            <div className="flex justify-end gap-2">
              <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
              <Button type="submit" variant="primary" loading={pending}>
                Create user
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-4">
            <ClipboardText text={created.temporaryPassword} />
            <Banner
              variant="alert"
              icon={<WarningCircleIcon weight="fill" />}
              title="Copy it now"
              description="Appflare stores only a hash. Closing this dialog discards the password."
            />
            {created.accessPolicy === "updated" && (
              <Banner
                variant="secondary"
                icon={<InfoIcon weight="fill" />}
                title="Added to the Cloudflare Access policy"
                description={`${created.email} can now sign in through Cloudflare Access with that email.`}
              />
            )}
            {created.accessPolicy === "failed" && (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title="Not added to the Cloudflare Access policy"
                description={`Cloudflare Access will keep ${created.email} out until the policy lists them. Use "Re-sync admins" under Cloudflare Access.`}
              />
            )}
            <div className="flex justify-end">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="primary">
                    Done
                  </Button>
                )}
              />
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
