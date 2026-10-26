import { describeJudgeEval } from "../../testing/judge-eval";
import type { GatewayPendingApproval } from "../channels/gateway-approvals";
import {
  judgeSupersede,
  SUPERSEDE_DEADLINE_MS,
  type SupersedeVerdict,
} from "./supersede-judge";

/**
 * THE SUPERSEDE-JUDGE EVAL: the labeled corpus through the real judge code
 * and the real models (harness and env: `src/testing/judge-eval.ts`).
 *
 * Every case reproduces a real session (Salesforce bulk creates on a local
 * stack), with made-up names. The "already" ones are why the judge sees each
 * record's VALUES and may reason in one line first: "I want 3 of them in
 * Boston" while 3 already were used to withdraw a correct request.
 */

const FIELDS = [
  "Annual revenue",
  "Billing city",
  "Billing country",
  "Billing state",
  "Industry",
  "Name",
].map((label) => ({ label }));

const row = (name: string, city: string, state: string) => ({
  name,
  new: ["9500000", city, "USA", state, "Technology", name],
});

const request = (
  action: string,
  rows: ReturnType<typeof row>[],
): GatewayPendingApproval => ({
  id: "eval",
  summary: { action, bulk: { objectLabel: "Account", fields: FIELDS, rows } },
});

/** 3 in Boston, 2 in New York. */
const MIXED = request("Create 5 Accounts", [
  row("Brightwave", "Boston", "MA"),
  row("Harborline", "Boston", "MA"),
  row("Meridian", "Boston", "MA"),
  row("Cobalt", "New York", "NY"),
  row("Lumen", "New York", "NY"),
]);
const ALL_NY = request(
  "Create 4 Accounts",
  ["Acme", "Globex", "Initech", "Umbrella"].map((n) =>
    row(n, "New York", "NY"),
  ),
);

/** Set Number of Employees = 100 on existing accounts. */
const EMPLOYEES: GatewayPendingApproval = {
  id: "eval",
  summary: {
    action: "Update 13 Accounts",
    bulk: {
      objectLabel: "Account",
      fields: [{ label: "Number of employees" }],
      rows: ["Acme", "Globex", "Initech", "Umbrella", "Hooli"].map((name) => ({
        name,
        new: ["100"],
      })),
    },
  },
};

/** A 10-record update where each record sets DIFFERENT fields; Pinecrest
 * only its employee count. The card's details carried change lines for
 * OTHER records ("Industry -> Surfing ..."), and the judge read Pinecrest
 * as already getting Surfing. */
const MIXED_FIELDS: GatewayPendingApproval = {
  id: "eval",
  summary: {
    action: "Update 4 Accounts",
    details: [
      { label: "Change", value: "Industry \u2192 Surfing \u00b7 1 record" },
      {
        label: "Change",
        value: "Number of employees \u2192 10 \u00b7 2 records",
      },
    ],
    bulk: {
      objectLabel: "Account",
      fields: [
        { label: "Industry" },
        { label: "Number of employees" },
        { label: "Rating" },
      ],
      rows: [
        { name: "Northwind Ventures", new: ["Consulting", "10", "Warm"] },
        { name: "Bluewater Studio", new: ["Surfing", null, null] },
        { name: "Pinecrest Biotech", new: [null, "10", null] },
        { name: "Example Freight", new: ["Healthcare", null, "Cold"] },
      ],
    },
  },
};

const c = (
  label: string,
  held: GatewayPendingApproval,
  message: string,
  expect: SupersedeVerdict,
) => ({ label, input: { held, message }, expect });

const CASES = [
  // Agreement with what the request already does: keep.
  c(
    "already: 3 in boston",
    MIXED,
    "i want that 3 of them would be in boston",
    "keep",
  ),
  c(
    "already: all in new york",
    ALL_NY,
    "make sure they're all in New York",
    "keep",
  ),
  // Unrelated or go-ahead: keep.
  c("other: time", MIXED, "what time is it?", "keep"),
  c("other: thanks", MIXED, "thanks!", "keep"),
  c("other: go ahead", MIXED, "yes go ahead", "keep"),
  c("other: status", MIXED, "is it done yet?", "keep"),
  // A real change or a stop: replace.
  c("change: all chicago", MIXED, "make all 5 in Chicago", "replace"),
  c("change: only 2", MIXED, "create only 2 in boston", "replace"),
  c("change: count", MIXED, "you know what? make it 3 instead of 5", "replace"),
  c(
    "change: more fields",
    MIXED,
    "add a lot more details to each one",
    "replace",
  ),
  c("change: all boston", ALL_NY, "change all to boston", "replace"),
  c(
    "change: add more",
    MIXED,
    "add another 3 actually but this time in new york",
    "replace",
  ),
  c("cancel", MIXED, "cancel that", "replace"),
  // A separate task while one waits: keep the held one ("change the owner"
  // once withdrew a held employees=100 update).
  c(
    "new: change owner",
    EMPLOYEES,
    "change the owner from Alex Kim to Sam Lee",
    "keep",
  ),
  c(
    "new: create a contact",
    EMPLOYEES,
    "also create a contact named Dana at Acme",
    "keep",
  ),
  c(
    "new: send an email",
    EMPLOYEES,
    "and send me an email when it's done",
    "keep",
  ),
  // ...but a change to the held update itself is still a change.
  c(
    "change: employees value",
    EMPLOYEES,
    "make it 250 employees instead",
    "replace",
  ),
  c(
    "change: fewer records",
    EMPLOYEES,
    "only do the first 3 accounts",
    "replace",
  ),
  // A field the request does NOT set on that record.
  c(
    "change: add a field to one record",
    MIXED_FIELDS,
    "actually for \u201cPinecrest Biotech\u201d add there industry of Surfing",
    "replace",
  ),
  c(
    "change: add a field, keep the rest",
    MIXED_FIELDS,
    "can you update the Pinecrest Biotech account then to have industry of Surfing + keep all the other changes you did",
    "replace",
  ),
  // ...and the twin: that record already gets that value.
  c(
    "already: field one record already gets",
    MIXED_FIELDS,
    "make sure Bluewater Studio is set to Surfing",
    "keep",
  ),
];

describeJudgeEval({
  name: "supersede",
  cases: CASES,
  run: (key, input) =>
    judgeSupersede({
      key,
      signal: AbortSignal.timeout(SUPERSEDE_DEADLINE_MS),
      agentName: "Ada",
      held: [input.held],
      message: input.message,
    }),
  label: (verdict) => verdict,
  // A wrong keep costs a Deny click; a wrong replace costs a re-ask.
  floor: 0.9,
});
