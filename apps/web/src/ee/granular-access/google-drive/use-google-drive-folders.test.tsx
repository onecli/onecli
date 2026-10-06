// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MAX_NAME_LOOKUPS } from "@onecli/api/ee/granular-access/shape/google-drive";

const folderNames = vi.hoisted(() =>
  vi.fn(async (_connectionId: string, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, `name-${id}`])),
  ),
);
vi.mock("@/lib/api", () => ({ googleDrive: { folderNames } }));

const { useGoogleDriveFolderNames } =
  await import("./use-google-drive-folders");

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

describe("useGoogleDriveFolderNames", () => {
  it("asks for a large saved policy in batches the route accepts", async () => {
    // More distinct IDs than one lookup resolves, plus a duplicate.
    const ids = Array.from(
      { length: MAX_NAME_LOOKUPS * 2 + 1 },
      (_, i) => `id${i}`,
    );
    const { result } = renderHook(
      () => useGoogleDriveFolderNames("c1", [...ids, "id0"]),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(folderNames).toHaveBeenCalledTimes(3);
    for (const [, batch] of folderNames.mock.calls) {
      expect(batch.length).toBeLessThanOrEqual(MAX_NAME_LOOKUPS);
    }
    expect(Object.keys(result.current.data ?? {})).toHaveLength(ids.length);
    expect(result.current.data?.id400).toBe("name-id400");
  });
});
