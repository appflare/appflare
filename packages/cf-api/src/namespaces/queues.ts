import type { HttpApi } from "../http";
import type { Queue } from "../types";

const enc = encodeURIComponent;

/** Queues. */
export function createQueues(http: HttpApi) {
  return {
    /** `POST /queues` with `{ queue_name }`. */
    createQueue(queueName: string): Promise<Queue> {
      return http.result("POST", http.acct("/queues"), { json: { queue_name: queueName } });
    },

    /** `DELETE /queues/{id}`. */
    deleteQueue(queueId: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/queues/${enc(queueId)}`));
    },
  };
}
