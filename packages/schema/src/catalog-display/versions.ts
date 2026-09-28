const DATE_BUILD = /^0\.0\.0-(\d{4})(\d{2})(\d{2})\.[0-9a-f]+$/i;

/**
 * The day an untagged pin was committed, from its date version
 * (`0.0.0-20260921.4fd08b5` is `2026-09-21`); null for a tagged version or
 * anything that is not a real day.
 */
export function dateBuildDay(version: string): string | null {
  const m = DATE_BUILD.exec(version.trim());
  if (m === null) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? null : day;
}
