import { Badge, Banner, Button, LayerCard, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  PlugsConnectedIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ENABLE_SANDBOX_COMMAND } from "../sandbox/connect-copy";
import { connectSandbox, type SandboxStatus } from "../server/sandbox.functions";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";

/**
 * Settings, Sandbox builds: whether this manager can install apps that have
 * no prebuilt release (the `sandbox` tier), which the account's sandbox
 * Worker builds on Workers Paid. Connected shows the sandbox Worker's
 * version and image; otherwise the card tells how to enable it (the CLI) or,
 * when the sandbox Worker already exists, offers "Connect sandbox builds".
 */
export function SandboxCard({ status, isAdmin }: { status: SandboxStatus; isAdmin: boolean }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1">
          Sandbox builds
          <DocsLink topic="sandboxBuilds" />
        </span>
        {status.connected && status.problem === null ? (
          <Badge variant="success">Connected</Badge>
        ) : status.connected ? (
          <Badge variant="warning">Not answering</Badge>
        ) : (
          <Badge variant="neutral">Off</Badge>
        )}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <Text variant="secondary">
          Some catalog apps have no prebuilt release. Appflare can build them from their pinned
          commit in a container in your own account, with the optional sandbox Worker. Builds need
          Workers Paid and are not signed.
        </Text>
        {status.connected ? (
          <ConnectedDetails status={status} />
        ) : (
          <NotConnected status={status} isAdmin={isAdmin} />
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}

function ConnectedDetails({ status }: { status: SandboxStatus }) {
  if (status.info === null) {
    return (
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        title="The sandbox Worker does not answer as expected"
        description={status.problem ?? undefined}
      />
    );
  }
  return (
    <DescriptionList>
      <DescriptionItem label="Sandbox Worker">
        <span className="font-mono text-[0.9em]">{status.info.sandboxVersion}</span>
      </DescriptionItem>
      <DescriptionItem label="Image">
        <span className="font-mono text-[0.9em]">{status.info.image}</span>
      </DescriptionItem>
    </DescriptionList>
  );
}

function NotConnected({ status, isAdmin }: { status: SandboxStatus; isAdmin: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onConnect() {
    setPending(true);
    setError(null);
    try {
      await connectSandbox();
      setDone(true);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect sandbox builds.");
    }
    setPending(false);
  }

  if (done) {
    return (
      <Banner
        icon={<CheckCircleIcon weight="fill" />}
        title="Sandbox builds are connected"
        description="Appflare now runs with its binding to the sandbox Worker. It can take a few seconds to show here."
      />
    );
  }
  if (status.workerExists === true) {
    return (
      <div className="grid gap-3">
        <Text>
          The sandbox Worker is in this account. Connecting deploys a copy of the running Appflare
          version with a binding to it, after checking that copy answers.
        </Text>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        {isAdmin ? (
          <div className="flex justify-end">
            <Button
              variant="primary"
              icon={<PlugsConnectedIcon />}
              loading={pending}
              onClick={onConnect}
            >
              Connect sandbox builds
            </Button>
          </div>
        ) : (
          <Text variant="secondary" size="sm">
            Only admins can connect it.
          </Text>
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Text>
        To enable them, run this on a computer with Node.js 22 and a wrangler login to this account,
        then come back and connect:
      </Text>
      <Text variant="mono">{ENABLE_SANDBOX_COMMAND}</Text>
      {status.workerExists === null && isAdmin && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Appflare could not check whether the sandbox Worker exists."
        />
      )}
    </div>
  );
}
