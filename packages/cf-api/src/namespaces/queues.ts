import type { HttpApi } from "../http";
import type { Queue, QueueConsumerInfo, WorkerQueueConsumerBody } from "../types";

const enc = encodeURIComponent;

/** Queues and their consumers. */
export function createQueues(http: HttpApi) {
  return {
    /** `POST /queues` with `{ queue_name }`. */
    createQueue(queueName: string): Promise<Queue> {
      return http.result("POST", http.acct("/queues"), { json: { queue_name: queueName } });
    },

    /** `GET /queues`: every queue in the account, across all pages. */
    listQueues(): Promise<Queue[]> {
      return http.list("GET", http.acct("/queues"));
    },

    /** `DELETE /queues/{id}`. */
    deleteQueue(queueId: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/queues/${enc(queueId)}`));
    },

    /**
     * `POST /queues/{id}/consumers`: attaches a Worker as the queue's consumer.
     * A queue has at most one Worker consumer.
     */
    createConsumer(queueId: string, body: WorkerQueueConsumerBody): Promise<QueueConsumerInfo> {
      return http.result("POST", http.acct(`/queues/${enc(queueId)}/consumers`), { json: body });
    },

    /** `GET /queues/{id}/consumers`. */
    listConsumers(queueId: string): Promise<QueueConsumerInfo[]> {
      return http.result("GET", http.acct(`/queues/${enc(queueId)}/consumers`));
    },

    /** `PUT /queues/{id}/consumers/{consumer_id}`: replaces the consumer's settings. */
    updateConsumer(
      queueId: string,
      consumerId: string,
      body: WorkerQueueConsumerBody,
    ): Promise<QueueConsumerInfo> {
      return http.result("PUT", http.acct(`/queues/${enc(queueId)}/consumers/${enc(consumerId)}`), {
        json: body,
      });
    },

    /** `DELETE /queues/{id}/consumers/{consumer_id}`. */
    deleteConsumer(queueId: string, consumerId: string): Promise<unknown> {
      return http.result(
        "DELETE",
        http.acct(`/queues/${enc(queueId)}/consumers/${enc(consumerId)}`),
      );
    },
  };
}
