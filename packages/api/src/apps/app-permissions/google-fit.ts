import type { AppPermissionDefinition } from "./types";

export const googleFitPermissions: AppPermissionDefinition = {
  provider: "google-fit",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "List and read Google Fit activity data",
        hostPattern: "www.googleapis.com",
        pathPattern: "/fitness/v1/*",
        method: "GET",
      },
      tools: [
        {
          id: "list_data_sources",
          name: "List data sources",
          description: "List available Google Fit data sources",
          hostPattern: "www.googleapis.com",
          pathPattern: "/fitness/v1/users/me/dataSources",
          method: "GET",
        },
        {
          id: "list_dataset_points",
          name: "Read dataset points",
          description: "Read activity points from a Google Fit dataset",
          hostPattern: "www.googleapis.com",
          pathPattern: "/fitness/v1/users/me/dataSources/*/datasets/*",
          method: "GET",
        },
        {
          id: "aggregate_data",
          name: "Aggregate activity data",
          description: "Read aggregated activity data from Google Fit",
          hostPattern: "www.googleapis.com",
          pathPattern: "/fitness/v1/users/me/dataset:aggregate",
          method: "POST",
        },
        {
          id: "list_sessions",
          name: "List sessions",
          description: "List fitness sessions recorded in Google Fit",
          hostPattern: "www.googleapis.com",
          pathPattern: "/fitness/v1/users/me/sessions",
          method: "GET",
        },
      ],
    },
  ],
};
