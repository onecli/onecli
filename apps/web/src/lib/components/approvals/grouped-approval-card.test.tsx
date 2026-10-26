// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_SETTLE_MS,
  groupApprovals,
} from "@onecli/api/lib/approval-groups";
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
// A spy on the shared merge, to prove the card doesn't rebuild the table on
// every countdown tick. The real rule runs.
vi.mock("@onecli/api/lib/batch-table", async (load) => {
  const real = await load<typeof import("@onecli/api/lib/batch-table")>();
  return { ...real, mergeBatchTables: vi.fn(real.mergeBatchTables) };
});

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
    batch: { id: "t1", label: "Add contacts" },
    summary: {
      action: "Create Contact",
      details: [
        { label: "First name", value: first },
        { label: "Last name", value: "Test" },
        { label: "Email", value: `${first.toLowerCase()}@example.com` },
      ],
    },
    // Arrived a minute ago: a batch that has settled, so its tagged total
    // never holds Approve all unless a test says so.
    createdAt: new Date(Date.now() - 60_000 + n).toISOString(),
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
    const batch = { id: "t1", label: "Add contacts", total: 3 };
    card([
      contact("Ada", { batch }),
      contact("Ben", { batch }),
      contact("Cara", { batch }),
    ]);
    expect(screen.getByText("Create Contact")).toBeInTheDocument();
    expect(screen.getByText(/3 waiting/)).toBeInTheDocument();
    expect(
      screen.getByText(/The agent says: “Add contacts” · 3 requests in total/),
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

  it("a settled row whose approved request did nothing says so on its badge, the reason readable without a hover", () => {
    const [ada, ben] = [contact("Ada"), contact("Ben")];
    const [group] = groupApprovals([ben!]);
    render(
      <GroupedApprovalCard
        group={group!}
        settled={[
          {
            approval: ada!,
            outcome: "approved",
            via: "slack",
            result: {
              ok: false,
              error: "Email: invalid email address",
              action: "Create Contact",
            },
          },
        ]}
      />,
    );
    const badge = screen.getByRole("status");
    // The count fits the badge; the whole line is its tooltip AND what a
    // screen reader hears, so keyboard and touch users get the reason too.
    expect(badge).toHaveTextContent("Approved in Slack · It failed");
    expect(badge).toHaveAttribute(
      "title",
      "It failed · Email: invalid email address",
    );
    expect(badge.querySelector(".sr-only")?.textContent?.trim()).toBe(
      "· It failed · Email: invalid email address",
    );
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

  it("holds Approve all while a tagged batch is still arriving", () => {
    // MUTATION-TESTED: without the hold, "Approve all 12" approves part of
    // a 20-record task the reviewer believes is the whole of it.
    const now = new Date().toISOString();
    const batch = { id: "t3", label: "Set Title", total: 20 };
    const rows = Array.from({ length: 12 }, (_, i) =>
      contact(`W${i}`, { batch, createdAt: now }),
    );
    card(rows);
    expect(
      screen.getByText("12 of 20 here, waiting for the rest…"),
    ).toHaveAttribute("role", "status");
    const approve = screen.getByRole("button", { name: /Waiting for 8 more/ });
    expect(approve).toBeDisabled();
    // Enter from the card can't get around it either.
    fireEvent.keyDown(screen.getByRole("group"), { key: "Enter" });
    expect(state.mutate).not.toHaveBeenCalled();
    // Denying is the safe direction: still one click.
    fireEvent.click(screen.getByRole("button", { name: /Deny all/ }));
    expect(state.mutate).toHaveBeenCalledWith({
      ids: rows.map((r) => r.id),
      decision: "deny",
    });
  });

  it("offers Approve all once the whole batch arrived", () => {
    const now = new Date().toISOString();
    const batch = { id: "t4", label: "Set Title", total: 3 };
    card(["A", "B", "C"].map((f) => contact(f, { batch, createdAt: now })));
    expect(screen.queryByText(/waiting for the rest|never arrived/)).toBeNull();
    expect(screen.getByRole("button", { name: "Approve all 3" })).toBeEnabled();
  });

  it("lifts the hold by itself once the batch goes quiet", () => {
    vi.useFakeTimers();
    try {
      const now = new Date().toISOString();
      const batch = { id: "t6", label: "Set Title", total: 20 };
      card(
        Array.from({ length: 19 }, (_, i) =>
          contact(`L${i}`, { batch, createdAt: now }),
        ),
      );
      expect(
        screen.getByRole("button", { name: /Waiting for 1 more/ }),
      ).toBeDisabled();
      act(() => {
        vi.advanceTimersByTime(BATCH_SETTLE_MS + 1_000);
      });
      expect(
        screen.getByRole("button", { name: "Approve all 19" }),
      ).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when the batch goes quiet, and says the rest may follow", () => {
    const batch = { id: "t5", label: "Set Title", total: 20 };
    const rows = Array.from({ length: 19 }, (_, i) =>
      contact(`M${i}`, { batch }),
    );
    card(rows);
    expect(
      screen.getByText(
        "19 of 20 here. The other one may only be sent after you decide these. Approve all covers the 19 shown.",
      ),
    ).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("button", { name: "Approve all 19" }));
    expect(state.mutate).toHaveBeenCalledWith({
      ids: rows.map((r) => r.id),
      decision: "approve",
    });
  });

  it("shows a batch of up to 25 whole, so Approve all is one click", () => {
    // MUTATION-TESTED: collapse to 5 again and the first click only
    // reveals the rows (Review all), the old two-click card.
    const rows = Array.from({ length: 20 }, (_, i) => contact(`R${i}`));
    card(rows);
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.queryByText(/Show all/)).toBeNull();
    fireEvent.click(screen.getByText("Approve all 20"));
    expect(state.mutate).toHaveBeenCalledWith({
      ids: rows.map((r) => r.id),
      decision: "approve",
    });
  });

  it("collapses a batch longer than 25 behind Show all", () => {
    card(Array.from({ length: 27 }, (_, i) => contact(`P${i}`)));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByText("Show all 27"));
    expect(screen.getAllByRole("listitem")).toHaveLength(27);
  });

  it("never approves rows the reviewer hasn't seen: the first click reveals them", () => {
    // MUTATION-TESTED: approve straight from the collapsed card and the
    // requests nobody looked at get approved.
    const rows = Array.from({ length: 27 }, (_, i) => contact(`Q${i}`));
    card(rows);
    fireEvent.click(screen.getByText("Review all 27"));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getAllByRole("listitem")).toHaveLength(27);
    fireEvent.click(screen.getByText("Approve all 27"));
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
  /** "Update Contact <name>" setting a Title: the shape a Salesforce
   *  update card has (the record's row, then the changed field). */
  const update = (name: string, id: string): PendingApproval => {
    const url = `https://acme.my.salesforce.com/${id}`;
    return contact(name, {
      method: "PATCH",
      batch: { id: "t2", label: "Set Title", total: 3 },
      summary: {
        action: `Update Contact ${name}`,
        subject: {
          verb: "Update Contact",
          lead: "Update Contact ",
          record: name,
          row: 0,
          url,
        },
        details: [
          { label: "Contact", value: `${name} (${id})`, url },
          { label: "Title", value: "After" },
        ],
      },
    });
  };

  it("an update row names the field it changes, not a bare value", () => {
    // MUTATION-TESTED: drop the label and the row reads "Batch Test04 ·
    // After", which looks like a second name and hides what changes.
    card([
      update("Batch Test04", "003QO00000Upd0pxAA"),
      update("Batch Test05", "003QO00000Upd0oLAA"),
    ]);
    fireEvent.click(screen.getByText("Show each request (2)"));
    for (const row of screen.getAllByRole("listitem")) {
      expect(row.textContent).toContain("Title: After");
    }
  });

  it("lists rows by record name in natural order, not arrival order", () => {
    // MUTATION-TESTED: sort by arrival and the rows read 10, 02, 9.
    card([
      update("Batch Test10", "003QO00000Upd0aaAA"),
      update("Batch Test02", "003QO00000Upd0bbAA"),
      update("Batch Test9", "003QO00000Upd0ccAA"),
    ]);
    fireEvent.click(screen.getByText("Show each request (3)"));
    const names = screen
      .getAllByRole("listitem")
      .map((li) => li.textContent?.match(/Batch Test\d+/)?.[0]);
    expect(names).toEqual(["Batch Test02", "Batch Test9", "Batch Test10"]);
  });

  it("reads a batch as the change it makes, with every record named, and approves in one click", () => {
    // MUTATION-TESTED: without the summary the card lists 20 near-identical
    // rows; with it, one line names the change and all 20 records.
    const rows = Array.from({ length: 20 }, (_, i) =>
      update(
        `Batch Test${String(i + 1).padStart(2, "0")}`,
        `003QO00000Sum${String(i).padStart(2, "0")}AA`,
      ),
    );
    card(rows);
    expect(screen.getByText("Title → After")).toBeInTheDocument();
    expect(screen.getByText("20 contacts")).toBeInTheDocument();
    for (let i = 1; i <= 20; i++) {
      expect(
        screen.getByRole("link", {
          name: new RegExp(`Batch Test${String(i).padStart(2, "0")}`),
        }),
      ).toBeInTheDocument();
    }
    // No per-request rows, and no Approve/Deny per record until asked for.
    expect(screen.queryByRole("button", { name: /^Approve Batch/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve all 20" }));
    expect(state.mutate).toHaveBeenCalledWith({
      ids: rows.map((r) => r.id),
      decision: "approve",
    });
  });

  it("shows each request on demand, decidable one by one", () => {
    const rows = [
      update("Batch Test01", "003QO00000Sum90AA"),
      update("Batch Test02", "003QO00000Sum91AA"),
    ];
    card(rows);
    fireEvent.click(screen.getByText("Show each request (2)"));
    fireEvent.click(
      screen.getByRole("button", { name: "Approve Batch Test01" }),
    );
    expect(state.mutate).toHaveBeenCalledWith(
      { ids: [rows[0]!.id], decision: "approve" },
      expect.anything(),
    );
  });

  it("goes back to the summary from each request", () => {
    // MUTATION-TESTED: without "Show summary" the per-request view is a
    // one-way door.
    card([
      update("Batch Test01", "003QO00000Sum80AA"),
      update("Batch Test02", "003QO00000Sum81AA"),
    ]);
    fireEvent.click(screen.getByText("Show each request (2)"));
    expect(screen.queryByText("Title → After")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show summary" }));
    expect(screen.getByText("Title → After")).toBeInTheDocument();
    expect(screen.getByText("Show each request (2)")).toBeInTheDocument();
  });

  it("drops the summary once a row is decided, so it never claims a change for every record", () => {
    // MUTATION-TESTED: drop the decided-row check and "Show summary" brings
    // back "Title → After · 2 contacts" over a row already approved.
    card([
      update("Batch Test01", "003QO00000Sum70AA"),
      update("Batch Test02", "003QO00000Sum71AA"),
    ]);
    fireEvent.click(screen.getByText("Show each request (2)"));
    fireEvent.click(
      screen.getByRole("button", { name: "Approve Batch Test01" }),
    );
    expect(screen.queryByRole("button", { name: "Show summary" })).toBeNull();
    expect(screen.queryByText("Title → After")).toBeNull();
  });

  it("names past 25 make Approve all reveal each request first", () => {
    // MUTATION-TESTED: ignore NAMES_SHOWN and one click approves 27 records
    // the reviewer never saw named.
    card(
      Array.from({ length: 27 }, (_, i) =>
        update(
          `Batch Test${String(i + 1).padStart(2, "0")}`,
          `003QO00000Big${String(i).padStart(2, "0")}AA`,
        ),
      ),
    );
    expect(screen.getByText("27 contacts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve all 27" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review all 27" }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Title → After")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(27);
  });

  it("splits a reassignment into one line per new value", () => {
    const owner = (name: string, sdr: string, n: number) =>
      contact(name, {
        method: "PATCH",
        batch: { id: "t7", label: "Set SDR owners" },
        summary: {
          action: `Update Contact ${name}`,
          subject: {
            verb: "Update Contact",
            lead: "Update Contact ",
            record: name,
            row: 0,
          },
          details: [
            { label: "Contact", value: `${name} (003QO00000Own${n}0AA)` },
            { label: "SDR", value: sdr },
          ],
        },
      });
    card([
      owner("Ada", "Alex Kim", 1),
      owner("Ben", "Sam Lee", 2),
      owner("Cy", "Alex Kim", 3),
    ]);
    expect(screen.getByText("SDR → Alex Kim")).toBeInTheDocument();
    expect(screen.getByText("2 contacts")).toBeInTheDocument();
    expect(screen.getByText("SDR → Sam Lee")).toBeInTheDocument();
    expect(screen.getByText("1 contact")).toBeInTheDocument();
  });

  it("never summarizes past an odd action: every request is listed", () => {
    const del2 = del("Olivia Martinez", "003QO00000Odd00AA");
    del2.batch = { id: "t2", label: "Set Title" };
    card([
      update("Batch Test01", "003QO00000Sum80AA"),
      update("Batch Test02", "003QO00000Sum81AA"),
      del2,
    ]);
    expect(screen.queryByText(/Show each request/)).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
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

describe("GroupedApprovalCard: a batch of record lists", () => {
  // One task split by field set (6 x industry, 1 x employees, 2 x both):
  // three bulk calls whose titles differ, one change. It reads as ONE table,
  // by the same rule Slack's card uses (`mergeBatchTables`, tested in
  // @onecli/api); here, how the web shows it.
  const IND = { api: "Industry", label: "Industry" };
  const EMP = { api: "NumberOfEmployees", label: "Number of employees" };
  const acct = (i: number, values: (string | null)[]) => ({
    id: `001AA00000AbCd${String(i).padStart(4, "0")}`,
    name: `Account ${i}`,
    new: values,
    old: values.map(() => null),
    ops: values.map(() => "fill" as const),
    op: "fill" as const,
  });
  const batch = { id: "b1", label: "Fill blank fields (9 accounts)", total: 3 };
  const table = (
    fields: (typeof IND)[],
    rows: ReturnType<typeof acct>[],
  ): PendingApproval =>
    contact("x", {
      method: "PATCH",
      batch,
      summary: {
        action: `Update ${rows.length} Accounts`,
        details: [],
        bulk: {
          object: "Account",
          objectLabel: "Account",
          fields,
          rows,
          oldValuesRead: true,
        },
      },
    });
  const fieldSplit = () => [
    table(
      [IND],
      [1, 2, 3, 4, 5, 6].map((i) => acct(i, ["Retail"])),
    ),
    table([EMP], [acct(7, ["1200"])]),
    table(
      [IND, EMP],
      [acct(8, ["Banking", "40"]), acct(9, ["Insurance", "75"])],
    ),
  ];

  it("shows one table of every record, no odd-one-out warning, Approve all over the 3 requests", () => {
    const approvals = fieldSplit();
    card(approvals);
    expect(screen.getByText("Update 9 Accounts")).toBeInTheDocument();
    expect(screen.queryByText(/Also in this batch/)).not.toBeInTheDocument();
    const region = screen.getByRole("region", { name: /9 accounts: changes/ });
    for (const i of [1, 7, 9]) {
      expect(region.textContent).toContain(`Account ${i}`);
    }
    expect(region.textContent).toContain("Number of employees");
    fireEvent.click(screen.getByRole("button", { name: /Approve all 9/ }));
    expect(state.mutate).toHaveBeenCalledWith({
      ids: approvals.map((a) => a.id),
      decision: "approve",
    });
  });

  it("can still decide each request, and back", () => {
    card(fieldSplit());
    fireEvent.click(
      screen.getByRole("button", { name: /Decide each request/ }),
    );
    expect(screen.queryByRole("region", { name: /changes/ })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: /^Approve (?!all)/ }),
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show as one table" }));
    expect(screen.getByRole("region", { name: /changes/ })).toBeInTheDocument();
  });

  it("goes back to rows once a request is decided, here or elsewhere", () => {
    const [ind, emp, both] = fieldSplit();
    const [group] = groupApprovals([ind!, both!]);
    const { unmount } = render(
      <GroupedApprovalCard
        group={group!}
        settled={[{ approval: emp!, outcome: "denied" }]}
      />,
    );
    expect(screen.queryByText("Update 9 Accounts")).toBeNull();
    unmount();

    card(fieldSplit());
    fireEvent.click(
      screen.getByRole("button", { name: /Decide each request/ }),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Approve (?!all)/ })[0]!,
    );
    expect(screen.queryByText("Update 9 Accounts")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show as one table" }),
    ).toBeNull();
  });

  it("keeps a batch of one-record writes as its rows", () => {
    // `PATCH /sobjects/Account/{id}` per record: a one-row table AND a
    // title naming its record, as the gateway sends it.
    const one = (i: number) => {
      const a = table([IND], [acct(i, ["Retail"])]);
      a.summary = {
        ...a.summary!,
        action: `Update Account Account ${i}`,
        subject: {
          verb: "Update Account",
          lead: "Update Account ",
          record: `Account ${i}`,
          row: 0,
        },
        details: [
          { label: "Account", value: `Account ${i}` },
          { label: "Industry", value: "Retail" },
        ],
      };
      return a;
    };
    card([one(1), one(2), one(3)]);
    expect(screen.queryByRole("region", { name: /changes/ })).toBeNull();
    expect(screen.queryByText("Update 3 Accounts")).toBeNull();
    expect(screen.getByText(/Industry/)).toBeInTheDocument();
  });

  it("builds the table once, not on every countdown tick", async () => {
    const { mergeBatchTables } = await import("@onecli/api/lib/batch-table");
    vi.useFakeTimers();
    try {
      card(fieldSplit());
      const built = vi.mocked(mergeBatchTables).mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(vi.mocked(mergeBatchTables).mock.calls).toHaveLength(built);
    } finally {
      vi.useRealTimers();
    }
  });
});
