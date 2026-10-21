// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibrarySkill } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import {
  useAgentAvailableLibrarySkills,
  useAttachLibrarySkills,
  useOrgRepoSkills,
  useSetLibrarySkillEnabled,
} from "./use-skill-library";

// The real hooks on a real cache; only the typed client is stubbed.
const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  setEnabled: vi.fn(),
  orgRepoSkills: vi.fn(),
  agentAvailable: vi.fn(),
  agentLibrary: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    skillLibrary: {
      ...actual.skillLibrary,
      attach: mocks.attach,
      setEnabled: mocks.setEnabled,
      orgRepoSkills: mocks.orgRepoSkills,
      agentAvailable: mocks.agentAvailable,
      agentLibrary: mocks.agentLibrary,
    },
  };
});
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

const librarySkill = (
  name: string,
  overrides: Partial<LibrarySkill> = {},
): LibrarySkill => ({
  id: `lib-${name}`,
  name,
  description: `About ${name}`,
  plugin: null,
  path: `skills/${name}`,
  commitSha: "a1b2c3d",
  agentCount: 1,
  enabled: true,
  fileCount: 1,
  skipped: [],
  lastError: null,
  updatedAt: "2026-10-18T00:00:00Z",
  status: "current",
  repoSha: "a1b2c3d",
  checkedAt: null,
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** A client whose retries don't wait, so a retry policy shows in call
 * counts. The hooks' own `retry` still decides how many there are. */
const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } },
  });

const wrapperFor = (qc: QueryClient) => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return Wrapper;
};

afterEach(() => vi.clearAllMocks());

describe("useAttachLibrarySkills", () => {
  it("adds in turn and reports progress through the last one", async () => {
    mocks.attach.mockResolvedValue(librarySkill("x"));
    const { result } = renderHook(() => useAttachLibrarySkills("ag-1"), {
      wrapper: wrapperFor(client()),
    });
    const progress: number[] = [];
    await act(() =>
      result.current.mutateAsync({
        names: ["a", "b", "c"],
        onProgress: (done) => progress.push(done),
      }),
    );
    expect(mocks.attach.mock.calls).toEqual([
      ["ag-1", "a"],
      ["ag-1", "b"],
      ["ag-1", "c"],
    ]);
    expect(progress).toEqual([0, 1, 2, 3]);
  });

  it("a failure stops the run and says how far it got", async () => {
    mocks.attach
      .mockResolvedValueOnce(librarySkill("a"))
      .mockResolvedValueOnce(librarySkill("b"))
      .mockRejectedValueOnce(new ApiError("Folder too large", 422));
    const { result } = renderHook(() => useAttachLibrarySkills("ag-1"), {
      wrapper: wrapperFor(client()),
    });
    const progress: number[] = [];
    act(() =>
      result.current.mutate({
        names: ["a", "b", "x", "d", "e"],
        onProgress: (done) => progress.push(done),
      }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe(
      "Added 2 of 5. Couldn't add x: Folder too large",
    );
    // Nothing after the failure is tried.
    expect(mocks.attach).toHaveBeenCalledTimes(3);
    expect(progress).toEqual([0, 1, 2]);
  });

  it("a first failure names just that skill", async () => {
    mocks.attach.mockRejectedValueOnce(new ApiError("Not found", 404));
    const { result } = renderHook(() => useAttachLibrarySkills("ag-1"), {
      wrapper: wrapperFor(client()),
    });
    act(() =>
      result.current.mutate({ names: ["a", "b"], onProgress: () => {} }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Couldn't add a: Not found");
  });
});

describe("live listing retries", () => {
  const listing = {
    repo: "acme/skills",
    commitSha: "a1b2c3d",
    truncated: false,
    skills: [],
  };

  it("never retries a 404: no library is connected", async () => {
    mocks.orgRepoSkills.mockRejectedValue(
      new ApiError("No skill library is connected", 404),
    );
    const { result } = renderHook(() => useOrgRepoSkills(), {
      wrapper: wrapperFor(client()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.orgRepoSkills).toHaveBeenCalledTimes(1);
  });

  it("retries anything else (GitHub down) twice", async () => {
    mocks.orgRepoSkills.mockRejectedValue(
      new ApiError("GitHub did not respond in time", 502),
    );
    const { result } = renderHook(() => useOrgRepoSkills(), {
      wrapper: wrapperFor(client()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.orgRepoSkills).toHaveBeenCalledTimes(3);
  });

  it("the agent's listing follows the same rule, and a retry can recover", async () => {
    mocks.agentAvailable
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(listing);
    const { result } = renderHook(
      () => useAgentAvailableLibrarySkills("ag-1"),
      { wrapper: wrapperFor(client()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.agentAvailable).toHaveBeenCalledTimes(2);

    mocks.agentAvailable.mockReset();
    mocks.agentAvailable.mockRejectedValue(new ApiError("Gone", 404));
    const missing = renderHook(() => useAgentAvailableLibrarySkills("ag-2"), {
      wrapper: wrapperFor(client()),
    });
    await waitFor(() => expect(missing.result.current.isError).toBe(true));
    expect(mocks.agentAvailable).toHaveBeenCalledTimes(1);
  });

  it("reads nothing while disabled (the picker is closed)", async () => {
    renderHook(() => useAgentAvailableLibrarySkills("ag-1", false), {
      wrapper: wrapperFor(client()),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.agentAvailable).not.toHaveBeenCalled();
  });
});

describe("useSetLibrarySkillEnabled", () => {
  const setup = (rows: LibrarySkill[]) => {
    const qc = client();
    const key = queryKeys.skills.agentLibrary("ag-1");
    qc.setQueryData(key, { skills: rows });
    // The settle refetch serves whatever the cache last held.
    mocks.agentLibrary.mockImplementation(async () => qc.getQueryData(key));
    qc.getQueryCache().build(qc, {
      queryKey: key,
      queryFn: () => mocks.agentLibrary(),
    });
    const { result } = renderHook(() => useSetLibrarySkillEnabled("ag-1"), {
      wrapper: wrapperFor(qc),
    });
    const rowsNow = () =>
      qc.getQueryData<{ skills: LibrarySkill[] }>(key)?.skills ?? [];
    return { result, rowsNow };
  };

  it("flips the switch before the server answers", async () => {
    const { result, rowsNow } = setup([librarySkill("a"), librarySkill("b")]);
    const patch = deferred<LibrarySkill>();
    mocks.setEnabled.mockReturnValueOnce(patch.promise);

    act(() => result.current.mutate({ name: "a", enabled: false }));
    await waitFor(() => expect(rowsNow()[0]?.enabled).toBe(false));
    expect(rowsNow()[1]?.enabled).toBe(true);
    expect(mocks.setEnabled).toHaveBeenCalledWith("ag-1", "a", false);

    patch.resolve(librarySkill("a", { enabled: false }));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(rowsNow()[0]?.enabled).toBe(false);
  });

  it("a failure puts back only that switch and names it", async () => {
    const { result, rowsNow } = setup([librarySkill("a"), librarySkill("b")]);
    mocks.setEnabled.mockRejectedValueOnce(new ApiError("Not allowed", 403));

    act(() => result.current.mutate({ name: "a", enabled: false }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(rowsNow().map((s) => s.enabled)).toEqual([true, true]);
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Couldn\'t pause "a"',
      expect.objectContaining({ description: "Not allowed" }),
    );
  });

  it("a failed resume says so", async () => {
    const { result, rowsNow } = setup([librarySkill("a", { enabled: false })]);
    mocks.setEnabled.mockRejectedValueOnce(new ApiError("Not allowed", 403));

    act(() => result.current.mutate({ name: "a", enabled: true }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(rowsNow()[0]?.enabled).toBe(false);
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Couldn\'t resume "a"',
      expect.anything(),
    );
  });
});
