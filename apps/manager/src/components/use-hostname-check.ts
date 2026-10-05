import { useEffect, useRef, useState } from "react";
import { checkInstallHostname } from "../installs/custom-domains.functions";
import {
  HOSTNAME_CHECK_DELAY_MS,
  type InstallHostnameAnswer,
  type InstallHostnameCheck,
} from "../installs/install-hostname-check";
import type { InstallDomainInput } from "../installs/install-input";

/**
 * The live check of the install form's custom domain
 * (`install-hostname-check.ts`), or null while it does not apply: no domain,
 * another kind of domain, or a form that cannot install. Like the Worker
 * name's, it asks once typing pauses. Only a free name is kept for the
 * form's lifetime (by hostname and Worker name), so going back to it asks no
 * more; a name in use is asked again each time it comes back, since its
 * records may have been deleted meanwhile, and a failed request reads as
 * "could not check".
 */
export function useInstallHostnameCheck(
  domain: InstallDomainInput | null,
  workerName: string,
  enabled: boolean,
  /** "Install again": the failed install whose removal frees its domains. */
  replaces: string | null = null,
): InstallHostnameCheck | null {
  const kept = useRef(new Map<string, InstallHostnameAnswer>());
  const [last, setLast] = useState<{ key: string; answer: InstallHostnameAnswer } | null>(null);
  const zoneId = domain?.kind === "custom" ? domain.zoneId : null;
  const hostname = domain?.kind === "custom" ? domain.hostname : null;
  const key =
    enabled && zoneId !== null && hostname !== null && workerName !== ""
      ? JSON.stringify([zoneId, hostname, workerName, replaces])
      : null;

  useEffect(() => {
    if (key === null || zoneId === null || hostname === null || kept.current.has(key)) return;
    let live = true;
    const timer = setTimeout(() => {
      void checkInstallHostname({
        data: { zoneId, hostname, workerName, ...(replaces === null ? {} : { replaces }) },
      })
        .catch((): InstallHostnameAnswer => ({ state: "unknown" }))
        .then((answer) => {
          if (answer.state === "free") kept.current.set(key, answer);
          if (live) setLast({ key, answer });
        });
    }, HOSTNAME_CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, zoneId, hostname, workerName, replaces]);

  if (key === null) return null;
  return kept.current.get(key) ?? (last?.key === key ? last.answer : { state: "checking" });
}
