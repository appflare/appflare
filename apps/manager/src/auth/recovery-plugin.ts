import type { BetterAuthPlugin } from "@better-auth/core";
import { createAuthEndpoint } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import * as z from "zod";
import { RecoveryError, recoverWithCode } from "./recovery.server";
import { RECOVERY_CODE_PATH } from "./recovery-messages";

/**
 * Tries per client address and window. A code has 100 random bits, so this is
 * not what keeps it from being guessed; it keeps the endpoint from being used
 * to hammer the database or to test many emails against one valid code.
 */
export const RECOVERY_CODE_RATE_LIMIT = { window: 600, max: 5 } as const;

export interface RecoveryPluginDeps {
  d1: D1Database;
  /** `RECOVERY_CODE_HASH` of the version serving the request. */
  accountSecret: () => string | undefined;
  /** Epoch ms the serving version was created, which caps the code's expiry. */
  accountSecretSince?: () => number | undefined;
  /** Runs after a code from the Cloudflare account was used: deletes the Worker secret. */
  onAccountCodeUsed: () => void;
  now?: () => Date;
}

/**
 * Better Auth plugin for the sign-in page's "I have a recovery code": one
 * endpoint, rate limited like the other unauthenticated password endpoints
 * (in D1, per client address). The checks live in `recovery.server.ts`; this
 * sets the password through Better Auth's own adapter (hashing it the way
 * sign-in expects) and signs the user out everywhere.
 */
export function recoveryCodes(deps: RecoveryPluginDeps) {
  return {
    id: "appflare-recovery-codes",
    endpoints: {
      resetPasswordWithRecoveryCode: createAuthEndpoint(
        RECOVERY_CODE_PATH,
        {
          method: "POST",
          body: z.object({
            email: z.string().max(320),
            code: z.string().max(64),
            newPassword: z.string().max(1024),
          }),
        },
        async (ctx) => {
          const { internalAdapter, password } = ctx.context;
          try {
            const result = await recoverWithCode(
              {
                d1: deps.d1,
                now: (deps.now ?? (() => new Date()))(),
                accountSecret: deps.accountSecret(),
                accountSecretSince: deps.accountSecretSince?.(),
                passwordLimits: {
                  min: password.config.minPasswordLength,
                  max: password.config.maxPasswordLength,
                },
                async setPassword(userId, newPassword) {
                  const hashed = await password.hash(newPassword);
                  if ((await internalAdapter.findCredentialAccount(userId)) === null) {
                    await internalAdapter.createAccount({
                      userId,
                      providerId: "credential",
                      accountId: userId,
                      password: hashed,
                    });
                  } else {
                    await internalAdapter.updatePassword(userId, hashed);
                  }
                  await internalAdapter.deleteUserSessions(userId);
                },
              },
              ctx.body,
            );
            if (result.method === "account_code") deps.onAccountCodeUsed();
          } catch (error) {
            if (error instanceof RecoveryError) {
              throw APIError.fromStatus("BAD_REQUEST", {
                message: error.message,
                code: error.code,
              });
            }
            throw error;
          }
          return ctx.json({ status: true });
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path === RECOVERY_CODE_PATH,
        ...RECOVERY_CODE_RATE_LIMIT,
      },
    ],
  } satisfies BetterAuthPlugin;
}
