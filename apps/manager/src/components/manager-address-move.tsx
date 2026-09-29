import { Banner, Button, LayerDialog, Link, LinkButton, Select, Text } from "@cloudflare/kumo";
import { CircleIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { isAccessDenied } from "../access/denied";
import {
  type AddressOptions,
  changeManagerAddress,
  moveManagerAddress,
} from "../domains/manager-address.functions";
import { MOVE_STEPS } from "../domains/move-address-lines";
import { MOVED_PASSKEY_NOTE } from "../domains/moved-note";
import { checkSubdomainInZone, type HostnameCheck } from "../installs/custom-domain-input";
import type { JobView } from "../jobs/jobs.functions";
import { useLiveJob } from "../jobs/live-job";
import { AppflareLoader } from "./appflare-loader";
import { type DnsConflict, DnsConflictNotice } from "./domain-dialog-parts";
import { MessageText } from "./message-text";
import { ZoneHostnameField } from "./zone-hostname-field";

/**
 * Moving Appflare to a domain of the account, as the Domains settings and
 * the setup wizard both do it: the zone picker and host field, the DNS
 * records warning, the progress of the job that waits for the new address
 * and switches, and the page shown once Appflare lives at the new address.
 */

export type AddressZone = AddressOptions["zones"][number];

/** A hostname in one of the account's zones. */
export interface AddressTarget {
  zoneId: string;
  hostname: string;
}

/** Where Appflare moved: the new hostname, and its sign-in page. */
export interface MovedTo {
  hostname: string;
  url: string;
}

/** A move job the page follows. */
export interface MoveJobRef {
  jobId: string;
  hostname: string;
}

/** The part of `hostname` before `.<zone>`; empty for the zone itself. */
export function subdomainOf(hostname: string, zoneName: string): string {
  if (hostname === zoneName) return "";
  const suffix = `.${zoneName}`;
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : hostname;
}

function suggestedSubdomain(zone: AddressZone): string {
  return subdomainOf(zone.suggestedHostname, zone.name);
}

/**
 * The zone and host fields: the zone preselected when the account has only
 * one, the host starting as the zone's suggestion (`appflare`) until the
 * admin types their own; empty means the zone itself. `initial` starts on a
 * given hostname instead, such as a domain attached by hand. The zones may
 * arrive after the first render (read when a dialog opens); until the admin
 * picks or types, both fields follow them.
 */
export function useAddressFields(zones: readonly AddressZone[], initial?: AddressTarget) {
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const [only] = zones;
  const presetId = initial?.zoneId ?? (zones.length === 1 && only !== undefined ? only.id : null);
  const zone = zones.find((z) => z.id === (chosenId ?? presetId)) ?? null;
  const subdomain =
    typed ??
    (zone === null
      ? ""
      : initial !== undefined && zone.id === initial.zoneId
        ? subdomainOf(initial.hostname, zone.name)
        : suggestedSubdomain(zone));
  const checked: HostnameCheck | null =
    zone === null ? null : checkSubdomainInZone(subdomain, zone.name);
  return {
    zone,
    subdomain,
    checked,
    hostnameError: touched && checked !== null && !checked.ok ? checked.error : undefined,
    /** The hostname to move to, once the fields name a valid one. */
    target:
      zone !== null && checked?.ok === true
        ? { zoneId: zone.id, hostname: checked.hostname }
        : null,
    chooseZone(id: string | null) {
      setChosenId(id);
    },
    setSubdomain(value: string) {
      setTyped(value);
    },
    touch() {
      setTouched(true);
    },
  };
}

export type AddressFieldsState = ReturnType<typeof useAddressFields>;

/**
 * The move's job was last seen running in its wait for the new address or
 * after it: from then on it may switch, which moves Cloudflare Access away
 * from this address. Before the wait nothing has moved Access.
 */
export function waitStarted(job: JobView | null | undefined): boolean {
  if (job == null || job.status !== "running") return false;
  return job.logs.some((l) => l.message.startsWith(MOVE_STEPS.wait));
}

/** Consecutive refusals after which the page suggests a reload. */
export const REFUSALS_BEFORE_HINT = 3;

/**
 * One move (or change) of the address: the call that checks and attaches
 * the domain and starts the job, the DNS records it would replace (asked
 * about before replacing them), then the job, followed live until it ends.
 * `onMoved` runs once it has succeeded; a failure shows the job's message.
 * Closing the page loses nothing: the job goes on, and `resume` follows a
 * job already running when the page opened. `returnTo` is the page to open
 * at the new address once signed in there.
 */
export function useAddressMove({
  kind,
  returnTo,
  resume,
  onMoved,
}: {
  kind: "move" | "change";
  returnTo?: string;
  resume?: MoveJobRef;
  onMoved?: (movedTo: MovedTo) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [following, setFollowing] = useState<(MoveJobRef & { url: string | null }) | null>(
    resume === undefined ? null : { ...resume, url: null },
  );
  const [movedTo, setMovedTo] = useState<MovedTo | null>(null);
  const [conflict, setConflict] = useState<DnsConflict | null>(null);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moved = useRef(onMoved);
  moved.current = onMoved;

  function arrive(to: MovedTo) {
    setMovedTo(to);
    setFollowing(null);
    moved.current?.(to);
  }

  const latest = useRef<{ job: JobView | null | undefined; following: typeof following }>({
    job: undefined,
    following,
  });
  // Access refusals in a row that could not be read as the switch.
  const [refusals, setRefusals] = useState(0);
  const job = useLiveJob(following?.jobId ?? null, undefined, {
    // After a move, this address has nothing more to show (with Access on it
    // refuses every read by then); after a failure the page reads its rows again.
    refreshAfter: (ended) => ended.status === "failed",
    // With Cloudflare Access on, the switch moves Access to the new address,
    // and this page's address then refuses every call: the job has switched.
    onPollError(err) {
      const { job: seen, following: now } = latest.current;
      if (now === null || !isAccessDenied(err)) return;
      if (!waitStarted(seen)) {
        setRefusals((n) => n + 1);
        return;
      }
      arrive({
        hostname: now.hostname,
        url: seen?.addressMove?.url || now.url || `https://${now.hostname}/login?moved=1`,
      });
    },
  });
  latest.current = { job, following };
  // A poll that answered ends a run of refusals.
  useEffect(() => {
    if (job !== undefined) setRefusals(0);
  }, [job]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `arrive` only sets state and calls the latest `onMoved`
  useEffect(() => {
    if (following === null || job === undefined) return;
    if (job === null) {
      setError("The move's job could not be found. Reload the page.");
      setFollowing(null);
      return;
    }
    if (job.id !== following.jobId) return;
    if (job.status === "succeeded") {
      const hostname = job.addressMove?.hostname || following.hostname;
      arrive({
        hostname,
        url: job.addressMove?.url || following.url || `https://${hostname}/login?moved=1`,
      });
    } else if (job.status === "failed") {
      setError(job.error ?? "The move stopped. Open its job to see why.");
      setFollowing(null);
    }
  }, [job, following]);

  const blocked = conflict !== null && !replace;
  const moving = starting || following !== null;

  async function run(target: AddressTarget): Promise<void> {
    if (moving || movedTo !== null || blocked) return;
    setStarting(true);
    setError(null);
    const call = kind === "move" ? moveManagerAddress : changeManagerAddress;
    try {
      const result = await call({
        data: {
          zoneId: target.zoneId,
          hostname: target.hostname,
          ...(conflict !== null && replace ? { overrideExistingDnsRecord: true } : {}),
          ...(returnTo === undefined ? {} : { returnTo }),
        },
      });
      if (result.ok) {
        setFollowing({ jobId: result.jobId, hostname: result.hostname, url: result.url });
      } else {
        setConflict({ hostname: result.hostname, records: result.records });
        setReplace(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move Appflare. Try again.");
    } finally {
      setStarting(false);
    }
  }

  return {
    /** The start call runs, or its job does. */
    moving,
    starting,
    /** The job being followed, while it runs. */
    following,
    job: following === null ? undefined : job,
    /** Access refused several polls in a row before the wait began: a reload tells more. */
    refused: following !== null && refusals >= REFUSALS_BEFORE_HINT,
    movedTo,
    conflict,
    replace,
    setReplace,
    /** The DNS records warning is up and its box is not ticked yet. */
    blocked,
    error,
    run,
    /** The fields changed: a warning about the old hostname no longer applies. */
    edited() {
      setConflict(null);
      setReplace(false);
    },
  };
}

export type AddressMoveState = ReturnType<typeof useAddressMove>;

/** The primary button's words for the move's state. */
export function moveActionLabel(move: AddressMoveState, idle: string): string {
  if (move.conflict !== null) return "Replace records and move";
  return move.error !== null ? "Try again" : idle;
}

/**
 * The zone picker, the host field, the DNS records warning, and the move's
 * error (the server's or the job's words, which say what became of the domain).
 */
export function AddressFields({
  zones,
  fields,
  move,
}: {
  zones: readonly AddressZone[];
  fields: AddressFieldsState;
  move: AddressMoveState;
}) {
  const disabled = move.moving;
  const { zone, checked } = fields;
  const atRoot = zone !== null && checked?.ok === true && checked.hostname === zone.name;
  return (
    <div className="grid gap-4">
      <Select
        label="Domain"
        placeholder="Choose a domain"
        value={zone?.id ?? null}
        onValueChange={(v) => {
          fields.chooseZone(typeof v === "string" ? v : null);
          move.edited();
        }}
        items={Object.fromEntries(zones.map((z) => [z.id, z.name]))}
        disabled={disabled}
      />
      <ZoneHostnameField
        zoneName={zone?.name ?? null}
        value={fields.subdomain}
        onChange={(next) => {
          fields.setSubdomain(next);
          move.edited();
        }}
        onBlur={fields.touch}
        checked={checked}
        error={fields.hostnameError}
        disabled={disabled}
        subject="Appflare"
      />
      {move.conflict !== null && (
        <DnsConflictNotice
          conflict={move.conflict}
          replace={move.replace}
          onReplaceChange={move.setReplace}
          disabled={disabled}
          checkboxLabel="Replace the existing DNS records with the one for Appflare"
          permanent="Cloudflare deletes them, and Appflare cannot put them back, not even if Appflare later leaves this address."
          {...(atRoot ? { site: `Your site at ${zone.name} stops answering.` } : {})}
        />
      )}
      {move.error !== null && <MoveError message={move.error} />}
    </div>
  );
}

/** A move that did not complete, in the server's or the job's words: they say what became of the domain. */
export function MoveError({ message }: { message: string }) {
  return (
    <div role="alert">
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        description={<MessageText message={message} newTab />}
      />
    </div>
  );
}

const LEVEL_COLOR: Record<string, string> = {
  warn: "text-kumo-warning",
  error: "text-kumo-danger",
};

/**
 * A move while its job runs: the job's log lines as they arrive (the same
 * lines as its page, which "Open the job" leads to), and that the page may
 * be closed. Without `jobId` the request that starts the job still runs.
 * `done` says Appflare has moved, while the browser goes there.
 */
export function MoveProgress({
  hostname,
  jobId,
  job,
  done = false,
  refused = false,
}: {
  hostname: string;
  jobId: string | null;
  job?: JobView | null | undefined;
  done?: boolean;
  /** Cloudflare Access refused several checks of the job in a row. */
  refused?: boolean;
}) {
  const lines = job?.logs ?? [];
  return (
    <div className="grid gap-3" role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        {!done && <AppflareLoader size="sm" aria-hidden />}
        <Text bold>
          {done ? `Appflare moved to ${hostname}` : `Moving Appflare to ${hostname}`}
        </Text>
      </div>
      {!done &&
        (jobId === null ? (
          <Text variant="secondary">Checking the name and attaching the domain…</Text>
        ) : (
          <Text variant="secondary">
            This can take a few minutes while Cloudflare issues the certificate. You can close this
            page; the move continues.
          </Text>
        ))}
      {lines.length > 0 && (
        <ol className="grid max-h-64 gap-1.5 overflow-y-auto" aria-label="The move's log">
          {lines.map((line) => (
            <li key={line.id} className="flex items-start gap-2" data-level={line.level}>
              <CircleIcon
                weight="fill"
                size={8}
                className={`mt-1.5 shrink-0 ${LEVEL_COLOR[line.level] ?? "text-kumo-inactive"}`}
                aria-hidden
              />
              <Text as="span" size="sm">
                <MessageText message={line.message} />
              </Text>
            </li>
          ))}
        </ol>
      )}
      {refused && !done && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          description="Cloudflare Access refused the last few checks of the move, so this page cannot tell where it stands. Reload the page, or open Appflare at its new address."
          action={
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        />
      )}
      {jobId !== null && (
        <div>
          <Link href={`/jobs/${jobId}`}>Open the job</Link>
        </div>
      )}
    </div>
  );
}

/**
 * What is shown once Appflare lives at a new address, over the page it was
 * moved from, which stays behind the dialog: sessions belong to one address,
 * so everyone signs in again there, and the link opens its sign-in page.
 * It cannot be dismissed. Render it once any dialog that led here has
 * closed; it opens itself and puts focus on the link.
 */
export function MovedNotice({ movedTo }: { movedTo: MovedTo }) {
  const link = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  return (
    <LayerDialog.Root
      open={open}
      dismissDisabled
      disablePointerDismissal
      onOpenChangeComplete={(opened) => {
        if (opened) link.current?.focus();
      }}
    >
      <LayerDialog.Content>
        <LayerDialog.Title>Appflare now lives at {movedTo.hostname}</LayerDialog.Title>
        <LayerDialog.Description>Sign in again there.</LayerDialog.Description>
        <LayerDialog.Body>
          <div className="grid gap-4">
            <Text variant="secondary">{MOVED_PASSKEY_NOTE}</Text>
            <LinkButton
              ref={link}
              href={movedTo.url}
              variant="primary"
              className="w-full justify-center"
            >
              Go to {movedTo.hostname}
            </LinkButton>
          </div>
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
