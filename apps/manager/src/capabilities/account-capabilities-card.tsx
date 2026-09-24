import { Badge, Banner, Button, LayerCard, Link, Radio, Text } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ACCOUNT_PLAN_COPY, type AccountPlan, accountPlanSchema } from "../account/plan";
import { setAccountPlan } from "../account/plan.functions";
import { formatExactDateTime } from "../components/format";
import { type CapabilitiesView, PLAN_LABELS, SOURCE_LABELS, unknownSentence } from "./capabilities";
import { recheckAccountCapabilities } from "./capabilities.functions";

/** Where an admin turns R2 on (the dashboard asks for a payment method once). */
const R2_DASHBOARD_URL = "https://dash.cloudflare.com/?to=/:account/r2/overview";
/** Where an admin changes the Workers plan. */
const PLANS_URL = "https://dash.cloudflare.com/?to=/:account/workers/plans";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Text as="dt" variant="secondary">
        {label}
      </Text>
      <dd className="grid gap-1">{children}</dd>
    </>
  );
}

function Value({ text, source }: { text: string; source: "Detected" | "Set by you" | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Text as="span">{text}</Text>
      {source !== null && (
        <Badge variant={source === "Detected" ? "info" : "neutral"}>{source}</Badge>
      )}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <Text variant="secondary" size="sm">
      {children}
    </Text>
  );
}

function PlanRow({ view }: { view: CapabilitiesView }) {
  const { plan, source } = view.plan;
  return (
    <Row label="Workers plan">
      <Value
        text={source === "default" ? "Not known, treated as Workers Free" : PLAN_LABELS[plan]}
        source={source === "default" ? null : SOURCE_LABELS[source]}
      />
      {view.workersPlan?.state === "unknown" && (
        <Note>{unknownSentence(view.workersPlan, "plan")}</Note>
      )}
    </Row>
  );
}

function R2Row({ view }: { view: CapabilitiesView }) {
  const { r2 } = view;
  if (r2 === null)
    return (
      <Row label="R2">
        <Value text="Not checked yet" source={null} />
      </Row>
    );
  if (r2.state === "unknown") {
    return (
      <Row label="R2">
        <Value text="Unknown" source={null} />
        <Note>{unknownSentence(r2, "r2")}</Note>
      </Row>
    );
  }
  return (
    <Row label="R2">
      <Value text={r2.state === "enabled" ? "Enabled" : "Not enabled"} source="Detected" />
      {r2.state === "not-enabled" && (
        <Note>
          Apps that store files in R2 cannot be installed until it is on.{" "}
          <Link href={R2_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
            Enable R2 in the dashboard
            <Link.ExternalIcon />
          </Link>
        </Note>
      )}
    </Row>
  );
}

function ContainersRow({ view }: { view: CapabilitiesView }) {
  const { containers } = view;
  if (containers === null) {
    return (
      <Row label="Containers">
        <Value text="Not checked yet" source={null} />
      </Row>
    );
  }
  if (containers.state === "unknown") {
    return (
      <Row label="Containers">
        <Value text="Unknown" source={null} />
        <Note>{unknownSentence(containers, "containers")}</Note>
      </Row>
    );
  }
  return (
    <Row label="Containers">
      <Value
        text={containers.state === "available" ? "Available" : "Need Workers Paid"}
        source="Detected"
      />
      {containers.state === "needs-workers-paid" && (
        <Note>
          Sandbox builds and self-deploying apps run in containers.{" "}
          <Link href={PLANS_URL} target="_blank" rel="noopener noreferrer">
            Workers plans
            <Link.ExternalIcon />
          </Link>
        </Note>
      )}
    </Row>
  );
}

/**
 * Settings, Account capabilities: what the Cloudflare token can tell about
 * the account (R2 enabled, Containers available, Workers plan), each marked
 * "Detected" or "Set by you", and the Workers plan an admin sets for when it
 * cannot be detected. Admins can re-check at once; the token save and the
 * daily cron check too.
 */
export function AccountCapabilitiesCard({
  view,
  isAdmin,
}: {
  view: CapabilitiesView;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [manual, setManual] = useState<AccountPlan | null>(view.manualPlan);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRecheck() {
    setChecking(true);
    setError(null);
    try {
      await recheckAccountCapabilities();
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the account.");
    }
    setChecking(false);
  }

  async function onManualChange(next: string) {
    const parsed = accountPlanSchema.safeParse(next);
    if (!parsed.success || parsed.data === manual) return;
    const previous = manual;
    setManual(parsed.data);
    setSaving(true);
    setError(null);
    try {
      await setAccountPlan({ data: { plan: parsed.data } });
      await router.invalidate();
    } catch (err) {
      setManual(previous);
      setError(err instanceof Error ? err.message : "Could not save the Workers plan.");
    }
    setSaving(false);
  }

  const detected = view.plan.source === "detected";
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span>Account capabilities</span>
        {isAdmin && (
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowClockwiseIcon />}
            loading={checking}
            onClick={onRecheck}
          >
            Re-check
          </Button>
        )}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <Text variant="secondary">
          Appflare reads these with its Cloudflare token when the token is saved, once a day, and
          when an admin chooses Re-check.{" "}
          {view.checkedAt === null
            ? "They have not been checked yet."
            : `Last checked ${formatExactDateTime(view.checkedAt)}.`}
        </Text>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3">
          <PlanRow view={view} />
          <R2Row view={view} />
          <ContainersRow view={view} />
        </dl>
        <div className="grid gap-2">
          <Text variant="secondary">{ACCOUNT_PLAN_COPY.explanation}</Text>
          <Radio.Group
            legend="Workers plan when Appflare cannot detect it"
            value={manual ?? ""}
            onValueChange={(next: string) => void onManualChange(next)}
            disabled={!isAdmin || saving}
            orientation="horizontal"
          >
            <Radio.Item label={ACCOUNT_PLAN_COPY.labels.free} value="free" />
            <Radio.Item label={ACCOUNT_PLAN_COPY.labels.paid} value="paid" />
          </Radio.Group>
          {detected && manual !== null && manual !== view.plan.plan && (
            <Note>
              The detected plan applies. Your choice is used again if Appflare stops being able to
              detect the plan.
            </Note>
          )}
          {!isAdmin && <Note>Only admins can change it.</Note>}
        </div>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
