import { Banner, LayerDialog, LinkButton, Select, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, CircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  type AddressOptions,
  changeManagerAddress,
  moveManagerAddress,
} from "../domains/manager-address.functions";
import { MOVED_PASSKEY_NOTE } from "../domains/moved-note";
import { checkSubdomainInZone, type HostnameCheck } from "../installs/custom-domain-input";
import { AppflareLoader } from "./appflare-loader";
import { type DnsConflict, DnsConflictNotice } from "./domain-dialog-parts";
import { MessageText } from "./message-text";
import { ZoneHostnameField } from "./zone-hostname-field";

/**
 * Moving Appflare to a domain of the account, as the Domains settings and
 * the setup wizard both do it: the zone picker and host field, the DNS
 * records warning, the steps shown while the one long request runs, and the
 * page shown once Appflare lives at the new address.
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
 * One move (or change) of the address: the call, the DNS records it would
 * replace (asked about before replacing them), and its error. `returnTo` is
 * the page to open at the new address once signed in there.
 */
export function useAddressMove({ kind, returnTo }: { kind: "move" | "change"; returnTo?: string }) {
  const [phase, setPhase] = useState<"idle" | "moving" | "moved">("idle");
  const [movedTo, setMovedTo] = useState<MovedTo | null>(null);
  const [conflict, setConflict] = useState<DnsConflict | null>(null);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = conflict !== null && !replace;

  // Leaving the page while the request runs would leave the move unfinished.
  // The guard goes as soon as the call settles, before a caller navigates on.
  const guard = useRef<(() => void) | null>(null);
  useEffect(() => () => guard.current?.(), []);

  async function run(target: AddressTarget): Promise<MovedTo | null> {
    if (phase !== "idle" || blocked) return null;
    setPhase("moving");
    setError(null);
    guard.current = guardUnload();
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
        const done = { hostname: result.hostname, url: result.url };
        setMovedTo(done);
        setPhase("moved");
        return done;
      }
      setConflict({ hostname: result.hostname, records: result.records });
      setReplace(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move Appflare. Try again.");
    } finally {
      guard.current?.();
      guard.current = null;
    }
    setPhase("idle");
    return null;
  }

  return {
    moving: phase === "moving",
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

/**
 * Asks the browser to confirm before the page is left or reloaded; returns
 * the function that stops asking.
 */
function guardUnload(): () => void {
  if (typeof window === "undefined") return () => {};
  const ask = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // Older browsers ask only when `returnValue` is set.
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", ask);
  return () => window.removeEventListener("beforeunload", ask);
}

export type AddressMoveState = ReturnType<typeof useAddressMove>;

/** The primary button's words for the move's state. */
export function moveActionLabel(move: AddressMoveState, idle: string): string {
  if (move.conflict !== null) return "Replace records and move";
  return move.error !== null ? "Try again" : idle;
}

/**
 * The zone picker, the host field, the DNS records warning, and the move's
 * error (the server's words, which say what became of the domain).
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

/** A move that did not complete, in the server's words: they say what became of the domain. */
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

/** What a move does, in order. The one request does them all; the page can only estimate which runs. */
export const MOVE_STEPS = [
  "Attaching the domain",
  "Waiting for the new address to answer",
  "Switching",
] as const;

/** About how long attaching takes (a handful of Cloudflare calls) before the wait begins. */
export const ATTACH_ESTIMATE_MS = 5000;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The steps of a move while its request runs: the first until attaching
 * has most likely finished, then the wait for the new address, which takes
 * the longest. `done` marks every step finished. When the system asks for
 * reduced motion, the steps are a still list under one indicator.
 */
export function MoveProgress({ hostname, done = false }: { hostname: string; done?: boolean }) {
  const [reduced] = useState(prefersReducedMotion);
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    if (reduced || done) return;
    const timer = setTimeout(() => setCurrent(1), ATTACH_ESTIMATE_MS);
    return () => clearTimeout(timer);
  }, [reduced, done]);

  return (
    <div className="grid gap-3" role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        {reduced && !done && <AppflareLoader size="sm" aria-hidden />}
        <Text bold>
          {done ? `Appflare moved to ${hostname}` : `Moving Appflare to ${hostname}`}
        </Text>
      </div>
      {!done && (
        <Text variant="secondary">
          This can take a few minutes while Cloudflare issues the certificate. Keep this page open.
        </Text>
      )}
      <ol className={reduced ? "grid list-inside list-decimal gap-1.5" : "grid gap-2"}>
        {MOVE_STEPS.map((label, index) => {
          if (reduced) {
            return (
              <li key={label}>
                <Text as="span">{label}</Text>
              </li>
            );
          }
          const state = done || index < current ? "done" : index === current ? "current" : "next";
          return (
            <li key={label} className="flex items-center gap-2" data-step={state}>
              {state === "done" ? (
                <CheckCircleIcon weight="fill" className="shrink-0 text-kumo-success" />
              ) : state === "current" ? (
                <AppflareLoader size="sm" aria-hidden />
              ) : (
                <CircleIcon className="shrink-0 text-kumo-inactive" />
              )}
              <Text as="span" variant={state === "next" ? "secondary" : "body"}>
                {label}
              </Text>
            </li>
          );
        })}
      </ol>
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
