import type { AppPermissionDefinition } from "./types";

/**
 * Stripe's REST API lives entirely under api.stripe.com/v1/ and uses GET for
 * reads, POST for creates AND updates (no PUT/PATCH), and DELETE for the few
 * hard deletes — so the read wildcard is GET /v1/* and the write wildcard is
 * POST+DELETE /v1/*, both true supersets of their groups. Tools cover the
 * surfaces requested in #274: charges/payment intents, Connect accounts and
 * payouts, disputes and refunds, and webhook event inspection.
 */
export const stripePermissions: AppPermissionDefinition = {
  provider: "stripe",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "Every read endpoint on the Stripe API",
        hostPattern: "api.stripe.com",
        pathPattern: "/v1/*",
        method: "GET",
      },
      tools: [
        {
          id: "read_charges",
          name: "Read charges",
          description: "List and retrieve charges",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/charges",
          aliasPatterns: ["/v1/charges/*"],
          method: "GET",
        },
        {
          id: "read_payment_intents",
          name: "Read payment intents",
          description: "List and retrieve payment intents",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/payment_intents",
          aliasPatterns: ["/v1/payment_intents/*"],
          method: "GET",
        },
        {
          id: "read_connected_accounts",
          name: "Read connected accounts",
          description:
            "List and retrieve Stripe Connect accounts and their onboarding status",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/accounts",
          aliasPatterns: ["/v1/accounts/*"],
          method: "GET",
        },
        {
          id: "read_payouts",
          name: "Read payouts",
          description: "List and retrieve payouts",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/payouts",
          aliasPatterns: ["/v1/payouts/*"],
          method: "GET",
        },
        {
          id: "read_disputes",
          name: "Read disputes",
          description: "List and retrieve disputes and their evidence",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/disputes",
          aliasPatterns: ["/v1/disputes/*"],
          method: "GET",
        },
        {
          id: "read_refunds",
          name: "Read refunds",
          description: "List and retrieve refunds",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/refunds",
          aliasPatterns: ["/v1/refunds/*"],
          method: "GET",
        },
        {
          id: "read_customers",
          name: "Read customers",
          description: "List, retrieve, and search customers",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/customers",
          aliasPatterns: ["/v1/customers/*"],
          method: "GET",
        },
        {
          id: "read_balance",
          name: "Read balance",
          description: "Read the account balance and balance transactions",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/balance",
          aliasPatterns: [
            "/v1/balance_transactions",
            "/v1/balance_transactions/*",
          ],
          method: "GET",
        },
        {
          id: "read_events",
          name: "Read events",
          description: "Inspect webhook events",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/events",
          aliasPatterns: ["/v1/events/*"],
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      wildcard: {
        id: "write_all",
        name: "All write operations",
        description: "Every mutating endpoint on the Stripe API",
        hostPattern: "api.stripe.com",
        pathPattern: "/v1/*",
        methods: ["POST", "DELETE"],
      },
      tools: [
        {
          id: "manage_payment_intents",
          name: "Manage payment intents",
          description:
            "Create, update, confirm, capture, and cancel payment intents",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/payment_intents",
          aliasPatterns: ["/v1/payment_intents/*"],
          method: "POST",
        },
        {
          id: "manage_charges",
          name: "Manage charges",
          description: "Create, update, and capture charges",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/charges",
          aliasPatterns: ["/v1/charges/*"],
          method: "POST",
        },
        {
          id: "create_refunds",
          name: "Create refunds",
          description: "Create, update, and cancel refunds",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/refunds",
          aliasPatterns: ["/v1/refunds/*"],
          method: "POST",
        },
        {
          id: "manage_disputes",
          name: "Manage disputes",
          description: "Update dispute evidence and close disputes",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/disputes/*",
          method: "POST",
        },
        {
          id: "manage_payouts",
          name: "Manage payouts",
          description: "Create, update, cancel, and reverse payouts",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/payouts",
          aliasPatterns: ["/v1/payouts/*"],
          method: "POST",
        },
        {
          id: "manage_connected_accounts",
          name: "Manage connected accounts",
          description:
            "Create, update, reject, and delete Stripe Connect accounts",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/accounts",
          aliasPatterns: ["/v1/accounts/*"],
          methods: ["POST", "DELETE"],
        },
        {
          id: "manage_customers",
          name: "Manage customers",
          description: "Create, update, and delete customers",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/customers",
          aliasPatterns: ["/v1/customers/*"],
          methods: ["POST", "DELETE"],
        },
      ],
    },
  ],
};
