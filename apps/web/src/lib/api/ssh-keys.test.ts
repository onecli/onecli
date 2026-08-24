import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two behaviors worth pinning on this thin client: the id is ENCODED into
 * the delete path (a crafted segment must not re-aim it), and the
 * account-route org fallback — /account/* URLs carry no org, cloud session
 * auth requires one, so the default-org cookie must ride as an explicit
 * X-Organization-Id header (and must NOT when the URL already names one).
 */

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();
vi.mock("./client", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiDelete: (...args: unknown[]) => apiDelete(...args),
}));

const getOrganizationId = vi.fn<() => string | null>();
vi.mock("@/lib/api-fetch", () => ({
  getOrganizationId: () => getOrganizationId(),
}));

const readDefaultOrgCookie = vi.fn<() => string | undefined>();
vi.mock("@/lib/navigation", () => ({
  readDefaultOrgCookie: () => readDefaultOrgCookie(),
}));

const { list, remove } = await import("./ssh-keys");

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiDelete.mockReset();
  getOrganizationId.mockReset();
  readDefaultOrgCookie.mockReset();
});

describe("ssh-keys client paths", () => {
  it("encodes the delete id", async () => {
    getOrganizationId.mockReturnValue("org-1");
    apiDelete.mockResolvedValueOnce(undefined);
    await remove("../org/keys");
    expect(apiDelete.mock.calls[0]?.[0]).toBe(
      "/v1/user/ssh-keys/..%2Forg%2Fkeys",
    );
  });
});

describe("the account-route org fallback", () => {
  it("adds the cookie org when the URL names none", async () => {
    getOrganizationId.mockReturnValue(null);
    readDefaultOrgCookie.mockReturnValue("org-cookie");
    apiGet.mockResolvedValueOnce({ sshKeys: [] });
    await list();
    expect(apiGet.mock.calls[0]?.[1]).toEqual({
      headers: { "X-Organization-Id": "org-cookie" },
    });
  });

  it("stays silent when the URL already names an org", async () => {
    getOrganizationId.mockReturnValue("org-1");
    apiGet.mockResolvedValueOnce({ sshKeys: [] });
    await list();
    expect(apiGet.mock.calls[0]?.[1]).toBeUndefined();
    expect(readDefaultOrgCookie).not.toHaveBeenCalled();
  });
});
