// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfPage } from "./pdf-page";
import { renderPdfFirstPage, type RenderedPdf } from "./pdf-thumbnail";

vi.mock("./pdf-thumbnail", () => ({ renderPdfFirstPage: vi.fn() }));
afterEach(cleanup);

describe("PDF page lifecycle", () => {
  it("does not display an old page when the Blob changes", async () => {
    const first = new Blob(["first"]);
    const second = new Blob(["second"]);
    const oldPage = { image: "data:image/png;base64,first", pages: 5 };
    const nextPage = { image: "data:image/png;base64,second", pages: 2 };
    let finish: (page: RenderedPdf) => void = () => {};
    vi.mocked(renderPdfFirstPage)
      .mockResolvedValueOnce(oldPage)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const onPages = vi.fn();
    const view = render(
      <PdfPage blob={first} title="first" onPages={onPages} />,
    );
    expect(await screen.findByAltText("first")).toBeTruthy();
    view.rerender(<PdfPage blob={second} title="second" onPages={onPages} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(onPages).toHaveBeenLastCalledWith(0);
    await act(async () => {
      finish(nextPage);
    });
    expect(screen.getByAltText("second").getAttribute("src")).toBe(
      nextPage.image,
    );
    expect(onPages).toHaveBeenLastCalledWith(2);
  });

  it("contains the complete page when used in the dialog", async () => {
    vi.mocked(renderPdfFirstPage).mockResolvedValueOnce({
      image: "data:image/png;base64,page",
      pages: 1,
    });
    render(
      <PdfPage
        blob={new Blob(["landscape"])}
        title="landscape"
        fit="contain"
      />,
    );
    const image = await screen.findByAltText("landscape");
    expect(image.classList.contains("object-contain")).toBe(true);
    expect(image.classList.contains("object-cover")).toBe(false);
  });

  it("ignores a cancelled result after unmount", async () => {
    let finish: (page: RenderedPdf) => void = () => {};
    vi.mocked(renderPdfFirstPage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onPages = vi.fn();
    const view = render(
      <PdfPage blob={new Blob(["page"])} title="page" onPages={onPages} />,
    );
    view.unmount();
    onPages.mockClear();
    await act(async () => {
      finish({ image: "data:image/png;base64,late", pages: 9 });
    });
    expect(onPages).not.toHaveBeenCalled();
  });
});
