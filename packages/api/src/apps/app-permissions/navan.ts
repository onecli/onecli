import type { AppPermissionDefinition, AppTool } from "./types";

// Navan serves every documented endpoint from api.navan.com, for every
// region (EU only adds an X-ta-region header). Paths per docs.navan.com/api.
const HOST = "api.navan.com";

const read = (
  id: string,
  name: string,
  description: string,
  pathPattern: string,
): AppTool => ({
  id,
  name,
  description,
  hostPattern: HOST,
  pathPattern,
  method: "GET",
});

export const navanPermissions: AppPermissionDefinition = {
  provider: "navan",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "Read any Navan booking or expense data (GET requests)",
        hostPattern: HOST,
        pathPattern: "/v1/*",
        method: "GET",
      },
      tools: [
        read(
          "list_bookings",
          "List bookings",
          "List travel bookings by created, updated, or trip start date",
          "/v1/bookings",
        ),
        read(
          "list_card_transactions",
          "List card transactions",
          "List Navan card transactions",
          "/v1/expense/card-transactions",
        ),
        read(
          "list_connect_transactions",
          "List Connect card transactions",
          "List transactions from Connect card integrations",
          "/v1/expense/connect-transactions",
        ),
        read(
          "list_manual_transactions",
          "List manual transactions",
          "List manual expenses, reimbursements, and payroll",
          "/v1/expense/manual-transactions",
        ),
        read(
          "list_repayments",
          "List repayments",
          "List expense repayments",
          "/v1/expense/repayments",
        ),
        read(
          "list_fees",
          "List fees",
          "List reimbursement, FX, and platform fees",
          "/v1/expense/fees",
        ),
        read(
          "list_adjustments",
          "List adjustments",
          "List credit and debit memos",
          "/v1/expense/adjustments",
        ),
        read(
          "list_daily_rebates",
          "List daily rebates",
          "List daily rebates",
          "/v1/expense/daily-rebates",
        ),
        read(
          "list_disputes",
          "List disputes",
          "List transaction disputes",
          "/v1/expense/disputes",
        ),
        read(
          "list_statement_payments",
          "List statement payments",
          "List statement payments and refunds",
          "/v1/expense/statement-payments",
        ),
        read(
          "list_transactions",
          "List transactions",
          "List transactions of any type, or fetch a batch by ID",
          "/v1/expense/transactions",
        ),
        read(
          "list_receipts",
          "List receipts",
          "List receipt download links by date filter",
          "/v1/expense/transactions/receipts",
        ),
        read(
          "get_transaction",
          "Get transaction",
          "Get one transaction, its receipt links, or a receipt download",
          "/v1/expense/transactions/*",
        ),
        read(
          "list_custom_fields",
          "List custom fields",
          "List the company's expense custom fields",
          "/v1/expense/custom-fields",
        ),
        read(
          "get_custom_field",
          "Get custom field",
          "Get a custom field definition or a batch-options job status",
          "/v1/expense/custom-fields/*",
        ),
        read(
          "list_gl_codes",
          "List GL codes",
          "List the company's saved GL codes",
          "/v1/expense/gl-codes",
        ),
        read(
          "get_gl_code",
          "Get GL code",
          "Get one saved GL code by number",
          "/v1/expense/gl-codes/*",
        ),
        read(
          "get_gl_code_settings",
          "Get GL code settings",
          "Read the company's ERP GL code settings",
          "/v1/expense/gl-code-settings",
        ),
        read(
          "list_tax_mappings",
          "List tax mappings",
          "List saved tax mappings",
          "/v1/expense/tax-mappings",
        ),
        read(
          "get_tax_mapping",
          "Get tax mapping",
          "Get one active tax mapping by country and ERP tax code",
          "/v1/expense/tax-mappings/by-tax-code",
        ),
      ],
    },
    {
      category: "write",
      wildcard: {
        id: "write_all",
        name: "All write operations",
        description:
          "Any Navan write, including transaction updates and custom field options",
        hostPattern: HOST,
        pathPattern: "/v1/*",
        methods: ["POST", "PUT", "PATCH", "DELETE"],
      },
      tools: [
        {
          id: "update_transactions",
          name: "Update transactions",
          description:
            "Batch-update ERP sync status, GL code, HR fields, and custom fields",
          hostPattern: HOST,
          pathPattern: "/v1/expense/transactions",
          method: "PATCH",
        },
        {
          id: "manage_custom_field_options",
          name: "Manage custom field options",
          description:
            "Create, update, upsert, or delete a custom field's option values",
          hostPattern: HOST,
          pathPattern: "/v1/expense/custom-fields/*/options",
          method: "POST",
        },
        {
          id: "manage_gl_codes",
          name: "Manage GL codes",
          description:
            "Create or update GL codes (companies without a native ERP integration)",
          hostPattern: HOST,
          pathPattern: "/v1/expense/gl-codes",
          aliasPatterns: ["/v1/expense/gl-codes/*"],
          methods: ["PUT", "PATCH"],
        },
        {
          id: "update_gl_code_settings",
          name: "Update GL code settings",
          description: "Update the company's ERP GL code settings",
          hostPattern: HOST,
          pathPattern: "/v1/expense/gl-code-settings",
          method: "PATCH",
        },
        {
          id: "manage_gl_code_exclusions",
          name: "Manage GL code exclusions",
          description: "Add or remove a GL code exclusion",
          hostPattern: HOST,
          pathPattern: "/v1/expense/gl-code-exclusions",
          aliasPatterns: ["/v1/expense/gl-code-exclusions/*"],
          methods: ["POST", "DELETE"],
        },
        {
          id: "manage_tax_mappings",
          name: "Manage tax mappings",
          description: "Stage, update, confirm, or discard tax mapping changes",
          hostPattern: HOST,
          pathPattern: "/v1/expense/tax-mappings",
          aliasPatterns: ["/v1/expense/tax-mappings/*"],
          methods: ["PUT", "PATCH", "POST", "DELETE"],
        },
      ],
    },
  ],
};
