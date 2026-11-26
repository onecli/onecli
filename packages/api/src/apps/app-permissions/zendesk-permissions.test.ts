import { describe, expect, it } from "vitest";
import { zendeskPermissions } from "./zendesk";
import { hostMatches, pathMatches } from "../../lib/path-match";
import { compileConnectionStack } from "../../services/grants-compile";
import { evaluateNew } from "../../services/policy-translation/evaluator";
import type { NewRule } from "../../services/policy-translation/types";

const toolsFor = (method: string, path: string, host = "acme.zendesk.com") =>
  zendeskPermissions.groups
    .flatMap((g) => g.tools)
    .filter(
      (t) =>
        hostMatches(host, t.hostPattern) &&
        (t.methods ?? (t.method ? [t.method] : [])).includes(method) &&
        [t.pathPattern, ...(t.aliasPatterns ?? [])].some((p) =>
          pathMatches(path, p),
        ),
    )
    .map((t) => t.id);

const cases = [
  ["GET", "/api/v2/tickets", "list_tickets"],
  ["GET", "/api/v2/tickets/12", "get_ticket"],
  ["GET", "/api/v2/tickets/12/comments", "list_ticket_comments"],
  ["GET", "/api/v2/users", "list_users"],
  ["GET", "/api/v2/users/42", "get_user"],
  ["GET", "/api/v2/users/me", "get_user"],
  ["GET", "/api/v2/organizations", "list_organizations"],
  ["GET", "/api/v2/organizations/42", "get_organization"],
  ["GET", "/api/v2/search", "search"],
  ["GET", "/api/v2/help_center/en-us/articles", "list_articles"],
  ["GET", "/api/v2/job_statuses/abc123", "get_job_status"],
  ["POST", "/api/v2/tickets", "create_ticket"],
  ["PUT", "/api/v2/tickets/12", "update_ticket"],
  ["PUT", "/api/v2/tickets/update_many", "update_ticket"],
  ["POST", "/api/v2/tickets/12/merge", "merge_tickets"],
  ["PUT", "/api/v2/tickets/12/mark_as_spam", "mark_ticket_spam"],
  ["PUT", "/api/v2/tickets/mark_many_as_spam", "mark_ticket_spam"],
  ["DELETE", "/api/v2/tickets/12", "delete_tickets"],
  ["DELETE", "/api/v2/tickets/destroy_many", "delete_tickets"],
  ["POST", "/api/v2/users", "create_user"],
  ["PUT", "/api/v2/users/42", "update_user"],
  ["DELETE", "/api/v2/users/42", "delete_user"],
  ["POST", "/api/v2/help_center/en-us/sections/42/articles", "create_article"],
] as const;

describe("Zendesk permission catalog", () => {
  it.each(cases)("%s %s identifies only %s", (method, path, id) => {
    for (const suffix of ["", ".json"]) {
      const endpoint = path + suffix;
      expect(toolsFor(method, endpoint)).toEqual([id]);
      expect(toolsFor(method, endpoint + "?ids=1,2")).toEqual([id]);
      expect(toolsFor(method, endpoint + "/nested")).not.toContain(id);
      for (const other of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (other !== method)
          expect(toolsFor(other, endpoint)).not.toContain(id);
      }
      for (const host of [
        "zendesk.com",
        "evil.test",
        "acme.zendesk.com.evil.test",
      ]) {
        expect(toolsFor(method, endpoint, host)).toEqual([]);
      }
    }
  });

  it("singular read grants exclude named collection actions", () => {
    for (const resource of ["tickets", "users", "organizations"]) {
      for (const suffix of ["", ".json"]) {
        for (const action of ["show_many", "count", "autocomplete"]) {
          expect(
            toolsFor("GET", `/api/v2/${resource}/${action}${suffix}`),
          ).toEqual([]);
        }
        for (let digit = 0; digit < 10; digit++) {
          const id =
            resource === "tickets"
              ? "get_ticket"
              : resource === "users"
                ? "get_user"
                : "get_organization";
          expect(
            toolsFor("GET", `/api/v2/${resource}/${digit}42${suffix}`),
          ).toEqual([id]);
        }
      }
    }
  });

  it("covers every numeric ID prefix but excludes named user mutations", () => {
    for (let digit = 0; digit < 10; digit++) {
      for (const suffix of ["", ".json"]) {
        expect(toolsFor("PUT", `/api/v2/tickets/${digit}42${suffix}`)).toEqual([
          "update_ticket",
        ]);
        expect(toolsFor("PUT", `/api/v2/users/${digit}42${suffix}`)).toEqual([
          "update_user",
        ]);
        expect(toolsFor("DELETE", `/api/v2/users/${digit}42${suffix}`)).toEqual(
          ["delete_user"],
        );
      }
    }
    for (const route of ["update_many", "destroy_many", "create_or_update"]) {
      for (const suffix of ["", ".json"]) {
        expect(toolsFor("PUT", `/api/v2/users/${route}${suffix}`)).toEqual([]);
        expect(toolsFor("DELETE", `/api/v2/users/${route}${suffix}`)).toEqual(
          [],
        );
      }
    }
    expect(toolsFor("GET", "/api/v2/webhooks/01GZ/signing_secret")).toEqual([]);
    expect(toolsFor("GET", "/api/v2/oauth/tokens.json")).toEqual([]);
  });

  it("allow-first compiled grants cannot bypass the spam block via ordinary updates", () => {
    const rules: NewRule[] = compileConnectionStack(
      "Zendesk grant",
      "zendesk",
      {
        access: "custom",
        allow: ["update_ticket"],
        ask: [],
        // Even permissive catch-alls must not override an explicitly blocked tool.
        otherReads: "allow",
        otherWrites: "allow",
      },
    ).map((rule, priority) => ({
      scope: "workspace",
      priority,
      isDefault: false,
      source: "grant",
      name: rule.name,
      identities: [{ type: "agent", id: "agent-1" }],
      targets: [
        {
          kind: "connection",
          connectionId: "conn-1",
          provider: "zendesk",
          tools: rule.tools,
          method: rule.method ?? null,
        },
      ],
      action: rule.action,
      requireApproval: rule.requireApproval,
      rateLimit: null,
      rateLimitWindow: null,
      conditions: null,
    }));
    const decision = (path: string) =>
      evaluateNew(rules, {
        host: "acme.zendesk.com",
        path,
        method: "PUT",
        agentId: "agent-1",
        hasInjections: true,
        isLlmHost: false,
        winningConnectionId: "conn-1",
      });
    for (const suffix of ["", ".json"]) {
      for (const route of ["12", "update_many"]) {
        expect(decision(`/api/v2/tickets/${route}${suffix}`)).toEqual({
          action: "allow",
        });
      }
      for (const route of ["12/mark_as_spam", "mark_many_as_spam"]) {
        expect(
          decision(`/api/v2/tickets/${route}${suffix}?ids=12,13`),
        ).toMatchObject({ action: "block" });
      }
    }
  });
});
