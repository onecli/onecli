import type { AppPermissionDefinition } from "./types";

/**
 * Stripe's per-tool catalog. The enumerated tools are all `/v1/...` on
 * `api.stripe.com`, but the group wildcards deliberately span BOTH API
 * namespaces: Stripe also serves a `/v2` namespace (`/v2/core/accounts`,
 * `/v2/money_management/payout_methods`, …) whose writes move real money. A
 * `/v1/*`-only write wildcard would therefore promise "require approval for
 * every write" while leaving every v2 write ungated — precisely the Gmail
 * `batchModify` bypass that `write-wildcard-coverage.test.ts` exists to catch,
 * but one that test could not see, since it only checks the wildcard against
 * the tools that ARE enumerated.
 *
 * Both wildcards are supersets of their groups (every enumerated path starts
 * with `/v1/`), which keeps the gate honest and the coverage test green.
 *
 * Writes here move real money — refunds, payouts, and subscription cancels are
 * enumerated deliberately rather than left implicit, so they can be blocked or
 * gated individually AND are provably covered by the gate-all wildcard.
 */
export const stripePermissions: AppPermissionDefinition = {
  provider: "stripe",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "Read any Stripe data (GET requests)",
        hostPattern: "api.stripe.com",
        pathPattern: "/v1/*",
        // Stripe's second API namespace — without this alias, "all reads"
        // would silently exclude every v2 endpoint.
        aliasPatterns: ["/v2/*"],
        method: "GET",
      },
      tools: [
        {
          id: "get_account",
          name: "Get account",
          description: "Retrieve the connected Stripe account",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/account",
          method: "GET",
        },
        {
          id: "get_balance",
          name: "Get balance",
          description: "Retrieve the current account balance",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/balance",
          method: "GET",
        },
        {
          id: "list_balance_transactions",
          name: "List balance transactions",
          description: "List transactions that contributed to the balance",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/balance_transactions",
          method: "GET",
        },
        {
          id: "list_charges",
          name: "List charges",
          description: "List charges made on the account",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/charges",
          method: "GET",
        },
        {
          id: "list_customers",
          name: "List customers",
          description: "List customers",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/customers",
          method: "GET",
        },
        {
          id: "get_customer",
          name: "Get customer",
          description: "Retrieve a specific customer",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/customers/*",
          method: "GET",
        },
        {
          id: "list_payment_intents",
          name: "List payment intents",
          description: "List payment intents",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/payment_intents",
          method: "GET",
        },
        {
          id: "list_subscriptions",
          name: "List subscriptions",
          description: "List subscriptions",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/subscriptions",
          method: "GET",
        },
        {
          id: "list_invoices",
          name: "List invoices",
          description: "List invoices",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/invoices",
          method: "GET",
        },
        {
          id: "list_products",
          name: "List products",
          description: "List products in the catalog",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/products",
          method: "GET",
        },
        {
          id: "list_prices",
          name: "List prices",
          description: "List prices in the catalog",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/prices",
          method: "GET",
        },
        {
          id: "list_refunds",
          name: "List refunds",
          description: "List refunds",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/refunds",
          method: "GET",
        },
        {
          id: "list_disputes",
          name: "List disputes",
          description: "List disputes",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/disputes",
          method: "GET",
        },
        {
          id: "list_payouts",
          name: "List payouts",
          description: "List payouts to your bank account",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/payouts",
          method: "GET",
        },
        {
          id: "list_events",
          name: "List events",
          description: "List account activity events",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/events",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      wildcard: {
        id: "write_all",
        name: "All write operations",
        description:
          "Any Stripe write — including refunds, payouts, and cancellations",
        hostPattern: "api.stripe.com",
        pathPattern: "/v1/*",
        // Covers the v2 namespace too (`/v2/money_management/...` moves real
        // money), so gating "all writes" leaves no ungated write behind.
        aliasPatterns: ["/v2/*"],
        methods: ["POST", "DELETE"],
      },
      tools: [
        {
          id: "create_customer",
          name: "Create customer",
          description: "Create a new customer",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/customers",
          method: "POST",
        },
        {
          id: "update_customer",
          name: "Update customer",
          description: "Update an existing customer",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/customers/*",
          method: "POST",
        },
        {
          id: "delete_customer",
          name: "Delete customer",
          description: "Permanently delete a customer",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/customers/*",
          method: "DELETE",
        },
        {
          id: "create_payment_intent",
          name: "Create payment intent",
          description: "Create a payment intent to collect a payment",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/payment_intents",
          method: "POST",
        },
        {
          id: "cancel_payment_intent",
          name: "Cancel payment intent",
          description: "Cancel a payment intent",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/payment_intents/*/cancel",
          method: "POST",
        },
        {
          id: "create_charge",
          name: "Create charge",
          description: "Charge a payment source (legacy Charges API)",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/charges",
          method: "POST",
        },
        {
          id: "create_refund",
          name: "Create refund",
          description: "Refund a charge — moves real money back to a customer",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/refunds",
          method: "POST",
        },
        {
          id: "create_payout",
          name: "Create payout",
          description: "Pay out funds to your bank account — moves real money",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/payouts",
          method: "POST",
        },
        {
          id: "create_subscription",
          name: "Create subscription",
          description: "Start a recurring subscription for a customer",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/subscriptions",
          method: "POST",
        },
        {
          id: "update_subscription",
          name: "Update subscription",
          description: "Update an existing subscription",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/subscriptions/*",
          method: "POST",
        },
        {
          id: "cancel_subscription",
          name: "Cancel subscription",
          description: "Cancel a customer's subscription",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/subscriptions/*",
          method: "DELETE",
        },
        {
          id: "create_invoice",
          name: "Create invoice",
          description: "Create an invoice",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/invoices",
          method: "POST",
        },
        {
          id: "finalize_invoice",
          name: "Finalize invoice",
          description: "Finalize a draft invoice, making it payable",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/invoices/*/finalize",
          method: "POST",
        },
        {
          id: "create_product",
          name: "Create product",
          description: "Create a product in the catalog",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/products",
          method: "POST",
        },
        {
          id: "create_price",
          name: "Create price",
          description: "Create a price for a product",
          hostPattern: "api.stripe.com",
          pathPattern: "/v1/prices",
          method: "POST",
        },
      ],
    },
  ],
};
