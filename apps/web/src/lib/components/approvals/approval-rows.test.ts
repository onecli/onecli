import { describe, expect, it } from "vitest";
import {
  pickRows,
  rowsBesideTitle,
  shareOneRecord,
  subjectRow,
} from "./approval-rows";

const ID = "001fn00000cTWhpAAG";
const subject = {
  verb: "Upload file",
  lead: "Upload file to ",
  record: "Account Acme",
  row: 1,
};

describe("rowsBesideTitle", () => {
  const details = [
    { label: "File", value: "DR Procedure.pdf" },
    { label: "Attach to", value: `Account · ${ID}` },
    // An agent-written field that merely mentions the id stays.
    { label: "Description", value: `For ${ID}` },
  ];

  it("drops only the row the title names, by index", () => {
    expect(
      rowsBesideTitle({ action: "x", details, subject }).map((d) => d.label),
    ).toEqual(["File", "Description"]);
  });

  it("keeps every row without a subject, and none without a summary", () => {
    expect(rowsBesideTitle({ action: "x", details })).toHaveLength(3);
    expect(rowsBesideTitle(undefined)).toEqual([]);
  });

  it("subjectRow is exactly the row the title names", () => {
    expect(subjectRow({ action: "x", details, subject })?.label).toBe(
      "Attach to",
    );
    expect(subjectRow({ action: "x", details })).toBeUndefined();
  });
});

describe("shareOneRecord", () => {
  const upload = (recordRow: string) => ({
    summary: {
      action: "Upload file to Account Acme",
      subject,
      details: [
        { label: "File", value: "a.pdf" },
        { label: "Attach to", value: recordRow },
      ],
    },
  });

  it("is the same record only when the record's own row matches", () => {
    expect(
      shareOneRecord([upload(`Acme (${ID})`), upload(`Acme (${ID})`)]),
    ).toBe(true);
    // Same title, same name, a different record: never one record.
    expect(
      shareOneRecord([
        upload(`Acme (${ID})`),
        upload("Acme (001fn00000OTHERAAA)"),
      ]),
    ).toBe(false);
  });

  it("needs a subject on every request", () => {
    const bare = { summary: { action: "Create Contact", details: [] } };
    expect(shareOneRecord([bare])).toBe(false);
    expect(shareOneRecord([upload(`Acme (${ID})`), bare])).toBe(false);
    expect(shareOneRecord([])).toBe(false);
  });
});

describe("pickRows", () => {
  it("picks by label case-insensitively, first wins, and passes the rest", () => {
    const { get, rest } = pickRows(
      [
        { label: "to", value: "a@b.co" },
        { label: "To", value: "second@b.co" },
        { label: "Note", value: "kept" },
      ],
      ["To"],
    );
    expect(get("TO")?.value).toBe("a@b.co");
    expect(rest.map((d) => d.value)).toEqual(["second@b.co", "kept"]);
  });
});
