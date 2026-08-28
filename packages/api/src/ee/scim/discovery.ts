import { Hono } from "hono";
import type { ScimEnv } from "./auth";
import { ScimError } from "./errors";
import { scimJson, scimResource } from "./respond";
import {
  SCIM_GROUP_SCHEMA,
  SCIM_USER_SCHEMA,
  scimBaseUrl,
  toListResponse,
} from "./serialization";

/**
 * Discovery endpoints (RFC 7644 §4): the capability contract IdPs
 * introspect. Declares exactly what this server does — PATCH and single-eq
 * filtering yes; bulk, sorting, etags, and password sync no. Kept behind
 * the same bearer auth as the resource routes: IdPs send the token on every
 * request, and an unauthenticated surface buys nothing. Both list and
 * single-resource forms are served (§4: "In cases where a request is for a
 * specific ResourceType or Schema, the single JSON object is returned").
 */

const SPC_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
const RESOURCE_TYPE_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

/** Mirrors serialization.ts MAX_PAGE_SIZE — the advertised filter ceiling. */
const MAX_RESULTS = 500;

/**
 * RFC 7644 §4: query params on configuration endpoints SHALL be ignored,
 * EXCEPT a filter — "the service provider SHOULD respond with HTTP status
 * code 403 (Forbidden) to ensure that clients cannot incorrectly assume
 * that any matching conditions specified in a filter are true."
 */
const rejectFilter = (c: {
  req: { query: (k: string) => string | undefined };
}) => {
  if (c.req.query("filter") !== undefined) {
    throw new ScimError(
      403,
      "Filtering is not supported on configuration endpoints.",
    );
  }
};

const stringAttr = (
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name,
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

const serviceProviderConfig = (baseUrl: string) => ({
  schemas: [SPC_SCHEMA],
  documentationUri: "https://onecli.sh/docs",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: MAX_RESULTS },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "OAuth Bearer Token",
      description:
        "Bearer token generated in OneCLI under Organization Settings → Single sign-on → SCIM provisioning.",
      specUri: "https://www.rfc-editor.org/info/rfc6750",
      primary: true,
    },
  ],
  meta: {
    resourceType: "ServiceProviderConfig",
    location: `${baseUrl}/ServiceProviderConfig`,
  },
});

const resourceTypes = (baseUrl: string) => [
  {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: "User",
    name: "User",
    endpoint: "/Users",
    description: "Organization member",
    schema: SCIM_USER_SCHEMA,
    meta: {
      resourceType: "ResourceType",
      location: `${baseUrl}/ResourceTypes/User`,
    },
  },
  {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    description: "Organization group (managed by your identity provider)",
    schema: SCIM_GROUP_SCHEMA,
    meta: {
      resourceType: "ResourceType",
      location: `${baseUrl}/ResourceTypes/Group`,
    },
  },
];

// Honest self-description: exactly the attributes this server maps.
const schemas = (baseUrl: string) => [
  {
    schemas: [SCHEMA_SCHEMA],
    id: SCIM_USER_SCHEMA,
    name: "User",
    description: "OneCLI organization member",
    attributes: [
      stringAttr("userName", {
        required: true,
        uniqueness: "server",
        // readWrite with guarded semantics: renames are honored for users
        // this org owns (never-signed-in or sole-org member); a multi-org
        // member's rename gets a `mutability` 400 (Table 9 "current state").
        description: "The user's email address — their identity key.",
      }),
      stringAttr("displayName"),
      {
        name: "name",
        type: "complex",
        multiValued: false,
        required: false,
        mutability: "readWrite",
        returned: "default",
        subAttributes: [
          stringAttr("formatted"),
          stringAttr("givenName"),
          stringAttr("familyName"),
        ],
      },
      {
        name: "active",
        type: "boolean",
        multiValued: false,
        required: false,
        mutability: "readWrite",
        returned: "default",
        description:
          "false suspends the member: sessions and API keys stop authorizing.",
      },
      {
        name: "emails",
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readOnly",
        returned: "default",
        subAttributes: [stringAttr("value"), stringAttr("primary")],
      },
    ],
    meta: {
      resourceType: "Schema",
      location: `${baseUrl}/Schemas/${SCIM_USER_SCHEMA}`,
    },
  },
  {
    schemas: [SCHEMA_SCHEMA],
    id: SCIM_GROUP_SCHEMA,
    name: "Group",
    description: "OneCLI organization group",
    attributes: [
      stringAttr("displayName", { required: true, uniqueness: "server" }),
      stringAttr("externalId", { caseExact: true }),
      {
        name: "members",
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readWrite",
        returned: "default",
        subAttributes: [
          stringAttr("value", { mutability: "immutable" }),
          stringAttr("display", { mutability: "readOnly" }),
        ],
      },
    ],
    meta: {
      resourceType: "Schema",
      location: `${baseUrl}/Schemas/${SCIM_GROUP_SCHEMA}`,
    },
  },
];

export const discoveryRouter = new Hono<ScimEnv>();

discoveryRouter.get("/ServiceProviderConfig", (c) => {
  rejectFilter(c);
  return scimResource(
    c,
    serviceProviderConfig(
      scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
    ),
  );
});

discoveryRouter.get("/ResourceTypes", (c) => {
  rejectFilter(c);
  const list = resourceTypes(
    scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
  );
  return scimJson(c, toListResponse(list, list.length, 1), 200);
});

discoveryRouter.get("/ResourceTypes/:id", (c) => {
  rejectFilter(c);
  const match = resourceTypes(
    scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
  ).find((resourceType) => resourceType.id === c.req.param("id"));
  if (!match) throw new ScimError(404, "Resource type not found.");
  return scimResource(c, match);
});

discoveryRouter.get("/Schemas", (c) => {
  rejectFilter(c);
  const list = schemas(
    scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
  );
  return scimJson(c, toListResponse(list, list.length, 1), 200);
});

discoveryRouter.get("/Schemas/:id", (c) => {
  rejectFilter(c);
  const match = schemas(
    scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
  ).find((schema) => schema.id === c.req.param("id"));
  if (!match) throw new ScimError(404, "Schema not found.");
  return scimResource(c, match);
});
