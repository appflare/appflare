import { Badge } from "@cloudflare/kumo";

/**
 * The variants a dot badge can color its dot with. Kumo's dot appearance has
 * no `info` dot: any other variant logs an "Unknown variant" warning and falls
 * back to no dot. In-progress states use the neutral dot, which Kumo describes
 * as the informational one; the label tells them apart from `queued`.
 */
type DotVariant = "success" | "error" | "warning" | "neutral";

const INSTALL: Record<string, { variant: DotVariant; label: string }> = {
  installing: { variant: "neutral", label: "Installing" },
  installed: { variant: "success", label: "Installed" },
  updating: { variant: "neutral", label: "Updating" },
  failed: { variant: "error", label: "Failed" },
  uninstalling: { variant: "warning", label: "Uninstalling" },
  uninstalled: { variant: "neutral", label: "Uninstalled" },
};

const JOB: Record<string, { variant: DotVariant; label: string }> = {
  queued: { variant: "neutral", label: "Queued" },
  running: { variant: "neutral", label: "Running" },
  succeeded: { variant: "success", label: "Succeeded" },
  failed: { variant: "error", label: "Failed" },
};

/** Install (`installs.status`) or job (`jobs.status`) state as a dot badge. */
export function StatusBadge({ status, of }: { status: string; of: "install" | "job" }) {
  const entry = (of === "install" ? INSTALL : JOB)[status] ?? {
    variant: "neutral" as const,
    label: status,
  };
  return (
    <Badge variant={entry.variant} appearance="dot">
      {entry.label}
    </Badge>
  );
}
