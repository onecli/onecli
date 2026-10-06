import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_CONNECTION_API_HOSTS,
  agentConnectionSchema,
} from "@onecli/agent-protocol";
import { catalogFactsFor } from "./agent-connection-catalog";
import {
  allGroupTools,
  getAppPermissionDefinitions,
  hostPatternsOf,
} from "../apps/app-permissions";

describe("catalogFactsFor", () => {
  it("names Granola's PUBLIC API host, never the desktop host agents guessed", () => {
    const facts = catalogFactsFor("granola");
    expect(facts.apiHosts).toEqual(["public-api.granola.ai"]);
    expect(facts.apiHosts).not.toContain("api.granola.ai");
    expect(facts.endpoints?.[0]).toBe("GET /v1/notes");
    expect(facts.docsUrl).toBe("https://docs.granola.ai/introduction");
  });

  it("gives tenant-only apps no fixed host: their bound host is the answer", () => {
    expect(catalogFactsFor("salesforce").apiHosts).toEqual([]);
    expect(catalogFactsFor("snowflake").apiHosts).toEqual([]);
  });

  // Linear's rows are discriminated by `graphqlOps` and carry no method;
  // the protocol is POST, and the first render said `GET /graphql`.
  it("names POST for a GraphQL tool with no declared method", () => {
    expect(catalogFactsFor("linear").endpoints).toEqual(["POST /graphql"]);
  });

  // Fireflies' MCP row has neither a method nor a GraphQL kind: there is no
  // single method to show, so it yields no sample rather than an invented one.
  it("skips a method-less tool that is not GraphQL", () => {
    expect(catalogFactsFor("fireflies").endpoints).toEqual(["POST /graphql"]);
  });

  // GitHub's first read tool is git's smart-HTTP transport on `github.com`
  // (`/*/*/git-upload-pack`): a template no agent can call with curl. Its
  // three fixed hosts (github.com, api.github.com, raw.githubusercontent.com)
  // are over the cap, so no one host is named; the docs link carries it.
  it("skips a wildcard-leading path and leads with a real API call", () => {
    const facts = catalogFactsFor("github");
    expect(facts.endpoints?.[0]).toBe("GET /repos/*/*");
    expect(facts.endpoints?.join(" ")).not.toContain("git-upload-pack");
    expect(facts.apiHosts).toEqual([]);
    expect(facts.docsUrl).toBe("https://docs.github.com/en/rest");
  });

  // AWS answers on dozens of fixed service hosts; the first two would be
  // read as THE hosts to call (one of them, `lambda.amazonaws.com`, does not
  // even resolve). Over the cap, the line carries none.
  it("lists no host for an app with more fixed hosts than the wire carries", () => {
    const def = getAppPermissionDefinitions().find((d) => d.provider === "aws");
    const fixed = new Set(
      def!.groups
        .flatMap(allGroupTools)
        .flatMap(hostPatternsOf)
        .filter((h) => !h.includes("*")),
    );
    expect(fixed.size).toBeGreaterThan(MAX_AGENT_CONNECTION_API_HOSTS);
    expect(catalogFactsFor("aws").apiHosts).toEqual([]);
    expect(catalogFactsFor("aws").endpoints).not.toContain("GET /");
  });

  it("is empty for an unknown provider", () => {
    expect(catalogFactsFor("not-a-provider")).toEqual({
      apiHosts: [],
      endpoints: [],
      docsUrl: null,
    });
  });

  it("every catalog provider's facts fit the wire schema", () => {
    for (const def of getAppPermissionDefinitions()) {
      const wire = {
        provider: def.provider,
        name: def.provider,
        label: null,
        host: null,
        ...catalogFactsFor(def.provider),
      };
      expect(agentConnectionSchema.safeParse(wire).success, def.provider).toBe(
        true,
      );
    }
  });

  it("never emits a sample an agent cannot type: a method and a concrete path", () => {
    for (const def of getAppPermissionDefinitions()) {
      for (const line of catalogFactsFor(def.provider).endpoints ?? []) {
        expect(line, def.provider).toMatch(/^[A-Z]+ \/[^*]/);
      }
    }
  });
});
