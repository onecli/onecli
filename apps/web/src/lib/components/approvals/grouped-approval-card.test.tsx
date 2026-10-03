// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { groupApprovals } from "@onecli/api/lib/approval-groups";
import type { PendingApproval } from "@/lib/api/approvals";

const state = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
vi.mock("@/hooks/use-approvals", () => ({
  useDecideApprovals: () => ({
    mutate: state.mutate,
    isPending: state.isPending,
  }),
}));
vi.mock("./approval-details-dialog", () => ({
  ApprovalDetailsDialog: () => null,
}));

const { GroupedApprovalCard } = await import("./grouped-approval-card");

let n = 0;
const contact = (
  first: string,
  over: Partial<PendingApproval> = {},
): PendingApproval => {
  n += 1;
  return {
    id: `ap-${n}`,
    method: "POST",
    url: "https://acme.my.salesforce.com/services/data/v60.0/sobjects/Contact",
    host: "acme.my.salesforce.com",
    path: "/services/data/v60.0/sobjects/Contact",
    headers: {},
    app: "salesforce",
    agent: { id: "ofer", name: "Ofer" },
    batch: { id: "t1", label: "Add contacts", total: 10 },
    summary: {
      action: "Create Contact",
      details: [
        { label: "First name", value: first },
        { label: "Last name", value: "Test" },
        { label: "Email", value: `${first.toLowerCase()}@example.com` },
      ],
    },
    createdAt: new Date(Date.now() + n).toISOString(),
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
    ...over,
  };
};

/** A per-record title ("Delete Contact Olivia"): the record is the subject,
 *  named from its own row, which carries the id. */
const del = (name: string, id: string): PendingApproval => {
  const url = `https://acme.my.salesforce.com/${id}`;
  return contact(name, {
    batch: undefined,
    summary: {
      action: `Delete Contact ${name}`,
      subject: {
        verb: "Delete Contact",
        lead: "Delete Contact ",
        record: name,
        row: 0,
        url,
      },
      details: [{ label: "Contact", value: `${name} (${id})`, url }],
    },
  });
};

const card = (approvals: PendingApproval[], props = {}) => {
  const [group] = groupApprovals(approvals);
  return render(<GroupedApprovalCard group={group!} {...props} />);
};

beforeEach(() => {
  state.mutate.mockReset();
  state.isPending = false;
});

describe("GroupedApprovalCard", () => {
  it("titles the card by what the requests do; the agent's label is its claim", () => {
    card([contact("Ada"), contact("Ben"), contact("Cara")]);
    expect(screen.getByText("Create Contact")).toBeInTheDocument();
    expect(screen.getByText(/3 waiting/)).toBeInTheDocument();
    expect(
      screen.getByText(/The agent says: “Add contacts” · 10 requests in total/),
    ).toBeInTheDocument();
    expect(screen.getByText("Ada Test")).toBeInTheDocument();
  });

  it("Approve all decides exactly the requests on the card", () => {
    const rows = [contact("Ada"), contact("Ben")];
    card(rows);
    fireEvent.click(screen.getByText("Approve all 2"));
    expect(state.mutate).toHaveBeenCalledWith({
      ids: rows.map((r) => r.id),
      decision: "approve",
    });
  });

  it("a row decides only itself, and its buttons name it", () => {
    const rows = [contact("Ada"), contact("Ben")];
    card(rows);
    fireEvent.click(screen.getByRole("button", { name: "Deny Ben Test" }));
    expect(state.mutate).toHaveBeenCalledWith(
      { ids: [rows[1]!.id], decision: "deny" },
      expect.anything(),
    );
  });

  it("a decided row stays on the card, disabled, showing only the choice made", () => {
    const rows = [contact("Ada"), contact("Ben"), contact("Cy")];
    card(rows);
    fireEvent.click(screen.getByRole("button", { name: "Approve Ada Test" }));

    expect(screen.getByText("Ada Test")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Approved");
    expect(
      screen.queryByRole("button", { name: "Approve Ada Test" }),
    ).toBeNull();
    // Approve all now covers only the two still undecided.
    fireEvent.click(screen.getByText("Approve all 2"));
    expect(state.mutate).toHaveBeenLastCalledWith({
      ids: [rows[1]!.id, rows[2]!.id],
      decision: "approve",
    });
  });

  it("a row whose decision didn't go through is live again", () => {
    const rows = [contact("Ada"), contact("Ben")];
    state.mutate.mockImplementation((_vars, opts) =>
      opts?.onSuccess?.({ failed: [rows[0]!.id], stale: 0 }),
    );
    card(rows);
    fireEvent.click(screen.getByRole("button", { name: "Approve Ada Test" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Approve Ada Test" }),
    ).toBeInTheDocument();
  });

  it("keeps rows the thread already settled, each with its outcome", () => {
    const [ada, ben] = [contact("Ada"), contact("Ben")];
    const [group] = groupApprovals([ben!]);
    render(
      <GroupedApprovalCard
        group={group!}
        settled={[{ approval: ada!, outcome: "denied" }]}
      />,
    );
    expect(screen.getByText("Ada Test")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Denied");
    expect(screen.getByText("Approve all 1")).toBeInTheDocument();
  });

  it("pins and flags an odd action so it can't hide in the batch", () => {
    const odd = contact("Old", {
      summary: {
        action: "Delete Contact",
        details: [{ label: "Contact", value: "Old Lead" }],
      },
    });
    card([contact("Ada"), contact("Ben"), odd]);
    expect(
      screen.getByText(/Also in this batch: 1 Delete Contact/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain(
      "Delete Contact",
    );
  });

  it("Enter approves all and Esc denies all, only from the card itself", () => {
    const rows = [contact("Ada"), contact("Ben")];
    card(rows);
    const group = screen.getByRole("group");
    fireEvent.keyDown(group, { key: "Enter" });
    expect(state.mutate).toHaveBeenLastCalledWith({
      ids: rows.map((r) => r.id),
      decision: "approve",
    });
    fireEvent.keyDown(group, { key: "Escape" });
    expect(state.mutate).toHaveBeenLastCalledWith({
      ids: rows.map((r) => r.id),
      decision: "deny",
    });
    // A focused button keeps its own Enter.
    state.mutate.mockReset();
    fireEvent.keyDown(screen.getByText("Deny all"), { key: "Enter" });
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("Enter on a record link opens the record, never approves the batch", () => {
    // MUTATION-TESTED: the old guard skipped only <button>s, so Enter on a
    // row's record link bubbled up and approved every row on the card.
    card([
      del("Olivia Martinez", "003fn00000Fc1s0AAB"),
      del("Sarah Davis", "003fn00000Fc1s1AAB"),
    ]);
    fireEvent.keyDown(screen.getByRole("link", { name: /Olivia Martinez/ }), {
      key: "Enter",
    });
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("the bell's card takes no keyboard shortcuts (Esc closes the popover)", () => {
    card([contact("Ada"), contact("Ben")], { compact: true });
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("collapses long batches behind Show all", () => {
    card(Array.from({ length: 7 }, (_, i) => contact(`P${i}`)));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByText("Show all 7"));
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  it("never approves rows the reviewer hasn't seen: the first click reveals them", () => {
    // MUTATION-TESTED: approve straight from the collapsed card and two
    // requests nobody looked at get approved.
    const rows = Array.from({ length: 7 }, (_, i) => contact(`Q${i}`));
    card(rows);
    fireEvent.click(screen.getByText("Review all 7"));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    fireEvent.click(screen.getByText("Approve all 7"));
    expect(state.mutate).toHaveBeenCalledWith({
      ids: rows.map((r) => r.id),
      decision: "approve",
    });
  });

  it("the bell's compact form previews names and lists no rows", () => {
    card([contact("Ada"), contact("Ben"), contact("Cara")], {
      compact: true,
      showAgent: true,
    });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText(/Ada Test · Ben Test/)).toBeInTheDocument();
    expect(screen.getByText(/\+1 more/)).toBeInTheDocument();
    expect(screen.getByText(/Ofer ·/)).toBeInTheDocument();
    // A glance: no keyboard hints, one "Review" button, the countdown in
    // the meta line.
    expect(screen.queryByText(/esc deny/)).toBeNull();
    expect(screen.queryByText(/Undecided means denied/)).toBeNull();
    expect(screen.getAllByRole("button", { name: /Review/ })).toHaveLength(1);
    expect(screen.getByText(/3 waiting/).textContent).toMatch(/expires in/);
  });

  it("disables every decision while one is in flight", () => {
    state.isPending = true;
    card([contact("Ada"), contact("Ben")]);
    expect(
      screen.getByRole("button", { name: /Approve all 2/ }),
    ).toBeDisabled();
  });
});

describe("GroupedApprovalCard: a record per row", () => {
  it("deletes of different contacts are one card: the verb as title, each row its own linked record", () => {
    const names = ["Olivia Martinez", "Sarah Davis", "David Brown"];
    const rows = names.map((name, i) => del(name, `003fn00000Fc1s${i}AAB`));
    card(rows);
    expect(screen.getByText("Delete Contact")).toBeInTheDocument();
    for (const [i, name] of names.entries()) {
      expect(
        screen.getByRole("link", { name: new RegExp(name) }),
      ).toHaveAttribute(
        "href",
        `https://acme.my.salesforce.com/003fn00000Fc1s${i}AAB`,
      );
    }
    // The record is named once per row, by name, never echoed by its row.
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).not.toContain("003fn00000Fc1s0AAB");
  });

  it("two records with the same name show their ids, so no two rows look alike", () => {
    card([
      del("DR Procedure", "069fn000005etkTAAQ"),
      del("DR Procedure", "069fn000005fO57AAE"),
    ]);
    expect(
      screen.getByRole("link", { name: /DR Procedure \(069fn000005etkTAAQ\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /DR Procedure \(069fn000005fO57AAE\)/ }),
    ).toBeInTheDocument();
  });
});

describe("GroupedApprovalCard: a shared record", () => {
  const acct = "001fn00000cTWhpAAG";
  const url = `https://acme.my.salesforce.com/${acct}`;
  const upload = (file: string) =>
    contact(file, {
      batch: undefined,
      summary: {
        action: "Upload file to Account Acme",
        subject: {
          verb: "Upload file",
          lead: "Upload file to ",
          record: "Account Acme",
          row: 1,
          url,
        },
        details: [
          { label: "File", value: `${file}.pdf` },
          { label: "Attach to", value: `Acme (${acct})`, url },
          { label: "Size", value: "522 B" },
        ],
      },
    });

  it("names the shared record once, linked, and keeps each row to what differs", () => {
    card([upload("DR Procedure"), upload("Security Policy")]);
    expect(screen.getByRole("link", { name: /Account Acme/ })).toHaveAttribute(
      "href",
      url,
    );
    for (const row of screen.getAllByRole("listitem")) {
      expect(row.textContent).not.toContain(acct);
      expect(row.textContent).toContain("522 B");
    }
  });

  it("two records that merely share a name are never one shared record", () => {
    const other = upload("Vendor List");
    other.summary!.details[1] = {
      label: "Attach to",
      value: "Acme (001fn00000OTHERAAA)",
    };
    card([upload("DR Procedure"), other]);
    // Not merged into the title: each row names its own record, with its id.
    expect(screen.getByText("Upload file")).toBeInTheDocument();
    expect(screen.getAllByText(/Acme \(001fn/)).toHaveLength(2);
  });
});
