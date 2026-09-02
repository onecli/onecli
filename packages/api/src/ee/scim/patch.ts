import { ScimError } from "./errors";

/**
 * PatchOp (RFC 7644 §3.5.2) parsing, normalized for what IdPs really emit:
 * Entra capitalizes op values ("Replace" appears in Microsoft's own docs)
 * and sends booleans as the strings "True"/"False"; Okta removes group
 * members both via a path filter (`members[value eq "id"]`) and via an
 * op-level value array. Attribute/key names are case-insensitive per
 * RFC 7643 §2.1.
 */

export const SCIM_PATCH_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export interface ScimPatchPath {
  /** Lowercased attribute path with dots preserved (e.g. "name.givenname"). */
  base: string;
  /** From `base[attr eq "value"]` — e.g. the member id in members[value eq "…"]. */
  filter?: { attribute: string; value: string };
  /** Lowercased sub-attribute after a filter (e.g. `members[…].display`). */
  subAttribute?: string;
}

export interface ScimPatchOp {
  op: "add" | "remove" | "replace";
  path?: ScimPatchPath;
  value?: unknown;
}

/**
 * Case-insensitive key lookup (SCIM attribute names are case-insensitive,
 * RFC 7643 §2.1) — also used by the resource routers to read request bodies.
 */
export const scimAttr = (
  obj: Record<string, unknown>,
  key: string,
): unknown => {
  const found = Object.keys(obj).find(
    (k) => k.toLowerCase() === key.toLowerCase(),
  );
  return found === undefined ? undefined : obj[found];
};
const pick = scimAttr;

const PATH_PATTERN =
  /^\s*([a-zA-Z][a-zA-Z0-9._-]*)\s*(?:\[\s*([a-zA-Z][a-zA-Z0-9._-]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\])?\s*(?:\.([a-zA-Z][a-zA-Z0-9._-]*))?\s*$/i;

export const parseScimPath = (path: string): ScimPatchPath => {
  const match = PATH_PATTERN.exec(path);
  if (!match) {
    throw new ScimError(
      400,
      `Unsupported patch path "${path}".`,
      "invalidPath",
    );
  }
  const [, base, filterAttr, filterValue, subAttribute] = match;
  return {
    base: base!.toLowerCase(),
    ...(filterAttr !== undefined && filterValue !== undefined
      ? {
          filter: {
            attribute: filterAttr.toLowerCase(),
            value: filterValue.replace(/\\(.)/g, "$1"),
          },
        }
      : {}),
    ...(subAttribute ? { subAttribute: subAttribute.toLowerCase() } : {}),
  };
};

export const parsePatchBody = (body: unknown): ScimPatchOp[] => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ScimError(
      400,
      "Request body must be a PatchOp.",
      "invalidSyntax",
    );
  }
  const record = body as Record<string, unknown>;

  const schemas = pick(record, "schemas");
  if (!Array.isArray(schemas) || !schemas.includes(SCIM_PATCH_SCHEMA)) {
    throw new ScimError(
      400,
      `PatchOp requests must declare the ${SCIM_PATCH_SCHEMA} schema.`,
      "invalidSyntax",
    );
  }

  const operations = pick(record, "operations");
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ScimError(
      400,
      "PatchOp requests must carry at least one operation.",
      "invalidSyntax",
    );
  }

  return operations.map((raw): ScimPatchOp => {
    if (typeof raw !== "object" || raw === null) {
      throw new ScimError(
        400,
        "Each operation must be an object.",
        "invalidSyntax",
      );
    }
    const opRecord = raw as Record<string, unknown>;

    // Entra capitalizes op values ("Add" / "Replace" / "Remove").
    const opRaw = pick(opRecord, "op");
    const op = typeof opRaw === "string" ? opRaw.toLowerCase() : "";
    if (op !== "add" && op !== "remove" && op !== "replace") {
      throw new ScimError(
        400,
        `Unsupported patch op "${String(opRaw)}".`,
        "invalidSyntax",
      );
    }

    const pathRaw = pick(opRecord, "path");
    if (pathRaw !== undefined && typeof pathRaw !== "string") {
      throw new ScimError(400, "Patch path must be a string.", "invalidPath");
    }

    return {
      op,
      ...(pathRaw !== undefined ? { path: parseScimPath(pathRaw) } : {}),
      value: pick(opRecord, "value"),
    };
  });
};

/**
 * Entra's boolean-string quirk: `active` arrives as `"True"` / `"False"`.
 * Targeted coercion at the attribute read — never blanket-converted, so a
 * group legitimately named "True" survives. Null = not a boolean.
 */
export const coerceScimBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return null;
};
