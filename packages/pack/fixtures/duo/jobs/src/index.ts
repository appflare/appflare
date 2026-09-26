// Second Worker of the `duo` packer fixture (see packages/pack/fixtures/README.md).
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Counter extends DurableObject {}

export class Jobs extends WorkerEntrypoint {
  async ping(): Promise<string> {
    return "pong";
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("duo jobs\n");
  },
  async queue(): Promise<void> {},
};
