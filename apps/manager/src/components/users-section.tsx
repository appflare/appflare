import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  Input,
  LayerCard,
  LayerDialog,
  Select,
  Table,
  Text,
} from "@cloudflare/kumo";
import { InfoIcon, UserPlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import type { Role } from "../auth/roles";
import { addUser, type UserRow } from "../server/users.functions";
import { Timestamp } from "./timestamp";

/**
 * Settings, Users and access: the users. `users` is null for members, who
 * see a read-only note. The page puts {@link AddUserDialog} beside the title.
 */
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
                <Table.Cell>
                  <Timestamp iso={u.createdAt} dateOnly />
                </Table.Cell>
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
export function AddUserDialog() {
  const router = useRouter();
  const formId = useId();
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
    <LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={pending}>
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="primary" icon={<UserPlusIcon />}>
            Add user
          </Button>
        )}
      />
      <LayerDialog.Content>
        <LayerDialog.Title>{created === null ? "Add user" : "User created"}</LayerDialog.Title>
        <LayerDialog.Description>
          {created === null
            ? "Appflare has no email provider, so you share a temporary password with them."
            : `Give ${created.email} this temporary password. It is shown only once.`}
        </LayerDialog.Description>
        <LayerDialog.Body>
          {created === null ? (
            <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
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
            </div>
          )}
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={created === null ? "Cancel" : "Close"}>
          {created === null ? (
            <LayerDialog.Actions.Primary type="submit" form={formId} loading={pending}>
              Create user
            </LayerDialog.Actions.Primary>
          ) : (
            <LayerDialog.Actions.Primary onClick={() => onOpenChange(false)}>
              Done
            </LayerDialog.Actions.Primary>
          )}
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
