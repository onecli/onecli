// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openGitHubSettingsPopup } from "./github-settings-popup";

afterEach(() => vi.restoreAllMocks());

describe("openGitHubSettingsPopup", () => {
  it("opens GitHub's installation settings as a centered popup", () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const url =
      "https://github.com/organizations/acme/settings/installations/111";
    expect(openGitHubSettingsPopup(url)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toBe(
      "https://github.com/organizations/acme/settings/installations/111",
    );
    expect(open.mock.calls[0]?.[2]).toContain("width=1024");
  });

  it("falls back to a new tab when the popup is blocked", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openGitHubSettingsPopup("https://github.com/settings/installations/1");
    expect(open).toHaveBeenLastCalledWith(
      "https://github.com/settings/installations/1",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("opens nothing that isn't GitHub", () => {
    const open = vi.spyOn(window, "open");
    for (const url of [
      "https://evil.example/x",
      "javascript:alert(1)",
      "https://github.com.evil.example/x",
      null,
    ]) {
      expect(openGitHubSettingsPopup(url)).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
  });
});
