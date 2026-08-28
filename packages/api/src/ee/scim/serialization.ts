import type {
  DirectoryMember,
  ScimGroupRecord,
} from "../services/org-directory-service";
import { ScimError } from "./errors";

/**
 * SCIM resource serialization (RFC 7643). `meta.location` is absolute —
 * derived from the request origin, since the same app is mounted on both
 * hosts (web + api-server) at /scim/v2.
 */

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";

export const SCIM_CONTENT_TYPE = "application/scim+json";

export interface ScimUserResource {
  schemas: [typeof SCIM_USER_SCHEMA];
  id: string;
  userName: string;
  displayName?: string;
  name?: Record<string, unknown>;
  emails: { value: string; primary: true }[];
  active: boolean;
  meta: {
    resourceType: "User";
    created: string;
    lastModified: string;
    location: string;
  };
}

/** Narrow a stored Json value to a plain object (the SCIM `name` shape). */
const asJsonObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const toScimUser = (
  member: DirectoryMember,
  baseUrl: string,
): ScimUserResource => {
  // Stored components round-trip verbatim (the IdP owns them); members
  // without components keep the legacy display-name fallback.
  const nameObject =
    asJsonObject(member.nameComponents) ??
    (member.name ? { formatted: member.name } : null);
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: member.userId,
    userName: member.email,
    ...(member.name ? { displayName: member.name } : {}),
    ...(nameObject && Object.keys(nameObject).length > 0
      ? { name: nameObject }
      : {}),
    emails: [{ value: member.email, primary: true }],
    active: member.status !== "suspended",
    meta: {
      resourceType: "User",
      created: member.joinedAt.toISOString(),
      lastModified: member.lastModifiedAt.toISOString(),
      location: `${baseUrl}/Users/${member.userId}`,
    },
  };
};

export interface ScimGroupResource {
  schemas: [typeof SCIM_GROUP_SCHEMA];
  id: string;
  displayName: string;
  externalId?: string;
  members?: { value: string; display: string; $ref: string }[];
  meta: {
    resourceType: "Group";
    created: string;
    lastModified: string;
    location: string;
  };
}

export const toScimGroup = (
  group: ScimGroupRecord,
  baseUrl: string,
): ScimGroupResource => ({
  schemas: [SCIM_GROUP_SCHEMA],
  id: group.id,
  displayName: group.name,
  ...(group.externalId !== null ? { externalId: group.externalId } : {}),
  // members: null = excluded from the read (Entra excludedAttributes=members);
  // an empty array still serializes — "no members" is a real answer.
  ...(group.members !== null
    ? {
        members: group.members.map((m) => ({
          value: m.userId,
          display: m.email,
          $ref: `${baseUrl}/Users/${m.userId}`,
        })),
      }
    : {}),
  meta: {
    resourceType: "Group",
    // updatedAt tracks the group row (renames), not membership churn — an
    // accepted approximation; RFC 7643 only pins lastModified >= created.
    lastModified: group.updatedAt.toISOString(),
    created: group.createdAt.toISOString(),
    location: `${baseUrl}/Groups/${group.id}`,
  },
});

export interface ScimListResponse<T> {
  schemas: [typeof SCIM_LIST_SCHEMA];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export const toListResponse = <T>(
  resources: T[],
  totalResults: number,
  startIndex: number,
): ScimListResponse<T> => ({
  schemas: [SCIM_LIST_SCHEMA],
  totalResults,
  startIndex,
  itemsPerPage: resources.length,
  Resources: resources,
});

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export interface ScimPagination {
  /** 1-based, per the SCIM protocol. */
  startIndex: number;
  count: number;
}

/**
 * SCIM protocol pagination params: 1-based startIndex (values < 1 are
 * treated as 1 per RFC 7644 §3.4.2.4), count clamped to [0, MAX]; a
 * negative count means 0 (metadata-only response).
 */
export const parsePagination = (query: {
  startIndex?: string;
  count?: string;
}): ScimPagination => {
  const parseIntParam = (
    raw: string | undefined,
    name: string,
  ): number | null => {
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      throw new ScimError(400, `${name} must be an integer.`, "invalidValue");
    }
    return value;
  };
  const startIndex = parseIntParam(query.startIndex, "startIndex") ?? 1;
  const count = parseIntParam(query.count, "count") ?? DEFAULT_PAGE_SIZE;
  return {
    startIndex: Math.max(startIndex, 1),
    count: Math.min(Math.max(count, 0), MAX_PAGE_SIZE),
  };
};

/**
 * The absolute /scim/v2 base for meta.location. CloudFront/ALB terminate
 * TLS, so the request URL the app sees is http — honor X-Forwarded-Proto
 * (the ALB sets it from the listener) so locations say https in deployment.
 */
export const scimBaseUrl = (
  requestUrl: string,
  forwardedProto?: string,
): string => {
  const url = new URL(requestUrl);
  const proto =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : url.protocol.replace(":", "");
  return `${proto}://${url.host}/scim/v2`;
};
