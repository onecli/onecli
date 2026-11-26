// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeeperSecurityPickerDialog } from "./keepersecurity-picker-dialog";

// The picker's contract: drill Record → Field and hand back the reference the
// server computed plus readable labels. The gateway queries are stubbed; what
// they fetch is covered by use-keepersecurity and the API service tests.
const data = vi.hoisted(() => ({
  records: {
    data: undefined as unknown,
    isLoading: false,
    error: null as unknown,
  },
  fields: {
    data: undefined as unknown,
    isLoading: false,
    error: null as unknown,
  },
  fieldsFor: [] as (string | null)[],
}));

vi.mock("@/hooks/use-keepersecurity", () => ({
  useKeeperSecurityRecords: () => data.records,
  useKeeperSecurityFields: (uid: string | null) => {
    data.fieldsFor.push(uid);
    return uid
      ? data.fields
      : { data: undefined, isLoading: false, error: null };
  },
}));

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const RECORDS = [
  { uid: "rec-gh", title: "GitHub", type: "login", folder: "Shared / Dev" },
  { uid: "rec-st", title: "Stripe", type: "login" },
];
const FIELDS = [
  {
    ref: "keeper://rec-gh/field/password",
    label: "Password",
    fieldType: "password",
  },
  {
    ref: "keeper://rec-gh/custom_field/API Key",
    label: "API Key",
    fieldType: "secret",
  },
];

const renderPicker = () => {
  const onSelect = vi.fn();
  const onEnterManually = vi.fn();
  render(
    <KeeperSecurityPickerDialog
      open
      onOpenChange={() => {}}
      onSelect={onSelect}
      onEnterManually={onEnterManually}
    />,
  );
  return { onSelect, onEnterManually };
};

const row = (name: RegExp | string) => screen.getByRole("button", { name });

beforeEach(() => {
  data.records = { data: RECORDS, isLoading: false, error: null };
  data.fields = { data: FIELDS, isLoading: false, error: null };
  data.fieldsFor = [];
});
afterEach(() => vi.clearAllMocks());

describe("KeeperSecurityPickerDialog", () => {
  it("lists records with their folder path", () => {
    renderPicker();
    expect(row(/GitHub/)).toHaveTextContent("Shared / Dev");
    expect(row(/Stripe/)).toBeInTheDocument();
  });

  it("does not load fields until a record is picked", () => {
    renderPicker();
    expect(data.fieldsFor.every((uid) => uid === null)).toBe(true);
  });

  it("searches records by folder as well as title", async () => {
    renderPicker();
    await userEvent.type(screen.getByPlaceholderText("Search records"), "dev");
    expect(row(/GitHub/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Stripe/ }),
    ).not.toBeInTheDocument();
  });

  it("returns the server's reference and readable labels for a picked field", async () => {
    const { onSelect } = renderPicker();
    await userEvent.click(row(/GitHub/));
    expect(data.fieldsFor).toContain("rec-gh");
    await userEvent.click(row(/API Key/));
    expect(onSelect).toHaveBeenCalledWith({
      ref: "keeper://rec-gh/custom_field/API Key",
      display: { record: "GitHub", field: "API Key", folder: "Shared / Dev" },
    });
  });

  it("omits the folder label for a record shared without one", async () => {
    const { onSelect } = renderPicker();
    await userEvent.click(row(/Stripe/));
    await userEvent.click(row(/Password/));
    expect(onSelect.mock.calls[0]?.[0].display).toEqual({
      record: "Stripe",
      field: "Password",
    });
  });

  it("jumps back to the record list from the path", async () => {
    renderPicker();
    await userEvent.click(row(/GitHub/));
    expect(screen.getByPlaceholderText("Search fields")).toBeInTheDocument();
    // The filled `record` segment of keeper://record/field.
    await userEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(screen.getByPlaceholderText("Search records")).toBeInTheDocument();
  });

  it("offers typing a reference by hand", async () => {
    const { onEnterManually } = renderPicker();
    await userEvent.click(row("Enter a reference manually"));
    expect(onEnterManually).toHaveBeenCalledOnce();
  });

  it("explains an empty application", () => {
    data.records = { data: [], isLoading: false, error: null };
    renderPicker();
    expect(
      screen.getByText(/No records are shared with this Secrets Manager/),
    ).toBeInTheDocument();
  });

  it("surfaces the gateway's error", () => {
    data.records = {
      data: undefined,
      isLoading: false,
      error: new Error("keepersecurity is not connected"),
    };
    renderPicker();
    expect(
      screen.getByText("keepersecurity is not connected"),
    ).toBeInTheDocument();
  });
});
