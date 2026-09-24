import { useKumoToastManager } from "@cloudflare/kumo";
import { useRouter } from "@tanstack/react-router";

/**
 * After a server function started a job: a Kumo toast saying so, then the
 * job's log, where it can be followed. `title` names what started, such as
 * "Update started".
 */
export function useJobStarted(): (jobId: string, title: string) => Promise<void> {
  const router = useRouter();
  const toasts = useKumoToastManager();
  return async (jobId, title) => {
    toasts.add({
      title,
      description: "Its log shows each step as it runs.",
      variant: "info",
    });
    await router.navigate({ to: "/jobs/$jobId", params: { jobId } });
  };
}
