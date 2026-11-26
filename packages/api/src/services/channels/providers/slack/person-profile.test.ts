import { beforeEach, describe, expect, it, vi } from "vitest";

const usersInfo = vi.hoisted(() => vi.fn());
vi.mock("@onecli/channels/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@onecli/channels/slack")>()),
  usersInfo,
}));

const { slackReach } = await import("./reach-card");

/** A Direct message row's name and photo: ONE `users.info` read, the
 *  plain name (never "@name"), the photo https only, never a throw. */
describe("slackReach.personProfile", () => {
  const creds = JSON.stringify({ botToken: "xoxb-test" });
  const ask = (credentialsJson: string | null = creds) =>
    slackReach.personProfile({ credentialsJson, externalRef: "U1" });

  beforeEach(() => {
    usersInfo.mockReset();
  });

  it("answers the display name and the 72px photo from one lookup", async () => {
    usersInfo.mockResolvedValue({
      user: {
        id: "U1",
        name: "dana.k",
        profile: {
          display_name: "Dana",
          real_name: "Dana Kim",
          image_48: "https://avatars.slack-edge.com/a_48.png",
          image_72: "https://avatars.slack-edge.com/a_72.png",
        },
      },
    });
    await expect(ask()).resolves.toEqual({
      name: "Dana",
      avatarUrl: "https://avatars.slack-edge.com/a_72.png",
    });
    expect(usersInfo).toHaveBeenCalledTimes(1);
    expect(usersInfo).toHaveBeenCalledWith("xoxb-test", "U1");
  });

  it("falls back to the real name, the handle, and the 48px photo", async () => {
    usersInfo.mockResolvedValue({
      user: {
        id: "U1",
        name: "dana.k",
        profile: {
          real_name: "Dana Kim",
          image_48: "https://avatars.slack-edge.com/a_48.png",
        },
      },
    });
    await expect(ask()).resolves.toEqual({
      name: "Dana Kim",
      avatarUrl: "https://avatars.slack-edge.com/a_48.png",
    });
    usersInfo.mockResolvedValue({ user: { id: "U1", name: "dana.k" } });
    await expect(ask()).resolves.toEqual({ name: "dana.k", avatarUrl: null });
  });

  it("refuses any photo that is not an https URL", async () => {
    for (const image_72 of [
      "javascript:alert(1)",
      "http://example.com/a.png",
      "not a url",
    ]) {
      usersInfo.mockResolvedValue({
        user: { id: "U1", profile: { display_name: "Dana", image_72 } },
      });
      await expect(ask()).resolves.toEqual({ name: "Dana", avatarUrl: null });
    }
  });

  it("answers null with no credential, or when the lookup fails", async () => {
    await expect(ask(null)).resolves.toBeNull();
    expect(usersInfo).not.toHaveBeenCalled();
    usersInfo.mockRejectedValue(new Error("ratelimited"));
    await expect(ask()).resolves.toBeNull();
  });
});
