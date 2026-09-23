import type { HttpApi } from "../http";
import type { WorkflowInfo } from "../types";

const enc = encodeURIComponent;

/**
 * Workflows (account-scoped names). A Worker upload whose `workflow` binding
 * names an existing Workflow of another script reassigns it, so installers check
 * a name is free before uploading.
 */
export function createWorkflows(http: HttpApi) {
  return {
    /** `GET /workflows/{workflow_name}`; throws `CloudflareApiError` (404 when absent). */
    getWorkflow(name: string): Promise<WorkflowInfo> {
      return http.result("GET", http.acct(`/workflows/${enc(name)}`));
    },
  };
}
