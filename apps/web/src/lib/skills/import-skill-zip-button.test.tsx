// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { SkillImportResult } from "@/lib/api";
import { ImportSkillZipButton } from "./import-skill-zip-button";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-skills", () => ({
  useImportSkillZip: () => ({ mutate, isPending: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const RESULT: SkillImportResult = {
  imported: [
    {
      id: "sk-1",
      name: "notes-kit",
      description: "d",
      files: 2,
      bytes: 39,
      groups: { refs: 1 },
      skipped: [{ path: ".DS_Store", reason: "System file" }],
      replaced: false,
    },
  ],
  problems: [{ folder: "BadName", reason: "Not a valid name" }],
};

const upload = async () => {
  render(<ImportSkillZipButton agentId="ag-1" />);
  const input = document.querySelector<HTMLInputElement>("input[type=file]");
  await userEvent.upload(
    input!,
    new File(["zip"], "skills.zip", { type: "application/zip" }),
  );
};

describe("<ImportSkillZipButton />", () => {
  it("says what was added and why something was left out", async () => {
    mutate.mockImplementation((_vars, { onSuccess }) => onSuccess(RESULT));
    await upload();
    expect(toast.success).toHaveBeenCalledWith("Added notes-kit", {
      description: "Left out 2 items, like BadName: Not a valid name",
    });
  });

  it("names the file and the server's reason when the upload fails", async () => {
    mutate.mockImplementation((_vars, { onError }) =>
      onError(new ApiError("This isn't a zip file", 422)),
    );
    await upload();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't import skills.zip",
      expect.objectContaining({ description: "This isn't a zip file" }),
    );
  });

  it("keeps the hidden input out of the tab order", () => {
    render(<ImportSkillZipButton />);
    expect(screen.getByRole("button", { name: "Upload a zip" })).toBeEnabled();
    expect(document.querySelector("input[type=file]")).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });
});
