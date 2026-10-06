import {
  type PublicKeyFormatError,
  parsePublicKeys,
  publicKeyFingerprint,
  type SigningKey,
} from "@appflare/schema";
import {
  Banner,
  Button,
  DropdownMenu,
  Input,
  InputArea,
  LayerDialog,
  Select,
  Switch,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  DotsThreeIcon,
  FingerprintIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import {
  addCatalog,
  type CatalogView,
  deleteCatalog,
  setCatalogEnabled,
  updateCatalog,
} from "../catalog/catalogs.functions";
import {
  CATALOG_COLOUR_LABELS,
  CATALOG_COLOURS,
  type CatalogColour,
  catalogIndexUrlSchema,
  catalogLabelSchema,
  MAX_CUSTOM_CATALOGS,
} from "../catalog/sources";
import { BusyMark, busyActionProps } from "./busy-button";
import { CatalogSourceBadge } from "./catalog-source-badge";
import { ConfirmDialog } from "./confirm-dialog";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import { ErrorMessageBanner, MessageText } from "./message-text";
import { Section, SectionRow, SectionRows } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * The catalogs settings' one section: the official catalog (turned off and
 * on, never removed) and the catalogs admins added, one row each with the
 * public keys its releases are verified with, and "Add catalog" at the
 * right of the header. Members see the list read-only.
 */

const mono = "font-mono text-[0.9em]";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function CatalogsList({ catalogs, isAdmin }: { catalogs: CatalogView[]; isAdmin: boolean }) {
  const addSlot = useRef<HTMLDivElement>(null);
  const [removedId, setRemovedId] = useState<string | null>(null);
  // A removed catalog's row goes, with its menu and dialog, once the list
  // reloads: the focus moves to "Add catalog" instead of the page's start.
  useEffect(() => {
    if (removedId === null || catalogs.some((c) => c.id === removedId)) return;
    setRemovedId(null);
    addSlot.current?.querySelector("button")?.focus();
  }, [catalogs, removedId]);
  return (
    <Section
      {...settingsSection("catalogs", "catalogs")}
      description="Each catalog lists apps, and Appflare checks every release it installs from one with that catalog's keys."
      action={
        isAdmin ? (
          <div ref={addSlot} className="contents">
            <AddCatalogDialog customCount={catalogs.filter((c) => !c.official).length} />
          </div>
        ) : null
      }
    >
      <SectionRows>
        {catalogs.map((catalog) => (
          <CatalogRow
            key={catalog.id}
            catalog={catalog}
            isAdmin={isAdmin}
            onRemoved={() => setRemovedId(catalog.id)}
          />
        ))}
      </SectionRows>
    </Section>
  );
}

function CatalogRow({
  catalog,
  isAdmin,
  onRemoved,
}: {
  catalog: CatalogView;
  isAdmin: boolean;
  onRemoved: () => void;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(catalog.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const editable = isAdmin && !catalog.official;
  const menuTrigger = useRef<HTMLButtonElement>(null);
  /** A closed dialog hands the focus back to the menu it was picked from. */
  function onDialogDone(opened: boolean) {
    if (!opened && menuTrigger.current?.isConnected) menuTrigger.current.focus();
  }

  async function onToggle(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setPending(true);
    setError(null);
    try {
      await setCatalogEnabled({ data: { id: catalog.id, enabled: next } });
      await router.invalidate();
    } catch (err) {
      setEnabled(previous);
      setError(errorText(err, "Could not change the catalog."));
    }
    setPending(false);
  }

  return (
    <SectionRow
      id={`catalog-${catalog.id}`}
      title={<CatalogSourceBadge source={catalog} />}
      action={
        <>
          <Switch
            label={enabled ? "On" : "Off"}
            checked={enabled}
            disabled={!isAdmin || pending}
            onCheckedChange={(next: boolean) => void onToggle(next)}
          />
          {editable && (
            <CatalogRowMenu
              triggerRef={menuTrigger}
              label={catalog.label}
              onEdit={() => setEditing(true)}
              onRemove={() => setRemoving(true)}
            />
          )}
        </>
      }
    >
      <div className="grid gap-4">
        <Text variant="secondary">
          {catalog.official
            ? "The catalog Appflare ships with. Its releases are verified with the keys built into Appflare. It can be turned off, not removed."
            : "Added by an admin. Its releases are verified with the keys pinned below, and with no other key."}{" "}
          {!enabled &&
            "While it is off, its apps are not listed and apps installed from it get no updates."}
        </Text>
        <DescriptionList>
          <DescriptionItem label="Index URL">
            <span className={`${mono} break-all`}>{catalog.indexUrl}</span>
          </DescriptionItem>
          <DescriptionItem label={catalog.keys.length === 1 ? "Key" : "Keys"}>
            <span className="grid gap-1">
              {catalog.keys.length === 0 ? (
                <Text as="span" variant="secondary">
                  None recorded
                </Text>
              ) : (
                catalog.keys.map((key) => (
                  <span key={key.keyId}>
                    <span className={mono}>{key.keyId}</span>{" "}
                    <Text as="span" variant="secondary" size="sm">
                      <span className={mono}>{key.fingerprint}</span>
                    </Text>
                  </span>
                ))
              )}
            </span>
          </DescriptionItem>
          {!catalog.official && (
            <DescriptionItem label="Apps">
              {catalog.apps === null ? "Not loaded yet" : String(catalog.apps)}
            </DescriptionItem>
          )}
          <DescriptionItem label="Installed from it">{String(catalog.installs)}</DescriptionItem>
          <DescriptionItem label="Last refreshed">
            <Timestamp iso={catalog.refreshedAt} />
            {catalog.refreshError !== null && (
              <Text as="span" variant="error">
                {" "}
                Last attempt failed: <MessageText message={catalog.refreshError} />
              </Text>
            )}
          </DescriptionItem>
          {catalog.addedAt !== null && (
            <DescriptionItem label="Added">
              <Timestamp iso={catalog.addedAt} />
            </DescriptionItem>
          )}
        </DescriptionList>
        {error !== null && <ErrorMessageBanner message={error} />}
      </div>
      {editable && (
        <>
          <CatalogDialog
            editing={catalog}
            open={editing}
            onOpenChange={setEditing}
            onOpenChangeComplete={onDialogDone}
          />
          <RemoveCatalogDialog
            catalog={catalog}
            open={removing}
            onOpenChange={setRemoving}
            onOpenChangeComplete={onDialogDone}
            onRemoved={onRemoved}
          />
        </>
      )}
    </SectionRow>
  );
}

/**
 * An added catalog's Edit and Remove, in a menu beside its switch. Each
 * opens its dialog, which the row keeps mounted (a dialog created on the
 * pick would skip its opening animation).
 */
function CatalogRowMenu({
  triggerRef,
  label,
  onEdit,
  onRemove,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  label: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            shape="square"
            aria-label={`Actions for ${label}`}
          >
            <DotsThreeIcon weight="bold" size={16} />
          </Button>
        }
      />
      <DropdownMenu.Content>
        {/* Icons go in as components: Kumo sizes and spaces a component icon. */}
        <DropdownMenu.Item icon={PencilSimpleIcon} onClick={onEdit}>
          Edit
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={onRemove}>
          Remove
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/**
 * The fingerprints of what is pasted in the Public key field, or why it
 * cannot be read; nothing while the field is empty.
 */
function usePastedKeys(
  text: string,
): { keys: SigningKey[]; fingerprints: string[] } | string | null {
  const [state, setState] = useState<
    { keys: SigningKey[]; fingerprints: string[] } | string | null
  >(null);
  useEffect(() => {
    if (text.trim() === "") {
      setState(null);
      return;
    }
    let keys: SigningKey[];
    try {
      keys = parsePublicKeys(text);
    } catch (error) {
      setState((error as PublicKeyFormatError).message);
      return;
    }
    let current = true;
    void Promise.all(keys.map((k) => publicKeyFingerprint(k.publicKeyBase64))).then(
      (fingerprints) => {
        if (current) setState({ keys, fingerprints });
      },
      () => {
        if (current) setState("The fingerprint could not be worked out in this browser.");
      },
    );
    return () => {
      current = false;
    };
  }, [text]);
  return state;
}

/** The keys as they are pasted: one object, or an array for several. */
function pasteText(keys: readonly { keyId: string; publicKeyBase64: string }[]): string {
  const shaped = keys.map(({ keyId, publicKeyBase64 }) => ({ keyId, publicKeyBase64 }));
  return JSON.stringify(shaped.length === 1 ? shaped[0] : shaped);
}

/** "Add catalog", at the right of the section's header. */
function AddCatalogDialog({ customCount }: { customCount: number }) {
  if (customCount >= MAX_CUSTOM_CATALOGS) {
    return (
      <Button variant="primary" icon={<PlusIcon />} disabled title="Remove a catalog first.">
        Add catalog
      </Button>
    );
  }
  return <CatalogDialog editing={null} />;
}

/**
 * Add a catalog, or edit an added one. Saving checks the index and verifies
 * one of its releases with the pasted keys first (on edit, only when the URL
 * or the keys changed); the dialog shows why when that fails.
 *
 * Adding opens from its own "Add catalog" button. Editing has no trigger: the
 * row's menu opens it through `open` and `onOpenChange`.
 */
function CatalogDialog({
  editing,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  onOpenChangeComplete,
}: {
  editing: CatalogView | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The dialog finished opening or closing, its animation included. */
  onOpenChangeComplete?: (open: boolean) => void;
}) {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const formId = useId();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const [indexUrl, setIndexUrl] = useState("");
  const [publicKeys, setPublicKeys] = useState("");
  const [label, setLabel] = useState("");
  const [colour, setColour] = useState<CatalogColour>("blue");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pasted = usePastedKeys(publicKeys);

  // Each opening starts from the catalog as saved, whether the dialog's own
  // button or a row's menu opened it.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setIndexUrl(editing?.indexUrl ?? "");
      setPublicKeys(editing === null ? "" : pasteText(editing.keys));
      setLabel(editing?.label ?? "");
      setColour(editing?.colour ?? "blue");
      setErrors({});
      setFailure(null);
    }
  }

  function setOpen(next: boolean) {
    if (openProp === undefined) setOwnOpen(next);
    onOpenChangeProp?.(next);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found: Record<string, string> = {};
    const url = catalogIndexUrlSchema.safeParse(indexUrl);
    if (!url.success) found.indexUrl = url.error.issues[0]?.message ?? "Check the URL.";
    const name = catalogLabelSchema.safeParse(label);
    if (!name.success) found.label = name.error.issues[0]?.message ?? "Check the label.";
    if (pasted === null) found.publicKeys = "Paste the catalog's public key.";
    else if (typeof pasted === "string") found.publicKeys = pasted;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    setFailure(null);
    const data = { indexUrl, publicKeys, label, colour };
    try {
      if (editing === null) {
        const added = await addCatalog({ data });
        toasts.add({
          title: `${label.trim()} added`,
          description: `${added.checked.slug} ${added.checked.version} verified with the key "${added.checked.keyId}".`,
          variant: "success",
        });
      } else {
        await updateCatalog({ data: { ...data, id: editing.id } });
      }
      await router.invalidate();
      setOpen(false);
    } catch (err) {
      setFailure(errorText(err, "Could not save the catalog."));
    } finally {
      setPending(false);
    }
  }

  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={setOpen}
      {...(onOpenChangeComplete === undefined ? {} : { onOpenChangeComplete })}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      {editing === null && (
        <LayerDialog.Trigger
          render={(p) => (
            <Button {...p} variant="primary" icon={<PlusIcon />}>
              Add catalog
            </Button>
          )}
        />
      )}
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>
          {editing === null ? "Add a catalog" : `Edit ${editing.label}`}
        </LayerDialog.Title>
        <LayerDialog.Description>
          {editing === null
            ? "Get the index URL and the public key from the catalog's owner. Saving loads the index and verifies one of its releases with the key before the catalog is added."
            : "A new index URL or key is checked the same way before it is saved."}{" "}
          <DocsLink topic="customCatalogs" variant="inline" />
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
            <Input
              label="Index URL"
              value={indexUrl}
              onChange={(e) => setIndexUrl(e.currentTarget.value)}
              placeholder="https://example.github.io/catalog/index.json"
              type="url"
              autoComplete="off"
              spellCheck={false}
              error={errors.indexUrl}
            />
            <InputArea
              label="Public key"
              value={publicKeys}
              onChange={(e) => setPublicKeys(e.currentTarget.value)}
              placeholder='{"keyId":"acme-2026-09","publicKeyBase64":"..."}'
              autoComplete="off"
              spellCheck={false}
              autoResize
              minRows={2}
              maxRows={6}
              className="font-mono"
              description="Paste the line the catalog publishes. Only releases signed with this key are installed from it."
              error={errors.publicKeys}
            />
            {pasted !== null && typeof pasted !== "string" && (
              <Banner
                variant="default"
                icon={<FingerprintIcon weight="fill" />}
                title={
                  pasted.keys.length === 1 ? "Fingerprint" : `${pasted.keys.length} fingerprints`
                }
                description={
                  <span className="grid gap-1">
                    {pasted.keys.map((key, i) => (
                      <span key={key.keyId}>
                        <span className={mono}>{key.keyId}</span>:{" "}
                        <span className={`${mono} break-all`}>{pasted.fingerprints[i]}</span>
                      </span>
                    ))}
                    <span>
                      Compare it with the fingerprint the catalog's owner published, somewhere you
                      already trust, before you save.
                    </span>
                  </span>
                }
              />
            )}
            <Input
              label="Label"
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              placeholder="Acme internal"
              autoComplete="off"
              maxLength={40}
              description="Shown on its apps' source badge."
              error={errors.label}
            />
            <Select
              label="Colour"
              value={colour}
              onValueChange={(value) => {
                const next = CATALOG_COLOURS.find((c) => c === value);
                if (next !== undefined) setColour(next);
              }}
              items={CATALOG_COLOURS.map((c) => ({ value: c, label: CATALOG_COLOUR_LABELS[c] }))}
            />
            <span className="flex items-center gap-2">
              <Text as="span" variant="secondary" size="sm">
                Badge:
              </Text>
              <CatalogSourceBadge
                source={{
                  id: editing?.id ?? "new",
                  label: label.trim() || "Label",
                  colour,
                  official: false,
                }}
              />
            </span>
            {failure !== null && <ErrorMessageBanner message={failure} newTab />}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary type="submit" form={formId} {...busyActionProps(pending)}>
            <BusyMark pending={pending} />
            {editing === null ? "Check and add" : "Save"}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

/**
 * "Remove" for an added catalog, opened from its row's menu. While apps
 * installed from it are still installed, the dialog says why it cannot be
 * removed and the action stays off (the server refuses too).
 */
function RemoveCatalogDialog({
  catalog,
  open,
  onOpenChange,
  onOpenChangeComplete,
  onRemoved,
}: {
  catalog: CatalogView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  /** The catalog is removed; its row goes when the list reloads. */
  onRemoved: () => void;
}) {
  const router = useRouter();
  const blocked = catalog.installs > 0;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      title={`Remove ${catalog.label}`}
      description={
        blocked
          ? `${catalog.installs} app${catalog.installs === 1 ? " is" : "s are"} installed from ${catalog.label}. Their updates, form revisions and checks come from this catalog, and its key verifies them, so it cannot be removed while they are installed. Uninstall them first, or turn the catalog off instead.`
          : `Its apps leave the catalog page and its key is no longer trusted. Nothing is uninstalled. You can add it again later.`
      }
      actionLabel="Remove catalog"
      disabled={blocked}
      onConfirm={async () => {
        await deleteCatalog({ data: { id: catalog.id } });
        onRemoved();
        await router.invalidate();
      }}
    />
  );
}
