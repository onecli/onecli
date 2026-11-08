// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { skillCheckCommand } from "@onecli/api/lib/skill-import-rules";
import { SkillFingerprint } from "./skill-fingerprint";

afterEach(cleanup);

const FINGERPRINT = "0123456789ab".padEnd(64, "f");

describe("<SkillFingerprint />", () => {
  it("shows the short fingerprint and copies the check command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<SkillFingerprint fingerprint={FINGERPRINT} />);
    expect(screen.getByText("sha256 0123456789ab")).toHaveAttribute(
      "title",
      `sha256 ${FINGERPRINT}`,
    );
    const button = screen.getByRole("button", { name: "Copy check command" });
    await userEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(skillCheckCommand(FINGERPRINT));
    expect(button).toHaveTextContent("Copied");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Run it in a terminal inside the skill's source folder.",
    );
  });

  it("names the skill when asked, for a list of several", () => {
    render(<SkillFingerprint fingerprint={FINGERPRINT} name="notes-kit" />);
    expect(
      screen.getByRole("button", {
        name: "Copy check command for notes-kit",
      }),
    ).toBeInTheDocument();
  });

  it("renders nothing for anything but a sha256", () => {
    const { container } = render(
      <SkillFingerprint fingerprint="'; rm -rf ~; echo '" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
