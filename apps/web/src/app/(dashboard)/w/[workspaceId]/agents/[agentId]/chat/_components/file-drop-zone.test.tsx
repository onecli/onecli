// @vitest-environment jsdom
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileDropZone } from "./file-drop-zone";

const drag = (type: "dragOver" | "drop", target: Element, files: File[]) => {
  const event = createEvent[type](target);
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files },
  });
  fireEvent(target, event);
};

describe("FileDropZone", () => {
  it("stages a nested drop only in the innermost active zone", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <FileDropZone onFiles={outer}>
        <FileDropZone onFiles={inner}>
          <p>nested</p>
        </FileDropZone>
      </FileDropZone>,
    );
    const target = screen.getByText("nested");
    const file = new File(["a"], "a.txt");
    drag("dragOver", target, [file]);
    expect(screen.getAllByText("Drop files here")).toHaveLength(1);
    drag("drop", target, [file]);
    expect(inner).toHaveBeenCalledExactlyOnceWith([file]);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByText("Drop files here")).not.toBeInTheDocument();
  });

  it("shows one overlay when files are dragged anywhere over the pane and stages the drop", () => {
    const onFiles = vi.fn();
    render(
      <FileDropZone onFiles={onFiles}>
        <p>transcript</p>
      </FileDropZone>,
    );
    const transcript = screen.getByText("transcript");
    const file = new File(["abc"], "a.pdf", { type: "application/pdf" });

    drag("dragOver", transcript, [file]);
    expect(screen.getByText("Drop files here")).toBeInTheDocument();

    drag("drop", transcript, [file]);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(screen.queryByText("Drop files here")).not.toBeInTheDocument();
  });

  it("ignores drags when no composer is on screen", () => {
    render(
      <FileDropZone>
        <p>transcript</p>
      </FileDropZone>,
    );
    drag("dragOver", screen.getByText("transcript"), [new File(["a"], "a")]);
    expect(screen.queryByText("Drop files here")).not.toBeInTheDocument();
  });
});
