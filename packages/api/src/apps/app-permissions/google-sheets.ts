import type { AppPermissionDefinition } from "./types";

export const googleSheetsPermissions: AppPermissionDefinition = {
  provider: "google-sheets",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_spreadsheet",
          name: "Get spreadsheet",
          description: "Retrieve a spreadsheet and its properties",
          hostPattern: "sheets.googleapis.com",
          pathPattern: "/v4/spreadsheets/*",
          method: "GET",
        },
        {
          id: "get_values",
          name: "Get values",
          description: "Read values from a spreadsheet range",
          hostPattern: "sheets.googleapis.com",
          pathPattern: "/v4/spreadsheets/*/values/*",
          method: "GET",
        },
        {
          id: "batch_get_values",
          name: "Batch get values",
          description: "Read values from multiple spreadsheet ranges",
          hostPattern: "sheets.googleapis.com",
          pathPattern: "/v4/spreadsheets/*/values:batchGet",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "update_values",
          name: "Update values",
          description: "Write values to a spreadsheet range",
          hostPattern: "sheets.googleapis.com",
          pathPattern: "/v4/spreadsheets/*/values/*",
          method: "PUT",
        },
        {
          id: "batch_update_values",
          name: "Batch update values",
          description: "Write values to multiple spreadsheet ranges",
          hostPattern: "sheets.googleapis.com",
          pathPattern: "/v4/spreadsheets/*/values:batchUpdate",
          method: "POST",
        },
        {
          id: "append_values",
          name: "Append values",
          description: "Append values to a spreadsheet range",
          hostPattern: "sheets.googleapis.com",
          pathPattern: "/v4/spreadsheets/*/values/*:append",
          method: "POST",
        },
        {
          id: "create_spreadsheet",
          name: "Create spreadsheet",
          description: "Create a new spreadsheet",
          hostPattern: "sheets.googleapis.com",
          pathPattern: "/v4/spreadsheets",
          method: "POST",
        },
      ],
    },
  ],
};
