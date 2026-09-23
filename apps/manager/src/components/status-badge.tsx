import { Badge } from "@cloudflare/kumo";

type BadgeVariant = "success" | "error" | "warning" | "info" | "neutral";

const INSTALL: Record<string, { variant: BadgeVariant; label: string }> = {
  installing: { variant: "info", label: "Installing" },
  installed: { variant: "success", label: "Installed" },
  updating: { variant: "info", label: "Updating" },
  failed: { variant: "error", label: "Failed" },
  uninstalling: { variant: "warning", label: "Uninstalling" },
  uninstalled: { variant: "neutral", label: "Uninstalled" },
};

const JOB: Record<string, { variant: BadgeVariant; label: string }> = {
  queued: { variant: "neutral", label: "Queued" },
  running: { variant: "info", label: "Running" },
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

export function PlanBadge({ plan }: { plan: string }) {
  return plan === "paid" ? (
    <Badge variant="orange">Workers Paid</Badge>
  ) : (
    <Badge variant="neutral">Free plan</Badge>
  );
}
