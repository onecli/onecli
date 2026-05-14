import type { AppPermissionDefinition } from "./types";

export const googleAnalyticsPermissions: AppPermissionDefinition = {
  provider: "google-analytics",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "run_report",
          name: "Run report",
          description: "Run an analytics report for a property",
          hostPattern: "analyticsdata.googleapis.com",
          pathPattern: "/v1beta/properties/*:runReport",
          method: "POST",
        },
        {
          id: "batch_run_reports",
          name: "Batch run reports",
          description: "Run multiple analytics reports in a single request",
          hostPattern: "analyticsdata.googleapis.com",
          pathPattern: "/v1beta/properties/*:batchRunReports",
          method: "POST",
        },
        {
          id: "get_metadata",
          name: "Get metadata",
          description:
            "Retrieve metadata about available dimensions and metrics",
          hostPattern: "analyticsdata.googleapis.com",
          pathPattern: "/v1beta/properties/*/metadata",
          method: "GET",
        },
      ],
    },
  ],
};
