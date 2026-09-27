import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  DropdownMenu,
  Input,
  LayerDialog,
  Radio,
  Table,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  CrownSimpleIcon,
  DotsThreeIcon,
  InfoIcon,
  KeyIcon,
  TrashIcon,
  UserGearIcon,
  UserPlusIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import type { Role } from "../auth/roles";
import {
  type AccessPolicyOutcome,
  addUser,
  changeUserRole,
  deleteUser,
  transferOwnership,
  type UserRow,
} from "../server/users.functions";
import { ConfirmDialog } from "./confirm-dialog";
import { ResetPasswordDialog } from "./reset-password-dialog";
import { Section, SectionBody, SectionTable } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";
import { readOnlyNote, type UserAction, userActions } from "./user-actions";

/**
 * The users settings' Users section. `users` is null for members, who see a
 * read-only note. Admins get "Add user" at the right of the header, and
 * "Reset password" on the rows of other users but the owner; the owner also
 * changes roles, transfers ownership to an admin, and deletes.
 */
export function UsersSection({
  users,
  viewerId,
  viewerIsOwner,
  emailReset,
}: {
  users: UserRow[] | null;
  viewerId: string;
  viewerIsOwner: boolean;
  /** Password reset emails are on, so a reset can be a link. */
  emailReset: boolean;
}) {
  return (
    <Section
      {...settingsSection("users", "users")}
      description="Who can sign in to this manager, and what each of them can change."
      action={users !== null ? <AddUserDialog /> : null}
    >
      {users === null ? (
        <SectionBody>
          <Banner
            variant="secondary"
            icon={<InfoIcon weight="fill" />}
            title="Only admins can view and add users."
            description="Ask an admin if you need an account for someone else."
          />
        </SectionBody>
      ) : (
        <UsersTable
          users={users}
          viewerId={viewerId}
          viewerIsOwner={viewerIsOwner}
          emailReset={emailReset}
        />
      )}
    </Section>
  );
}

function UsersTable({
  users,
  viewerId,
  viewerIsOwner,
  emailReset,
}: {
  users: UserRow[];
  viewerId: string;
  viewerIsOwner: boolean;
  emailReset: boolean;
}) {
  const [picked, setPicked] = useState<{ user: UserRow; action: UserAction } | null>(null);
  const [open, setOpen] = useState(false);

  function pick(user: UserRow, action: UserAction) {
    setPicked({ user, action });
    setOpen(true);
  }

  const owner = users.find((u) => u.isOwner);
  // Only admins get the list (`users` is null for members).
  const viewer = { id: viewerId, isAdmin: true, isOwner: viewerIsOwner };
  return (
    <>
      {!viewerIsOwner && (
        <SectionBody>
          <Text variant="secondary" size="sm">
            {readOnlyNote(owner)}
          </Text>
        </SectionBody>
      )}
      <SectionTable label="Users" stickyFirstColumn>
        <Table.Header>
          <Table.Row>
            <Table.Head>Email</Table.Head>
            <Table.Head>Name</Table.Head>
            <Table.Head>Role</Table.Head>
            <Table.Head>Created</Table.Head>
            <Table.Head>
              <span className="sr-only">Actions</span>
            </Table.Head>
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
                <span className="inline-flex gap-1">
                  <Badge variant={u.role === "admin" ? "primary" : "neutral"}>{u.role}</Badge>
                  {u.isOwner && <Badge variant="outline">owner</Badge>}
                </span>
              </Table.Cell>
              <Table.Cell>
                <Timestamp iso={u.createdAt} dateOnly />
              </Table.Cell>
              <Table.Cell className="text-right">
                <UserRowMenu user={u} actions={userActions(viewer, u)} onPick={pick} />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </SectionTable>
      {picked !== null && (
        <UserActionDialog
          user={picked.user}
          action={picked.action}
          open={open}
          onOpenChange={setOpen}
          emailReset={emailReset}
        />
      )}
    </>
  );
}

function actionLabel(action: UserAction): string {
  switch (action.kind) {
    case "reset":
      return "Reset password";
    case "role":
      return action.role === "admin" ? "Make admin" : "Make member";
    case "transfer":
      return "Transfer ownership";
    case "delete":
      return "Delete user";
  }
}

function UserRowMenu({
  user,
  actions,
  onPick,
}: {
  user: UserRow;
  actions: UserAction[];
  onPick: (user: UserRow, action: UserAction) => void;
}) {
  if (actions.length === 0) return null;
  const safe = actions.filter((a) => a.kind !== "delete");
  const destructive = actions.filter((a) => a.kind === "delete");
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" size="sm" shape="square" aria-label={`Actions for ${user.email}`}>
            <DotsThreeIcon weight="bold" size={16} />
          </Button>
        }
      />
      <DropdownMenu.Content>
        {safe.map((a) => (
          // Icons go in as components: Kumo sizes and spaces a component
          // icon, but renders an element as it is, flush against the label.
          <DropdownMenu.Item
            key={a.kind}
            icon={
              a.kind === "reset" ? KeyIcon : a.kind === "transfer" ? CrownSimpleIcon : UserGearIcon
            }
            onClick={() => onPick(user, a)}
          >
            {actionLabel(a)}
          </DropdownMenu.Item>
        ))}
        {destructive.length > 0 && <DropdownMenu.Separator />}
        {destructive.map((a) => (
          <DropdownMenu.Item
            key={a.kind}
            icon={TrashIcon}
            variant="danger"
            onClick={() => onPick(user, a)}
          >
            {actionLabel(a)}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

const ACCESS_NOT_UPDATED =
  'The Cloudflare Access policy was not updated. Use "Re-sync admins" under Cloudflare Access.';

/**
 * The confirmation for the action picked from a row's menu. Deleting a user
 * and transferring ownership ask for the user's email to be typed, as Kumo's
 * delete-resource pattern has it; a role change is a plain confirmation.
 */
function UserActionDialog({
  user,
  action,
  open,
  onOpenChange,
  emailReset,
}: {
  user: UserRow;
  action: UserAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  emailReset: boolean;
}) {
  const router = useRouter();
  const toasts = useKumoToastManager();

  function reportAccess(outcome: AccessPolicyOutcome) {
    if (outcome === "failed") {
      toasts.add({
        title: "Access policy not updated",
        description: ACCESS_NOT_UPDATED,
        variant: "error",
      });
    }
  }

  const common = { open, onOpenChange, actionLabel: actionLabel(action) };
  switch (action.kind) {
    case "reset":
      return (
        <ResetPasswordDialog
          user={user}
          emailReset={emailReset}
          open={open}
          onOpenChange={onOpenChange}
        />
      );
    case "role": {
      const toAdmin = action.role === "admin";
      return (
        <ConfirmDialog
          {...common}
          destructive={false}
          title={toAdmin ? `Make ${user.name} an admin` : `Make ${user.name} a member`}
          description={
            toAdmin
              ? `${user.email} will be able to install, update and uninstall apps, change settings, and add users. Only you can change roles or delete users.`
              : `${user.email} will be able to see everything but change nothing, apart from their own passkeys.`
          }
          onConfirm={async () => {
            const { accessPolicy } = await changeUserRole({
              data: { userId: user.id, role: action.role },
            });
            reportAccess(accessPolicy);
            await router.invalidate();
          }}
        />
      );
    }
    case "transfer":
      return (
        <ConfirmDialog
          {...common}
          title={`Transfer ownership to ${user.name}`}
          description={`${user.email} becomes the owner: the only one who can change roles, delete users, and transfer ownership. You stay an admin, and only they can give ownership back.`}
          confirmText={user.email}
          onConfirm={async () => {
            await transferOwnership({ data: { userId: user.id } });
            toasts.add({
              title: "Ownership transferred",
              description: `${user.email} is now the owner.`,
              variant: "success",
            });
            await router.invalidate();
          }}
        />
      );
    case "delete":
      return (
        <ConfirmDialog
          {...common}
          title={`Delete ${user.name}`}
          description={`Deletes ${user.email} with their password and passkeys, and signs them out everywhere. Installed apps, jobs and settings stay as they are.`}
          confirmText={user.email}
          onConfirm={async () => {
            const { accessPolicy } = await deleteUser({ data: { userId: user.id } });
            reportAccess(accessPolicy);
            await router.invalidate();
          }}
        />
      );
  }
}

/** The roles a new user can get, as the add dialog offers them. */
const ROLE_CHOICES: readonly { role: Role; label: string; description: string }[] = [
  {
    role: "member",
    label: "Member",
    description: "Sees everything and changes nothing, apart from their own passkeys.",
  },
  {
    role: "admin",
    label: "Admin",
    description: "Installs, updates and uninstalls apps, changes settings, and adds users.",
  },
];

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
              <Radio.Group
                legend="Role"
                value={role}
                onValueChange={(v: string) => setRole(v === "admin" ? "admin" : "member")}
                orientation="horizontal"
                appearance="card"
              >
                {ROLE_CHOICES.map((c) => (
                  <Radio.Item
                    key={c.role}
                    value={c.role}
                    label={c.label}
                    description={c.description}
                  />
                ))}
              </Radio.Group>
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
