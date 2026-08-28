import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
  process.env.COGNITO_CLIENT_ID = "client-test";
});

import {
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  ListIdentityProvidersCommand,
  UpdateUserPoolClientCommand,
  type CognitoIdentityProviderClient,
  type CreateIdentityProviderCommandInput,
  type UpdateUserPoolClientCommandInput,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  buildProviderDetails,
  createProvider,
  deleteProvider,
  mergeProviderIntoClient,
  providerNameForOrg,
  removeProviderFromClient,
} from "./cognito-idp-service";

const namedError = (name: string) => {
  const err = new Error(name);
  err.name = name;
  return err;
};

interface MockState {
  clientConfig: Record<string, unknown>;
  poolProviders: string[];
  updateInputs: UpdateUserPoolClientCommandInput[];
  describeCount: number;
  failUpdatesWith: string[];
}

const makeClient = (state: MockState) =>
  ({
    send: async (command: object) => {
      if (command instanceof DescribeUserPoolClientCommand) {
        state.describeCount += 1;
        return { UserPoolClient: { ...state.clientConfig } };
      }
      if (command instanceof ListIdentityProvidersCommand) {
        return {
          Providers: state.poolProviders.map((name) => ({
            ProviderName: name,
          })),
        };
      }
      if (command instanceof UpdateUserPoolClientCommand) {
        const failure = state.failUpdatesWith.shift();
        if (failure) throw namedError(failure);
        state.updateInputs.push(command.input);
        return {};
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    },
  }) as unknown as CognitoIdentityProviderClient;

const baseConfig = () => ({
  ClientId: "client-test",
  UserPoolId: "us-east-1_test",
  ClientName: "onecli-app-test",
  SupportedIdentityProviders: ["COGNITO", "Google"],
  ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_USER_AUTH"],
  RefreshTokenValidity: 30,
  ClientSecret: "SECRET",
  LastModifiedDate: new Date(),
  CreationDate: new Date(),
});

let state: MockState;
beforeEach(() => {
  state = {
    clientConfig: baseConfig(),
    poolProviders: ["Google"],
    updateInputs: [],
    describeCount: 0,
    failUpdatesWith: [],
  };
});

const held = async () => true;

describe("providerNameForOrg", () => {
  it("derives a stable 28-char org-prefixed hash", () => {
    const name = providerNameForOrg("org-123");
    expect(name).toBe(providerNameForOrg("org-123"));
    expect(name).toMatch(/^org-[0-9a-f]{24}$/);
    expect(name.length).toBe(28);
    expect(providerNameForOrg("org-456")).not.toBe(name);
  });
});

describe("buildProviderDetails", () => {
  it("builds SAML details with exactly one metadata key", () => {
    expect(
      buildProviderDetails({ type: "saml", metadataUrl: "https://m" }),
    ).toEqual({ MetadataURL: "https://m" });
    expect(
      buildProviderDetails({ type: "saml", metadataXml: "<xml/>" }),
    ).toEqual({ MetadataFile: "<xml/>" });
  });

  it("builds full OIDC details", () => {
    expect(
      buildProviderDetails({
        type: "oidc",
        issuer: "https://idp",
        clientId: "cid",
        clientSecret: "cs",
      }),
    ).toEqual({
      oidc_issuer: "https://idp",
      client_id: "cid",
      client_secret: "cs",
      attributes_request_method: "GET",
      authorize_scopes: "openid email profile",
    });
  });

  it("rejects incomplete inputs", () => {
    expect(() => buildProviderDetails({ type: "saml" })).toThrow("metadata");
    expect(() =>
      buildProviderDetails({ type: "oidc", issuer: "https://idp" }),
    ).toThrow("client");
  });
});

describe("createProvider / deleteProvider", () => {
  it("maps LimitExceededException to a clear error", async () => {
    const client = {
      send: async () => {
        throw namedError("LimitExceededException");
      },
    } as unknown as CognitoIdentityProviderClient;
    await expect(
      createProvider(
        "org-x",
        { type: "saml", metadataUrl: "https://m" },
        client,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("tolerates deleting a missing provider", async () => {
    const client = {
      send: async (command: object) => {
        if (command instanceof DeleteIdentityProviderCommand) {
          throw namedError("ResourceNotFoundException");
        }
        return {};
      },
    } as unknown as CognitoIdentityProviderClient;
    await expect(deleteProvider("org-x", client)).resolves.toBeUndefined();
  });

  it("sends attribute mapping on create", async () => {
    let input: CreateIdentityProviderCommandInput | undefined;
    const client = {
      send: async (command: object) => {
        if (command instanceof CreateIdentityProviderCommand) {
          input = command.input;
        }
        return {};
      },
    } as unknown as CognitoIdentityProviderClient;
    await createProvider(
      "org-x",
      { type: "oidc", issuer: "https://i", clientId: "c", clientSecret: "s" },
      client,
    );
    expect(input?.AttributeMapping).toEqual({ email: "email", name: "name" });
    expect(input?.ProviderType).toBe("OIDC");
  });
});

describe("client list updates", () => {
  it("adds a provider preserving the full config, stripping read-only fields", async () => {
    state.poolProviders = ["Google", "org-abc"];
    await mergeProviderIntoClient("org-abc", held, makeClient(state));
    const input = state.updateInputs[0]!;
    expect(input.SupportedIdentityProviders).toEqual([
      "COGNITO",
      "Google",
      "org-abc",
    ]);
    expect(input.ExplicitAuthFlows).toEqual([
      "ALLOW_USER_SRP_AUTH",
      "ALLOW_USER_AUTH",
    ]);
    expect(input.RefreshTokenValidity).toBe(30);
    expect(input).not.toHaveProperty("ClientSecret");
    expect(input).not.toHaveProperty("LastModifiedDate");
    expect(input).not.toHaveProperty("CreationDate");
  });

  it("prunes names that no longer exist in the pool", async () => {
    state.clientConfig.SupportedIdentityProviders = [
      "COGNITO",
      "Google",
      "org-dangling",
    ];
    state.poolProviders = ["Google", "org-new"];
    await mergeProviderIntoClient("org-new", held, makeClient(state));
    expect(state.updateInputs[0]!.SupportedIdentityProviders).toEqual([
      "COGNITO",
      "Google",
      "org-new",
    ]);
  });

  it("no-ops when already in the desired state", async () => {
    state.clientConfig.SupportedIdentityProviders = ["COGNITO", "Google"];
    state.poolProviders = ["Google"];
    await removeProviderFromClient("org-gone", held, makeClient(state));
    expect(state.updateInputs).toHaveLength(0);
  });

  it("retries ConcurrentModificationException with a fresh describe", async () => {
    state.poolProviders = ["Google", "org-abc"];
    state.failUpdatesWith = ["ConcurrentModificationException"];
    await mergeProviderIntoClient("org-abc", held, makeClient(state));
    expect(state.describeCount).toBe(2); // fresh state per attempt
    expect(state.updateInputs).toHaveLength(1);
  });

  it("gives up after repeated concurrent modifications", async () => {
    state.poolProviders = ["Google", "org-abc"];
    state.failUpdatesWith = [
      "ConcurrentModificationException",
      "ConcurrentModificationException",
      "ConcurrentModificationException",
    ];
    await expect(
      mergeProviderIntoClient("org-abc", held, makeClient(state)),
    ).rejects.toThrow("ConcurrentModificationException");
  });

  it("refuses to write after the lock is lost", async () => {
    state.poolProviders = ["Google", "org-abc"];
    await expect(
      mergeProviderIntoClient("org-abc", async () => false, makeClient(state)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.updateInputs).toHaveLength(0);
  });

  it("removes a provider from the list", async () => {
    state.clientConfig.SupportedIdentityProviders = [
      "COGNITO",
      "Google",
      "org-abc",
    ];
    state.poolProviders = ["Google", "org-abc"];
    await removeProviderFromClient("org-abc", held, makeClient(state));
    expect(state.updateInputs[0]!.SupportedIdentityProviders).toEqual([
      "COGNITO",
      "Google",
    ]);
  });
});
