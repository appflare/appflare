// Primary Worker of the `duo` packer fixture (see packages/pack/fixtures/README.md).
export default {
  async fetch(): Promise<Response> {
    return new Response("duo web\n");
  },
};
