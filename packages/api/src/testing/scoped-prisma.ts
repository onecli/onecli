import type { db, Prisma } from "@onecli/db";
import { LEGACY_LOCAL_AUTH_ID } from "../lib/legacy-local-identity";

/**
 * A Prisma client that answers "there is no pre-2.0 placeholder row here".
 *
 * TESTS ONLY. The sign-up path's one refusal — the upgrade-window guard
 * (`registration.ts`) — opens with an indexed lookup for the `local-admin`
 * placeholder. Proof suites that assert sign-up SUCCEEDS run against a shared
 * proof database, and the adoption suite seeds a real placeholder row into
 * that same database while it runs; without this scope, a success proof would
 * flake exactly while that fixture exists. The whole-table question is
 * answered locally (the guard's own behavior is proven in the unit suite and
 * in the adoption suite's wiring proof); everything else — the adapter's
 * reads and writes included — passes through untouched.
 *
 * Same idea as the adoption proof's `withScopedUserCount`: scope the one
 * cross-suite question, keep the rest real. A Proxy rather than a spread,
 * because the root client's model delegates live on its prototype and a
 * spread would silently drop them.
 */
export const withoutLegacyLocalRow = (client: typeof db): typeof db => {
  const scopedUser = new Proxy(client.user, {
    get(target, prop, receiver) {
      if (prop !== "findUnique") return Reflect.get(target, prop, receiver);
      const findUnique = ((args: Prisma.UserFindUniqueArgs) =>
        args.where.externalAuthId === LEGACY_LOCAL_AUTH_ID
          ? Promise.resolve(null)
          : target.findUnique(args)) as unknown as typeof target.findUnique;
      return findUnique;
    },
  });
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "user") return scopedUser;
      return Reflect.get(target, prop, receiver);
    },
  });
};
