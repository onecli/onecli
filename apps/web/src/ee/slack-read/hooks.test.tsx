// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/keys";
import type { ReadGrant } from "./api";

/** The PUT never settles: what the cache shows is the optimistic write. */
vi.mock("./api", () => ({
  setGrant: vi.fn(() => new Promise(() => {})),
}));

const { useSetReadGrant } = await import("./hooks");

const grant = (id: string, mine: boolean): ReadGrant => ({
  id,
  subjectKind: "channel",
  externalRef: "C0SHARED",
  subjectLabel: "#weekly-reports",
  counterpartRef: null,
  readMode: "allow",
  writeMode: "never",
  grantedBy: { id: `u-${id}`, name: id, email: `${id}@example.com` },
  mine,
});

describe("useSetReadGrant", () => {
  it("moves only the viewer's own share; a teammate's share of the same channel stays put", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const key = [...queryKeys.channels.slackRead("a"), "grants"];
    qc.setQueryData(key, {
      grants: [grant("mine", true), grant("alex", false)],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSetReadGrant("a"), { wrapper });

    await act(async () => {
      result.current.mutate({ externalRef: "C0SHARED", writeMode: "allow" });
      await Promise.resolve();
    });

    const after = qc.getQueryData<{ grants: ReadGrant[] }>(key)!.grants;
    expect(after.find((g) => g.id === "mine")!.writeMode).toBe("allow");
    expect(after.find((g) => g.id === "alex")!.writeMode).toBe("never");
  });
});
