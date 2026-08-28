import { describe, expect, it, vi } from "vitest";
import type { db } from "@onecli/db";
import { LEGACY_LOCAL_AUTH_ID } from "../lib/legacy-local-identity";
import { withoutLegacyLocalRow } from "./scoped-prisma";

/**
 * The helper's whole contract is surgical: exactly one question — "is there a
 * pre-2.0 placeholder?" — is answered locally, and every other read and write
 * passes through untouched. A hole in the passthrough would silently change
 * what the pg proof suites that use it actually prove, and a wider intercept
 * would disarm more than the cross-suite flake it exists to prevent.
 */

const fakeClient = () => {
  const findUnique = vi.fn(async () => ({ id: "someone" }));
  const create = vi.fn(async () => ({ id: "created" }));
  const sessionFindMany = vi.fn(async () => []);
  const client = {
    user: { findUnique, create },
    session: { findMany: sessionFindMany },
  } as unknown as typeof db;
  return { client, findUnique, create, sessionFindMany };
};

describe("withoutLegacyLocalRow", () => {
  it("answers the placeholder lookup locally, without touching the client", async () => {
    const { client, findUnique } = fakeClient();
    const scoped = withoutLegacyLocalRow(client);

    await expect(
      scoped.user.findUnique({
        where: { externalAuthId: LEGACY_LOCAL_AUTH_ID },
      }),
    ).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("passes every other user lookup through", async () => {
    const { client, findUnique } = fakeClient();
    const scoped = withoutLegacyLocalRow(client);

    await expect(
      scoped.user.findUnique({ where: { email: "op@example.test" } }),
    ).resolves.toEqual({ id: "someone" });
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: "op@example.test" },
    });
  });

  it("passes other user operations and other models through untouched", async () => {
    const { client, create, sessionFindMany } = fakeClient();
    const scoped = withoutLegacyLocalRow(client);

    await scoped.user.create({
      data: { email: "op@example.test", externalAuthId: "ba:1" },
    });
    expect(create).toHaveBeenCalled();

    await scoped.session.findMany();
    expect(sessionFindMany).toHaveBeenCalled();
  });
});
