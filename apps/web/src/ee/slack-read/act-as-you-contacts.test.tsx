// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@onecli/ui/components/tooltip";
import type { MyConversation, ReadGrant, SlackReadConnection } from "./api";
import type { ActAsYouSlot } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/contacts/_components/act-as-you-slot";

/**
 * "Acts as you" folded into Contacts: the slot the free list renders. A
 * contact row gets "Reads as you" / "Writes as you" cells: tri-states when
 * shared (read-only for someone else's), "+ Enable" where the viewer has
 * the conversation (never on their own row), else a dash; an unmatched
 * share is its own table row.
 */

const state = vi.hoisted(() => ({
  connection: undefined as SlackReadConnection | undefined,
  grants: [] as ReadGrant[],
  mine: [] as MyConversation[],
}));

const mocks = vi.hoisted(() => ({
  share: vi.fn(),
  setGrant: vi.fn(),
  deleteGrant: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/w/ws/agents/a/contacts",
}));

vi.mock("./hooks", () => ({
  useSlackReadConnection: () => ({
    data: state.connection,
    isPending: state.connection === undefined,
  }),
  useSlackReadGrants: () => ({ data: { grants: state.grants } }),
  useMyConversations: () => ({ data: { conversations: state.mine } }),
  useStartSlackConnect: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectSlack: () => ({ mutate: vi.fn(), isPending: false }),
  useSetReadGrant: () => ({ mutate: mocks.setGrant, isPending: false }),
  useShareConversations: () => ({ mutate: mocks.share, isPending: false }),
  useDeleteReadGrant: () => ({ mutate: mocks.deleteGrant, isPending: false }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-app-connected", () => ({ useAppMessages: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./add-read-grant-dialog", () => ({
  AddReadGrantDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="share-dialog" /> : null,
}));

const { ActAsYouContacts } = await import("./act-as-you-contacts");

const grant = (over: Partial<ReadGrant> = {}): ReadGrant => ({
  id: "g-1",
  subjectKind: "dm",
  externalRef: "D0SAM",
  subjectLabel: "@Sam",
  counterpartRef: "U0SAM",
  readMode: "allow",
  writeMode: "ask",
  grantedBy: { id: "u-a", name: "Alex", email: "alex@example.com" },
  mine: true,
  ...over,
});

const connected = (canWrite: boolean): SlackReadConnection => ({
  connected: true,
  available: true,
  canWrite,
  slackUserId: "U0ALEX",
  profile: { handle: "alex", realName: "Alex", email: null, avatarUrl: null },
});

/** A stand-in for the free list: one person row (Sam), one channel row
 *  (#general), then whatever the slot adds. */
const Cells = ({
  id,
  extras,
}: {
  id: string;
  extras: ReturnType<ActAsYouSlot["forRow"]>;
}) => (
  <section data-testid={id}>
    {extras?.actions.map((a) => (
      <button key={a.label} type="button" onClick={a.onSelect}>
        {a.label}
      </button>
    ))}
    <div data-testid={`${id}-reads`}>{extras?.cells.reads}</div>
    <div data-testid={`${id}-writes`}>{extras?.cells.writes}</div>
  </section>
);

const Harness = ({ slot }: { slot: ActAsYouSlot }) => (
  <div>
    {slot.header}
    <Cells id="row-sam" extras={slot.forRow("people", "U0SAM", "Sam")} />
    <Cells
      id="row-general"
      extras={slot.forRow("channels", "C0GEN", "#general")}
    />
    <section data-testid="people-extra">
      {slot.standaloneRows("people", ["U0SAM"])}
    </section>
    <section data-testid="channel-extra">
      {slot.standaloneRows("channels", ["C0GEN"])}
    </section>
  </div>
);

const renderIt = () =>
  render(
    <TooltipProvider>
      <ActAsYouContacts agentId="ag-1" agentName="Donna">
        {(slot) => <Harness slot={slot} />}
      </ActAsYouContacts>
    </TooltipProvider>,
  );

const DM_SAM: MyConversation = {
  ref: "D0SAM",
  kind: "dm",
  name: "@Sam",
  counterpartRef: "U0SAM",
};

describe("ActAsYouContacts", () => {
  beforeEach(() => {
    state.connection = connected(true);
    state.grants = [];
    state.mine = [];
    mocks.share.mockReset();
  });

  it("a shared row: compact Read and Write tri-states, Stop in the menu", () => {
    state.grants = [grant()];
    renderIt();
    const reads = screen.getByTestId("row-sam-reads");
    expect(
      within(reads).getByRole("group", { name: "Can Donna read @Sam as you" }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("row-sam-writes")).getByRole("group", {
        name: "Can Donna send in @Sam as you",
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("row-sam")).getByText(
        "Stop acting as you here",
      ),
    ).toBeTruthy();
    expect(screen.queryAllByTestId("as-you-standalone")).toHaveLength(0);
  });

  it("someone else's share is read-only, marked as theirs", () => {
    state.grants = [
      grant({
        id: "g-c",
        subjectKind: "channel",
        externalRef: "C0GEN",
        subjectLabel: "#general",
        counterpartRef: null,
        mine: false,
      }),
    ];
    renderIt();
    const reads = screen.getByTestId("row-general-reads");
    expect(within(reads).getByTestId("shared-by")).toBeTruthy();
    for (const b of within(reads).getAllByRole("button")) {
      expect(b.hasAttribute("disabled")).toBe(true);
    }
  });

  it("not shared but the viewer has it: + Enable shares exactly that ref; Writes is a dash", async () => {
    state.mine = [
      { ref: "C0GEN", kind: "channel", name: "#general", counterpartRef: null },
      DM_SAM,
    ];
    renderIt();
    expect(screen.getByTestId("row-sam-writes").textContent?.trim()).toBe("-");
    await userEvent.click(
      within(screen.getByTestId("row-sam-reads")).getByRole("button", {
        name: "Let Donna act as you with Sam",
      }),
    );
    expect(mocks.share).toHaveBeenCalledWith(
      { externalRefs: ["D0SAM"] },
      expect.anything(),
    );
    // No menu item for it any more: Enable is inline.
    expect(screen.queryByText(/act as you here/)).toBeNull();
  });

  it("the viewer's own row shows a dash, never Enable", () => {
    state.connection = { ...connected(true), slackUserId: "U0SAM" };
    state.mine = [DM_SAM];
    renderIt();
    expect(screen.getByTestId("row-sam-reads").textContent?.trim()).toBe("-");
    expect(
      screen.queryByRole("button", { name: /act as you with/ }),
    ).toBeNull();
  });

  it("no matching conversation, or not connected: dashes", () => {
    const { unmount } = renderIt();
    expect(screen.getByTestId("row-sam-reads").textContent?.trim()).toBe("-");
    unmount();
    state.connection = { ...connected(true), connected: false };
    state.mine = [DM_SAM];
    renderIt();
    expect(screen.getByTestId("row-sam-reads").textContent?.trim()).toBe("-");
  });

  it("gives unmatched shares their own table rows, with a Talks-to explanation", () => {
    state.grants = [
      grant({ id: "g-old", externalRef: "D0OLD", counterpartRef: null }),
      grant({
        id: "g-ch",
        subjectKind: "private_channel",
        externalRef: "G0SECRET",
        subjectLabel: "#notifications",
        counterpartRef: null,
      }),
    ];
    renderIt();
    const people = screen.getByTestId("people-extra");
    expect(within(people).getByText("No DMs yet")).toBeTruthy();
    const channels = screen.getByTestId("channel-extra");
    expect(within(channels).getByText("#notifications")).toBeTruthy();
    expect(within(channels).getByText("Not a member")).toBeTruthy();
    expect(within(channels).getByTestId("contact-row-table")).toBeTruthy();
    expect(within(channels).getByTestId("cell-reads")).toBeTruthy();
  });

  it("Write is locked without send scopes (Never stays available)", () => {
    state.connection = connected(false);
    state.grants = [grant()];
    renderIt();
    const write = screen.getByRole("group", {
      name: "Can Donna send in @Sam as you",
    });
    const allow = within(write).getByRole("button", { name: /Always allow/ });
    expect(
      allow.hasAttribute("disabled") ||
        allow.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    const never = within(write).getByRole("button", { name: /Never/ });
    expect(never.hasAttribute("disabled")).toBe(false);
  });

  it("the top line shows your Slack and opens the bulk share dialog", async () => {
    renderIt();
    expect(screen.getByText("@alex")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Share conversations/ }),
    );
    expect(screen.getByTestId("share-dialog")).toBeTruthy();
  });
});
