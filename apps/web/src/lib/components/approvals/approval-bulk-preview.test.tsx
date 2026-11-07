// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  ApprovalBulkChange,
  ApprovalBulkRow,
  ApprovalCellOp,
} from "@/lib/api/approvals";
import { ApprovalPreview } from "./approval-preview";

const row = (
  i: number,
  old: string,
  next: string,
  op: ApprovalCellOp,
): ApprovalBulkRow => ({
  id: `003AA00000AbCd${String(i).padStart(4, "0")}`,
  name: `Contact ${i}`,
  url: `https://acme.my.salesforce.com/003AA00000AbCd${String(i).padStart(4, "0")}`,
  new: [next],
  old: [old],
  ops: [op],
  op,
});

/** What the gateway sends for a 46-record bulk update, riskiest first. */
const bulk: ApprovalBulkChange = {
  object: "Contact",
  objectLabel: "Contact",
  fields: [{ api: "MailingCountry", label: "Mailing country" }],
  rows: [
    row(1, "Israel", "", "clear"),
    row(2, "Canada", "Germany", "overwrite"),
    row(3, "Canada", "Germany", "overwrite"),
    ...Array.from({ length: 40 }, (_, i) => row(i + 4, "", "Canada", "fill")),
    row(44, "Canada", "Canada", "same"),
    row(45, "Canada", "Canada", "same"),
    row(46, "Canada", "Canada", "same"),
  ],
  oldValuesRead: true,
};

const renderBulk = (b = bulk) =>
  render(<ApprovalPreview kind={undefined} details={[]} bulk={b} />);

describe("ApprovalPreview: a bulk change", () => {
  it("shows who each record is (account, title) after its name, plain and uncounted", () => {
    // MUTATION-TESTED: without the context columns the table names the
    // record only, and a reviewer can't tell which Dana is being changed.
    const two = bulk.rows.slice(0, 2);
    renderBulk({
      ...bulk,
      rows: [
        { ...two[0]!, context: ["Acme", "CFO"] },
        { ...two[1]!, context: [null, "VP"] },
      ],
      context: [
        { api: "Account.Name", label: "Account" },
        { api: "Title", label: "Title" },
      ],
    });
    expect(
      screen.getAllByRole("columnheader").map((th) => th.textContent),
    ).toEqual(["#", "Contact", "Account", "Title", "Mailing country"]);
    const [, first, second] = screen.getAllByRole("row");
    expect(
      within(first!)
        .getAllByRole("cell")
        .map((td) => td.textContent),
    ).toEqual([
      "1",
      "Contact 1(opens in a new tab)",
      "Acme",
      "CFO",
      "Clears: Israel → cleared",
    ]);
    expect(within(second!).getAllByRole("cell")[2]!.textContent).toBe("");
    // Context never counts as a change.
    const legend = screen.getByRole("list", { name: "Changes by kind" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Clears 1", "Updates 1"]);
  });
  it("counts each kind of change, red, blue, green, gray", () => {
    renderBulk();
    const legend = screen.getByRole("list", { name: "Changes by kind" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Clears 1", "Updates 2", "Fills 40", "No change 3"]);
  });

  it("colors every cell by what will happen to it, riskiest rows first", () => {
    const { container } = renderBulk();
    const ops = [...container.querySelectorAll("td[data-op]")].map((td) =>
      td.getAttribute("data-op"),
    );
    // Riskiest first: red, then blue, then green, gray last.
    expect(ops.slice(0, 5)).toEqual([
      "clear",
      "overwrite",
      "overwrite",
      "fill",
      "fill",
    ]);
    const clear = container.querySelector('td[data-op="clear"]')!;
    // Color is never the only cue: the cell says it in words too.
    expect(clear).toHaveTextContent("Clears:");
    expect(clear).toHaveTextContent("Israel");
  });

  it("holds every record in one scrollable box that expands taller", () => {
    const { container } = renderBulk();
    const box = screen.getByRole("region", { name: "46 contacts: changes" });
    expect(within(box).getAllByRole("row").slice(1)).toHaveLength(46);
    const expand = screen.getByRole("button", { name: "Expand (46 rows)" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(expand).toHaveAttribute("aria-controls", box.id);
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const last = [...container.querySelectorAll("td[data-op]")].at(-1)!;
    expect(last.getAttribute("data-op")).toBe("same");
  });

  it("links record names only to https record pages", () => {
    renderBulk();
    const first = screen.getAllByRole("row")[1]!;
    expect(within(first).getByRole("link")).toHaveAttribute(
      "href",
      "https://acme.my.salesforce.com/003AA00000AbCd0001",
    );
  });

  it("never colors or claims old values it could not read", () => {
    const { container } = renderBulk({ ...bulk, oldValuesRead: false });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Current values couldn't be read",
    );
    expect(screen.queryByRole("list", { name: "Changes by kind" })).toBeNull();
    // No value cell is colored (the pinned # and name columns are opaque
    // so values can scroll under them, which is not a color claim).
    expect(
      container.querySelector("td[class*='bg-']:not([class*='sticky'])"),
    ).toBeNull();
  });

  it("keeps # and the record's name pinned while a wide table scrolls sideways", () => {
    const wide: ApprovalBulkChange = {
      ...bulk,
      fields: Array.from({ length: 8 }, (_, i) => ({
        api: `F${i}`,
        label: `Field ${i}`,
      })),
      rows: bulk.rows.slice(0, 2).map((r) => ({
        ...r,
        new: Array(8).fill("x"),
        old: Array(8).fill(""),
        ops: Array(8).fill("fill"),
      })),
    };
    renderBulk(wide);
    const [head, first] = screen.getAllByRole("row");
    const [hashH, nameH, fieldH] = within(head!).getAllByRole("columnheader");
    const [hash, name, value] = within(first!).getAllByRole("cell");
    // Pinned, opaque, the name column offset by exactly the # column's
    // pinned width (min = max, so a table can't widen it into the name).
    const width = /\bmin-w-(\d+) max-w-\1\b/.exec(hash!.className)?.[1];
    expect(width).toBeDefined();
    for (const c of [hashH!, hash!])
      expect(c.className).toMatch(/sticky left-0/);
    for (const c of [nameH!, name!])
      expect(c.className).toMatch(new RegExp(`sticky left-${width}\\b`));
    expect(name!.className).toMatch(/bg-background/);
    // The header corner stays above both sticky axes.
    expect(nameH!.className).toMatch(/z-20/);
    // Value columns scroll.
    expect(fieldH!.className).not.toMatch(/sticky/);
    expect(value!.className).not.toMatch(/sticky/);
  });
});

describe("ApprovalPreview: a bulk delete or create", () => {
  it("marks only each record's name: red for a delete, values plain", () => {
    const { container } = render(
      <ApprovalPreview
        kind={undefined}
        details={[]}
        bulk={{
          kind: "delete",
          object: "Contact",
          objectLabel: "Contact",
          fields: [{ api: "Title", label: "Title" }],
          rows: [
            {
              id: "003AA00000AbCd0001",
              name: "Contact 1",
              new: [],
              old: ["CTO"],
              op: "clear",
            },
            {
              id: "003AA00000AbCd0002",
              name: "Contact 2",
              new: [],
              old: [null],
              op: "clear",
            },
          ],
          oldValuesRead: true,
        }}
      />,
    );
    expect(screen.getByText(/2 contacts will be deleted/)).toBeInTheDocument();
    const marked = [...container.querySelectorAll("td[data-op]")];
    expect(marked).toHaveLength(2);
    expect(marked[0]).toHaveTextContent("Contact 1");
    expect(screen.getByText("CTO").closest("td")).not.toHaveAttribute(
      "data-op",
    );
  });

  it("says why a delete's columns are empty when its records couldn't be read", () => {
    render(
      <ApprovalPreview
        kind={undefined}
        details={[]}
        bulk={{
          kind: "delete",
          object: "Contact",
          objectLabel: "Contact",
          fields: [{ api: "Title", label: "Title" }],
          rows: [
            { id: "003AA00000AbCd0001", new: [], op: "clear" },
            { id: "003AA00000AbCd0002", new: [], op: "clear" },
          ],
          oldValuesRead: false,
        }}
      />,
    );
    // Still says what goes, and why there is nothing in the columns.
    expect(
      screen.getByRole("list", { name: "Changes by kind" }),
    ).toHaveTextContent("Deletes 2");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Their current values couldn't be read",
    );
  });
});

describe("ApprovalPreview: one record", () => {
  const one = (over: Partial<ApprovalBulkChange>): ApprovalBulkChange => ({
    kind: "update",
    object: "Contact",
    objectLabel: "Contact",
    fields: [
      { api: "Title", label: "Title" },
      { api: "Fax", label: "Fax" },
    ],
    rows: [
      {
        id: "003AA00000AbCd0001",
        name: "Marcus Delgado",
        url: "https://acme.my.salesforce.com/003AA00000AbCd0001",
        new: ["VP of Procurement", "(617) 555-0100"],
        old: ["Director of Procurement", null],
        ops: ["overwrite", "fill"],
        op: "overwrite",
      },
    ],
    oldValuesRead: true,
    ...over,
  });

  it("shows each field it sets as now and new, colored, without a table box", () => {
    const { container } = render(
      <ApprovalPreview kind={undefined} details={[]} bulk={one({})} />,
    );
    expect(screen.queryByRole("region")).toBeNull();
    expect(
      screen.getByRole("link", { name: /Marcus Delgado/ }),
    ).toBeInTheDocument();
    const title = container.querySelector('[data-op="overwrite"]')!;
    expect(title).toHaveTextContent("Director of Procurement");
    expect(title).toHaveTextContent("VP of Procurement");
    expect(container.querySelector('[data-op="fill"]')).not.toBeNull();
  });

  it("marks a new record green and a deleted one red, on the record only", () => {
    const { container, unmount } = render(
      <ApprovalPreview
        kind={undefined}
        details={[]}
        bulk={one({ kind: "create", oldValuesRead: false })}
      />,
    );
    const marked = container.querySelectorAll("[data-op]");
    expect(marked).toHaveLength(1);
    expect(screen.getByText("VP of Procurement")).toBeInTheDocument();
    unmount();
    const del = render(
      <ApprovalPreview
        kind={undefined}
        details={[]}
        bulk={one({ kind: "delete" })}
      />,
    );
    const red = del.container.querySelectorAll("[data-op]");
    expect(red).toHaveLength(1);
    expect(screen.getByText(/Deletes contact/)).toBeInTheDocument();
    expect(screen.getByText("Director of Procurement")).toBeInTheDocument();
  });

  it("keeps two fields with the same label apart (keyed by API name)", () => {
    // Two managed packages can both label a field "Region".
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      render(
        <ApprovalPreview
          kind={undefined}
          details={[]}
          bulk={one({
            fields: [
              { api: "pkgA__Region__c", label: "Region" },
              { api: "pkgB__Region__c", label: "Region" },
            ],
            rows: [
              {
                id: "003AA00000AbCd0001",
                new: ["EMEA", "North"],
                old: [null, null],
                ops: ["fill", "fill"],
                op: "fill",
              },
            ],
          })}
        />,
      );
    } finally {
      console.error = original;
    }
    expect(screen.getByText("EMEA")).toBeInTheDocument();
    expect(screen.getByText("North")).toBeInTheDocument();
    expect(JSON.stringify(errors)).not.toMatch(/same key/);
  });
});

describe("ApprovalPreview: plurals", () => {
  it("counts records in English", () => {
    renderBulk({
      ...bulk,
      object: "Opportunity",
      objectLabel: "Opportunity",
      rows: bulk.rows.slice(0, 2),
    });
    expect(screen.getByText(/2 opportunities/)).toBeInTheDocument();
  });
});
