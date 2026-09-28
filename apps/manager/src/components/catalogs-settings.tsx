import {
  type PublicKeyFormatError,
  parsePublicKeys,
  publicKeyFingerprint,
  type SigningKey,
} from "@appflare/schema";
import {
  Badge,
  Banner,
  Button,
  Input,
  InputArea,
  LayerDialog,
  Select,
  Switch,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useState } from "react";
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
import { Section, SectionRow, SectionRows } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * The catalogs settings' one section: the official catalog (turned off and
 * on, never removed) and the catalogs admins added, one row each with the
 * public keys its releases are verified with, and "Add a catalog" at the
 * right of the header. Members see the list read-only.
 */

const mono = "font-mono text-[0.9em]";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function CatalogsList({ catalogs, isAdmin }: { catalogs: CatalogView[]; isAdmin: boolean }) {
  return (
    <Section
      {...settingsSection("catalogs", "catalogs")}
      description="Each catalog lists apps, and Appflare checks every release it installs from one with that catalog's keys."
      action={
        isAdmin ? (
          <AddCatalogDialog customCount={catalogs.filter((c) => !c.official).length} />
        ) : null
      }
    >
      <SectionRows>
        {catalogs.map((catalog) => (
          <CatalogRow key={catalog.id} catalog={catalog} isAdmin={isAdmin} />
        ))}
      </SectionRows>
    </Section>
  );
}

function CatalogRow({ catalog, isAdmin }: { catalog: CatalogView; isAdmin: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(catalog.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      title={
        <span className="flex min-w-0 items-center gap-2">
          <CatalogSourceBadge source={catalog} />
          {!enabled && <Badge variant="neutral">Off</Badge>}
        </span>
      }
      action={
        <Switch
          label={enabled ? "On" : "Off"}
          checked={enabled}
          disabled={!isAdmin || pending}
          onCheckedChange={(next: boolean) => void onToggle(next)}
        />
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
              <Text as="span" variant="secondary">
                {" "}
                Last attempt failed: {catalog.refreshError}
              </Text>
            )}
          </DescriptionItem>
          {catalog.addedAt !== null && (
            <DescriptionItem label="Added">
              <Timestamp iso={catalog.addedAt} />
            </DescriptionItem>
          )}
        </DescriptionList>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        {isAdmin && !catalog.official && (
          <div className="flex flex-wrap gap-2">
            <CatalogDialog editing={catalog} />
            <RemoveCatalogDialog catalog={catalog} />
          </div>
        )}
      </div>
    </SectionRow>
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

/** "Add a catalog", at the right of the section's header. */
function AddCatalogDialog({ customCount }: { customCount: number }) {
  if (customCount >= MAX_CUSTOM_CATALOGS) {
    return (
      <Button variant="primary" icon={<PlusIcon />} disabled title="Remove a catalog first.">
        Add a catalog
      </Button>
    );
  }
  return <CatalogDialog editing={null} />;
}

/**
 * Add a catalog, or edit an added one. Saving checks the index and verifies
 * one of its releases with the pasted keys first (on edit, only when the URL
 * or the keys changed); the dialog shows why when that fails.
 */
function CatalogDialog({ editing }: { editing: CatalogView | null }) {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [indexUrl, setIndexUrl] = useState("");
  const [publicKeys, setPublicKeys] = useState("");
  const [label, setLabel] = useState("");
  const [colour, setColour] = useState<CatalogColour>("blue");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pasted = usePastedKeys(publicKeys);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setIndexUrl(editing?.indexUrl ?? "");
      setPublicKeys(editing === null ? "" : pasteText(editing.keys));
      setLabel(editing?.label ?? "");
      setColour(editing?.colour ?? "blue");
      setErrors({});
      setFailure(null);
    }
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
      onOpenChange={onOpenChange}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      <LayerDialog.Trigger
        render={(p) =>
          editing === null ? (
            <Button {...p} variant="primary" icon={<PlusIcon />}>
              Add a catalog
            </Button>
          ) : (
            <Button {...p} variant="secondary" icon={<PencilSimpleIcon />}>
              Edit
            </Button>
          )
        }
      />
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
                icon={<CheckCircleIcon weight="fill" />}
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
            {failure !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={failure} />
            )}
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
 * "Remove" for an added catalog. While apps installed from it are still
 * installed, the dialog says why it cannot be removed and the action stays
 * off (the server refuses too).
 */
function RemoveCatalogDialog({ catalog }: { catalog: CatalogView }) {
  const router = useRouter();
  const blocked = catalog.installs > 0;
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="secondary" icon={<TrashIcon />}>
          Remove
        </Button>
      )}
      title={`Remove ${catalog.label}?`}
      description={
        blocked
          ? `${catalog.installs} app${catalog.installs === 1 ? " is" : "s are"} installed from ${catalog.label}. Their updates, form revisions and checks come from this catalog, and its key verifies them, so it cannot be removed while they are installed. Uninstall them first, or turn the catalog off instead.`
          : `Its apps leave the catalog page and its key is no longer trusted. Nothing is uninstalled. You can add it again later.`
      }
      actionLabel="Remove catalog"
      disabled={blocked}
      onConfirm={async () => {
        await deleteCatalog({ data: { id: catalog.id } });
        await router.invalidate();
      }}
    />
  );
}
