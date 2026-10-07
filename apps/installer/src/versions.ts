/**
 * Semver precedence for release versions (`0.4.0`, `0.4.0-rc.1`). The same
 * rules as the manager's update check (apps/manager/src/catalog/versions.ts).
 */

interface SemVer {
  core: [number, number, number];
  pre: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(version: string): SemVer | null {
  const m = SEMVER.exec(version.trim());
  if (m === null) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4].split("."),
  };
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative when a < b. Null when either is not semver. */
export function compareVersions(a: string, b: string): number | null {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va === null || vb === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (va.pre.length === 0 || vb.pre.length === 0) {
    return va.pre.length === vb.pre.length ? 0 : va.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const d = compareIdentifiers(x, y);
    if (d !== 0) return d;
  }
  return 0;
}
