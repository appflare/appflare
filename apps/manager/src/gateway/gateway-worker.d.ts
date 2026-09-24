/** Types of the gateway Worker's module (gateway-worker.js), for its tests. */

/** What the gateway Worker's bindings look like to its code. */
export interface GatewayEnv {
  /** The gateway zone's name: its own hostnames pass through. */
  ZONE_NAME: string;
  /** The hostname external domains point their CNAME at; answers who it is. */
  CNAME_TARGET: string;
  GATEWAY_VERSION?: string;
  /** Hostname -> service binding name. */
  ROUTES: { get(key: string, options?: { cacheTtl?: number }): Promise<string | null> };
  /** One service binding per app it serves. */
  [binding: string]: unknown;
}

export function clearGatewayCache(): void;

declare const gateway: {
  fetch(request: Request, env: GatewayEnv): Promise<Response>;
};
export default gateway;
