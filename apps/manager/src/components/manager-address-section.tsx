import { Banner, Button, LayerDialog, Link, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  ArrowUUpLeftIcon,
  GlobeIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { dashboardLinks } from "../cloudflare/dashboard-links";
import {
  type AddressOptions,
  getManagerAddress,
  getManagerAddressOptions,
  type ManagerAddress,
  revertManagerAddress,
} from "../domains/manager-address.functions";
import { AppflareLoader } from "./appflare-loader";
import { BusyMark, busyActionProps } from "./busy-button";
import { ConfirmDialog } from "./confirm-dialog";
import { TokenPermissionsBanner } from "./domain-dialog-parts";
import {
  AddressFields,
  type AddressZone,
  MovedNotice,
  type MovedTo,
  MoveProgress,
  moveActionLabel,
  useAddressFields,
  useAddressMove,
} from "./manager-address-move";
import { Section, SectionBody, SectionRow, SectionRows } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * Settings, Domains, "Appflare's address" (admins): where Appflare lives,
 * its workers.dev address or a domain of the account, with the move to a
 * domain, the change to another, and the way back to workers.dev. A domain
 * attached to Appflare's Worker by hand in the Cloudflare dashboard can
 * become the address as it is.
 */

/** What the section shows; either half may have failed to load on its own. */
export interface AddressView {
  address: ManagerAddress | { error: string };
  options: AddressOptions | { error: string };
  /** The account Appflare runs in, for links into the dashboard. */
  accountId: string | null;
}

function failure(err: unknown, fallback: string): { error: string } {
  return { error: err instanceof Error ? err.message : fallback };
}

/** The section's data: the address and the zones it can move to, read together. */
export async function loadAddressView(accountId: string | null): Promise<AddressView> {
  const [address, options] = await Promise.all([
    getManagerAddress().catch((err: unknown) => failure(err, "Could not read Appflare's address.")),
    getManagerAddressOptions().catch((err: unknown) =>
      failure(err, "Could not read the account's domains."),
    ),
  ]);
  return { address, options, accountId };
}

/** A domain serving Appflare's Worker that is not its address. */
type HandDomain = ManagerAddress["attachedByHand"][number];

export function ManagerAddressSection({ view }: { view: AddressView }) {
  const [movedTo, setMovedTo] = useState<MovedTo | null>(null);
  const address = "error" in view.address ? null : view.address;
  const options = "error" in view.options ? null : view.options;
  const onDomain = address !== null && address.hostname !== null;
  const kind = onDomain ? "change" : "move";
  // Without a usable zone the dialog could only explain; the lines below do that.
  const canMove = address !== null && (options === null || options.zones.length > 0);
  const handDomains = address?.attachedByHand.filter((d) => d.hostname !== address.hostname) ?? [];

  return (
    <Section
      {...settingsSection("domains", "address")}
      description="Where you and your users open Appflare: its workers.dev address, or a domain of yours."
      error={"error" in view.address ? view.address.error : null}
      action={
        canMove ? (
          <MoveAddressDialog
            kind={kind}
            label={onDomain ? "Change" : "Use a domain"}
            accountId={view.accountId}
            onMoved={setMovedTo}
          />
        ) : null
      }
    >
      {address !== null && (
        <SectionRows>
          <CurrentAddressRow address={address} onMoved={setMovedTo} />
          {address.serving === false && address.hostname !== null && (
            <SectionBody>
              <Banner
                variant="alert"
                icon={<WarningIcon weight="fill" />}
                title={`${address.hostname} no longer points at Appflare`}
                description="Cloudflare no longer lists it among the domains of Appflare's Worker. Appflare goes back to its workers.dev address at its next check."
              />
            </SectionBody>
          )}
          {handDomains.map((domain) => (
            <SectionRow
              key={domain.hostname}
              title={`A domain already points at Appflare: ${domain.hostname}`}
              description="It was attached to Appflare's Worker in the Cloudflare dashboard."
              action={
                <MoveAddressDialog
                  kind={kind}
                  label="Use it as Appflare's address"
                  initial={domain}
                  accountId={view.accountId}
                  onMoved={setMovedTo}
                />
              }
            />
          ))}
          <ZonesNote view={view} />
        </SectionRows>
      )}
      {movedTo !== null && <MovedNotice movedTo={movedTo} />}
    </Section>
  );
}

/** Appflare's address now, with Open, and the way back while it is a domain. */
function CurrentAddressRow({
  address,
  onMoved,
}: {
  address: ManagerAddress;
  onMoved: (movedTo: MovedTo) => void;
}) {
  const current = address.hostname ?? address.workersDevHostname;
  return (
    <SectionRow
      title={current ?? "Its workers.dev address"}
      description={
        address.hostname === null ? (
          "Appflare lives at its workers.dev address."
        ) : (
          <>
            A domain of yours since <Timestamp iso={address.movedAt} dateOnly fallback="recently" />
            .{" "}
            {address.workersDevHostname === null
              ? "Its workers.dev address sends page visits here."
              : `${address.workersDevHostname} sends page visits here.`}
          </>
        )
      }
      action={
        <>
          {current !== null && (
            <LinkButton
              href={`https://${current}`}
              external
              variant="secondary"
              icon={<ArrowSquareOutIcon />}
            >
              Open
            </LinkButton>
          )}
          {address.hostname !== null && (
            <RevertDialog
              hostname={address.hostname}
              workersDev={address.workersDevHostname}
              onMoved={onMoved}
            />
          )}
        </>
      }
    />
  );
}

/** Why there is nothing to move to: no domain in the account, or none active yet. */
function ZonesNote({ view }: { view: AddressView }) {
  if ("error" in view.options) return null;
  const { noZones, zones, inactiveZones } = view.options;
  if (noZones) {
    return (
      <SectionBody>
        <Text variant="secondary">
          Add a domain to your Cloudflare account to give Appflare its own address.{" "}
          <Link
            href={dashboardLinks(view.accountId).domains}
            target="_blank"
            rel="noopener noreferrer"
          >
            Add a domain in Cloudflare
          </Link>
        </Text>
      </SectionBody>
    );
  }
  if (zones.length > 0) return null;
  return (
    <SectionBody>
      <Text variant="secondary">
        None of the account's domains is active yet ({inactiveZones.join(", ")}). A domain can
        become Appflare's address once Cloudflare shows it as active.
      </Text>
    </SectionBody>
  );
}

/**
 * Back to workers.dev, after saying what changes: the workers.dev address
 * stops sending visits to the domain, and passkeys added at the domain work
 * only there.
 */
function RevertDialog({
  hostname,
  workersDev,
  onMoved,
}: {
  hostname: string;
  workersDev: string | null;
  onMoved: (movedTo: MovedTo) => void;
}) {
  const router = useRouter();
  const target = workersDev ?? "its workers.dev address";
  // Handed on once the confirmation has finished closing (see MoveAddressDialog).
  const moved = useRef<MovedTo | null>(null);
  return (
    <ConfirmDialog
      onOpenChangeComplete={(opened) => {
        if (opened || moved.current === null) return;
        onMoved(moved.current);
        moved.current = null;
      }}
      trigger={(p) => (
        <Button {...p} variant="secondary" icon={<ArrowUUpLeftIcon />}>
          Go back to workers.dev
        </Button>
      )}
      title="Go back to workers.dev?"
      description={`Appflare moves back to ${target}, which stops sending visits to ${hostname}, and ${hostname} is removed from Appflare's Worker. Passkeys added at ${hostname} work only there: sign in at workers.dev with your password or a passkey added there.`}
      actionLabel="Go back to workers.dev"
      destructive={false}
      onConfirm={async () => {
        const result = await revertManagerAddress({ data: {} });
        if (result.url === null) {
          await router.invalidate();
          return;
        }
        moved.current = { hostname: new URL(result.url).hostname, url: result.url };
      }}
    />
  );
}

/**
 * Pick a zone and a name, then move: to a domain from workers.dev
 * (`move`), or from one domain to another (`change`). The dialog stays open
 * through the whole move, showing its steps, and cannot be closed meanwhile.
 * `initial` starts on a domain already attached by hand. Each opening starts
 * clean and reads the zones again.
 */
function MoveAddressDialog({
  kind,
  label,
  initial,
  accountId,
  onMoved,
}: {
  kind: "move" | "change";
  label: string;
  initial?: HandDomain;
  accountId: string | null;
  onMoved: (movedTo: MovedTo) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(0);
  // Where Appflare moved, handed on once this dialog has finished closing,
  // so the notice that follows takes the focus this dialog gives back.
  const moved = useRef<MovedTo | null>(null);

  function onOpenChange(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (next) setSession((n) => n + 1);
  }

  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(opened) => {
        if (opened || moved.current === null) return;
        onMoved(moved.current);
        moved.current = null;
      }}
      disablePointerDismissal
      dismissDisabled={busy}
    >
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary" icon={<GlobeIcon />}>
            {label}
          </Button>
        )}
      />
      <MoveAddressContent
        key={session}
        kind={kind}
        {...(initial === undefined ? {} : { initial })}
        accountId={accountId}
        onBusy={setBusy}
        onMoved={(movedTo) => {
          moved.current = movedTo;
          setBusy(false);
          setOpen(false);
        }}
      />
    </LayerDialog.Root>
  );
}

/** The zones to offer, with the zone of a hand-attached domain even when the list lacks it. */
function withInitialZone(
  zones: readonly AddressZone[],
  initial: HandDomain | undefined,
): AddressZone[] {
  if (initial === undefined || zones.some((z) => z.id === initial.zoneId)) return [...zones];
  return [
    ...zones,
    {
      id: initial.zoneId,
      name: initial.zoneName,
      suggestedHostname: `appflare.${initial.zoneName}`,
    },
  ];
}

const NO_ZONES: AddressZone[] = [];

function MoveAddressContent({
  kind,
  initial,
  accountId,
  onBusy,
  onMoved,
}: {
  kind: "move" | "change";
  initial?: HandDomain;
  accountId: string | null;
  onBusy: (busy: boolean) => void;
  onMoved: (movedTo: MovedTo) => void;
}) {
  const formId = useId();
  const [options, setOptions] = useState<AddressOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getManagerAddressOptions()
      .then((loaded) => {
        if (live) setOptions(loaded);
      })
      .catch((err: unknown) => {
        if (live) {
          setLoadError(
            err instanceof Error ? err.message : "Could not read the account's domains.",
          );
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const zones = options === null ? NO_ZONES : withInitialZone(options.zones, initial);
  const fields = useAddressFields(
    zones,
    initial === undefined ? undefined : { zoneId: initial.zoneId, hostname: initial.hostname },
  );
  const move = useAddressMove({ kind });
  useEffect(() => onBusy(move.moving), [move.moving, onBusy]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    fields.touch();
    if (fields.target === null) return;
    const done = await move.run(fields.target);
    if (done !== null) onMoved(done);
  }

  const ready = options !== null && zones.length > 0;
  return (
    <LayerDialog.Content size="lg">
      <LayerDialog.Title>
        {kind === "move" ? "Give Appflare its own address" : "Change Appflare's address"}
      </LayerDialog.Title>
      <LayerDialog.Description>
        Appflare moves to a name in one of your domains on Cloudflare, which creates its DNS record
        and certificate. It switches once the new address answers, and its workers.dev address then
        sends visits there. Everyone signs in again at the new address.
      </LayerDialog.Description>
      <LayerDialog.Body>
        {options === null ? (
          loadError === null ? (
            <div className="flex items-center gap-2">
              <AppflareLoader size="sm" />
              <Text variant="secondary">Reading the account's domains…</Text>
            </div>
          ) : (
            <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={loadError} />
          )
        ) : move.moving && fields.target !== null ? (
          <MoveProgress hostname={fields.target.hostname} />
        ) : (
          <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
            {options.missing.length > 0 && (
              <TokenPermissionsBanner options={options} accountId={accountId} />
            )}
            {ready ? (
              <AddressFields zones={zones} fields={fields} move={move} />
            ) : (
              !options.noZones && (
                <Text variant="secondary">
                  None of the account's domains is active yet ({options.inactiveZones.join(", ")}
                  ).
                </Text>
              )
            )}
          </form>
        )}
      </LayerDialog.Body>
      {ready && (
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary
            type="submit"
            form={formId}
            {...busyActionProps(move.moving, fields.zone === null || move.blocked)}
          >
            <BusyMark pending={move.moving} />
            {moveActionLabel(move, kind === "move" ? "Move Appflare" : "Change address")}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      )}
    </LayerDialog.Content>
  );
}
