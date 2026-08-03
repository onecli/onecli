import type { AppPermissionDefinition } from "./types";

/**
 * Testiny's REST API is uniform CRUD under app.testiny.io/api/v1/<entity>:
 * GET for reads, POST for creates, PUT/PATCH for updates, DELETE for deletes —
 * plus a POST /api/v1/<entity>/find query endpoint. The finds are reads that
 * travel as POST, so (like Jira's JQL search) the GET-only read wildcard is
 * deliberately NOT a superset of its group and the picker won't offer it as a
 * complete umbrella. The write wildcard gates every mutating method under
 * /api/v1/* and IS a true superset — over-gating the POST finds is the safe
 * direction.
 */
export const testinyPermissions: AppPermissionDefinition = {
  provider: "testiny",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "Every GET endpoint on the Testiny API",
        hostPattern: "app.testiny.io",
        pathPattern: "/api/v1/*",
        method: "GET",
      },
      tools: [
        {
          id: "read_projects",
          name: "Read projects",
          description: "List and retrieve projects",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/project",
          aliasPatterns: ["/api/v1/project/*"],
          method: "GET",
        },
        {
          id: "read_testcases",
          name: "Read test cases",
          description: "List and retrieve test cases and test case folders",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/testcase",
          aliasPatterns: [
            "/api/v1/testcase/*",
            "/api/v1/testcasefolder",
            "/api/v1/testcasefolder/*",
          ],
          method: "GET",
        },
        {
          id: "read_testruns",
          name: "Read test runs",
          description: "List and retrieve test runs and their results",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/testrun",
          aliasPatterns: ["/api/v1/testrun/*"],
          method: "GET",
        },
        {
          id: "read_testplans",
          name: "Read test plans",
          description: "List and retrieve test plans",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/testplan",
          aliasPatterns: ["/api/v1/testplan/*"],
          method: "GET",
        },
        {
          id: "read_milestones",
          name: "Read milestones",
          description: "List and retrieve milestones",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/milestone",
          aliasPatterns: ["/api/v1/milestone/*"],
          method: "GET",
        },
        {
          id: "read_comments",
          name: "Read comments",
          description: "List and retrieve comments on results",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/comment",
          aliasPatterns: ["/api/v1/comment/*"],
          method: "GET",
        },
        {
          id: "search_entities",
          name: "Search entities",
          description:
            "Query test cases, runs, plans, projects, and milestones via the find endpoints (reads that travel as POST)",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/testcase/find",
          aliasPatterns: [
            "/api/v1/testrun/find",
            "/api/v1/testplan/find",
            "/api/v1/project/find",
            "/api/v1/milestone/find",
            "/api/v1/testcasefolder/find",
            "/api/v1/comment/find",
          ],
          method: "POST",
        },
      ],
    },
    {
      category: "write",
      wildcard: {
        id: "write_all",
        name: "All write operations",
        description: "Every mutating endpoint on the Testiny API",
        hostPattern: "app.testiny.io",
        pathPattern: "/api/v1/*",
        methods: ["POST", "PUT", "PATCH", "DELETE"],
      },
      tools: [
        {
          id: "manage_testcases",
          name: "Manage test cases",
          description:
            "Create, update, and delete test cases and test case folders",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/testcase",
          aliasPatterns: [
            "/api/v1/testcase/*",
            "/api/v1/testcasefolder",
            "/api/v1/testcasefolder/*",
          ],
          methods: ["POST", "PUT", "PATCH", "DELETE"],
        },
        {
          id: "manage_testruns",
          name: "Manage test runs",
          description:
            "Create, update, and delete test runs and record test results",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/testrun",
          aliasPatterns: ["/api/v1/testrun/*"],
          methods: ["POST", "PUT", "PATCH", "DELETE"],
        },
        {
          id: "manage_testplans",
          name: "Manage test plans",
          description: "Create, update, and delete test plans",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/testplan",
          aliasPatterns: ["/api/v1/testplan/*"],
          methods: ["POST", "PUT", "PATCH", "DELETE"],
        },
        {
          id: "manage_projects",
          name: "Manage projects",
          description: "Create, update, and delete projects",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/project",
          aliasPatterns: ["/api/v1/project/*"],
          methods: ["POST", "PUT", "PATCH", "DELETE"],
        },
        {
          id: "manage_milestones",
          name: "Manage milestones",
          description: "Create, update, and delete milestones",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/milestone",
          aliasPatterns: ["/api/v1/milestone/*"],
          methods: ["POST", "PUT", "PATCH", "DELETE"],
        },
        {
          id: "manage_comments",
          name: "Manage comments",
          description: "Create, update, and delete comments",
          hostPattern: "app.testiny.io",
          pathPattern: "/api/v1/comment",
          aliasPatterns: ["/api/v1/comment/*"],
          methods: ["POST", "PUT", "PATCH", "DELETE"],
        },
      ],
    },
  ],
};
