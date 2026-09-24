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

    /**
     * `DELETE /workflows/{workflow_name}`: the Workflow and its instances.
     * Deleting the Worker that runs a Workflow leaves the Workflow in place,
     * so whoever removes the Worker for good deletes its Workflow too.
     * Throws `CloudflareApiError` (404 when absent).
     */
    deleteWorkflow(name: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/workflows/${enc(name)}`));
    },
  };
}
