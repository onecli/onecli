/**
 * Keeper Secrets Manager (KSM) SDK service — the only place that talks to Keeper.
 *
 * A stateless `config + keeper:// ref → value` function, plus the picker's
 * record/field listing. The caller sends the (decrypted) KSM config with each
 * call; this service never reads our database. Refs use KSM notation, e.g. `keeper://<record-uid>/field/password`.
 */
import {
  getFolders,
  getNotationResults,
  getSecrets,
  type KeeperFolder,
  type KeeperRecord,
  initializeStorage,
  inMemoryStorage,
  loadJsonConfig,
  type KeyValueStorage,
} from "@keeper-security/secrets-manager-core";

import { logger } from "../lib/logger";
import { ServiceError } from "./errors";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** What Keeper said when it refused a call. */
interface KeeperFailure {
  /** Keeper's error code (e.g. `access_denied`), when it sent one. */
  code?: string;
  /** Keeper's human-readable message, else the raw error text. */
  message: string;
}

/**
 * When Keeper refuses a call, the SDK throws its JSON error body verbatim as
 * the message, e.g. `{"error":"access_denied","message":"Unable to validate
 * Keeper application access",...}`. Pull out the code and the readable
 * message; anything else (network errors, SDK errors) passes through as is.
 */
export const keeperFailure = (err: unknown): KeeperFailure => {
  const raw = errMessage(err);
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      const str = (v: unknown) =>
        typeof v === "string" && v.trim() ? v : undefined;
      const code = str(b.result_code) ?? str(b.error);
      return { code, message: str(b.message) ?? code ?? raw };
    }
  } catch {
    // Not a Keeper error body.
  }
  return { message: raw };
};

/**
 * Keeper refused the application itself. Keeper does not say why, and there
 * are several reasons it might (access expired or revoked, the client device
 * removed, an IP restriction), so the message names none of them as the
 * cause: it passes on what Keeper said.
 */
export const accessDeniedMessage = (keeperMessage: string): string =>
  `Keeper refused OneCLI's Secrets Manager application: ${keeperMessage}`;

/**
 * Turn a Keeper SDK failure into a ServiceError. `access_denied` is FORBIDDEN
 * (the whole connection is unusable until something changes in Keeper or it
 * is re-paired); anything else is BAD_REQUEST, prefixed with what was being
 * attempted.
 */
const keeperError = (
  prefix: string,
  err: unknown,
  logFields: Record<string, unknown> = {},
): ServiceError => {
  // Already classified (a throttle, see `sdkOptions`): keep its code.
  if (err instanceof ServiceError) return err;
  const failure = keeperFailure(err);
  logger.warn(
    { ...logFields, code: failure.code, err: failure.message },
    `keepersecurity call failed: ${prefix}`,
  );
  return failure.code === "access_denied"
    ? new ServiceError("FORBIDDEN", accessDeniedMessage(failure.message))
    : new ServiceError("BAD_REQUEST", `${prefix}: ${failure.message}`);
};

/**
 * Per-request limit for calls the gateway waits on (it gives up after 15s). A
 * call can make two exchanges with Keeper (e.g. a server-key rotation retry),
 * so each stays under half of that; past it the SDK aborts and the gateway
 * hears a real failure instead of timing out while this keeps going.
 */
const SDK_REQUEST_TIMEOUT_MS = 7_000;
/** Binding registers a new client, which can be slow; the gateway waits 45s. */
const SDK_BIND_TIMEOUT_MS = 20_000;

/**
 * When Keeper rate-limits, the SDK by default sleeps and retries up to 5
 * times, 11s to 176s apart, long after the gateway has given up on the call.
 * Fail fast instead: the gateway backs off (a 429 reads as transient) and
 * retries on its own schedule.
 */
const failOnThrottle = (): Promise<void> =>
  Promise.reject(
    new ServiceError(
      "RATE_LIMITED",
      "Keeper is rate-limiting requests from OneCLI; try again shortly",
    ),
  );

/** SDK options for a call: the storage, a bounded timeout, no throttle sleeps. */
const sdkOptions = (
  storage: KeyValueStorage,
  requestTimeoutMs: number = SDK_REQUEST_TIMEOUT_MS,
) => ({ storage, requestTimeoutMs, throttleSleep: failOnThrottle });

/**
 * How a pasted KSM config is encoded, as the user chose it in the connect
 * form. Never inferred from the text.
 */
export const KSM_CONFIG_FORMATS = ["json", "base64"] as const;
export type KsmConfigFormat = (typeof KSM_CONFIG_FORMATS)[number];

const badConfig = (reason: string): ServiceError =>
  new ServiceError(
    "BAD_REQUEST",
    `invalid keepersecurity KSM config: ${reason}`,
  );

/**
 * Parse `json` as a KSM config: it must be a JSON object. Which keys it needs
 * is the SDK's to judge (pairing validates the config with Keeper before it is
 * stored). `notJson` is the reason given when it doesn't parse.
 */
const parseConfigObject = (
  json: string,
  notJson: string,
): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw badConfig(notJson);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badConfig("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
};

/**
 * Decode a pasted config in the format the user chose into the one form the
 * rest of this service works with: a JSON object string. Done once, at pair
 * time; the gateway stores the result, so later calls never decode or guess.
 */
export const normalizeConfig = (
  config: string,
  format: KsmConfigFormat,
): string => {
  const trimmed = config.trim();
  const record =
    format === "base64"
      ? parseConfigObject(
          Buffer.from(trimmed, "base64").toString("utf8"),
          "expected a base64-encoded JSON configuration",
        )
      : parseConfigObject(trimmed, "expected a JSON configuration");
  return JSON.stringify(record);
};

/**
 * SDK storage for a config as the gateway stores it: the JSON produced at pair
 * time (by {@link normalizeConfig}, or by binding a one-time token).
 */
const toStorage = (config: string): KeyValueStorage => {
  parseConfigObject(
    config,
    "the stored configuration is not JSON; disconnect and connect again",
  );
  return loadJsonConfig(config);
};

/**
 * Bind a one-time token (e.g. `US:xxxx`) to a reusable KSM config. A one-time
 * token is single-use: the SDK registers this client with Keeper and the
 * returned config is the only thing that can be used afterwards, so the caller
 * must persist it.
 */
export const bindOneTimeToken = async (token: string): Promise<string> => {
  try {
    const store: Record<string, string> = {};
    const storage = inMemoryStorage(store);
    await initializeStorage(storage, token.trim());
    // First call performs the binding; it also proves the app can read records.
    await getSecrets(sdkOptions(storage, SDK_BIND_TIMEOUT_MS));
    return JSON.stringify(store);
  } catch (err) {
    // A throttle (see `sdkOptions`) is not a bad token: keep its code.
    if (err instanceof ServiceError) throw err;
    const failure = keeperFailure(err);
    logger.warn(
      { code: failure.code, err: failure.message },
      "keepersecurity one-time token bind failed",
    );
    throw new ServiceError(
      "BAD_REQUEST",
      `keepersecurity one-time token could not be bound (already used or expired?): ${failure.message}`,
    );
  }
};

/** What a successful connectivity check learned about the application's access. */
export interface KeeperSecurityHealth {
  /** Distinct records shared with the application. 0 = it can read nothing. */
  recordCount: number;
  /** When the application's access expires (ISO 8601), if Keeper set a limit. */
  expiresOn?: string;
  /** Warnings Keeper attached to the response, verbatim. */
  warnings?: string[];
}

/**
 * Validate a KSM config with a cheap connectivity check (list accessible
 * records), and report what it saw. Keeper answers an application with nothing
 * shared, or whose shares were removed, with success and an empty list, so
 * `recordCount` is how a caller tells "connected" from "connected, no access".
 */
export const validateConfig = async (
  config: string,
): Promise<KeeperSecurityHealth> => {
  const storage = toStorage(config);
  try {
    const secrets = await getSecrets(sdkOptions(storage));
    const uids = new Set((secrets.records ?? []).map((r) => r.recordUid));
    return {
      recordCount: uids.size,
      ...(secrets.expiresOn
        ? { expiresOn: new Date(secrets.expiresOn).toISOString() }
        : {}),
      ...(secrets.warnings?.length ? { warnings: secrets.warnings } : {}),
    };
  } catch (err) {
    throw keeperError("keepersecurity config validation failed", err);
  }
};

/** Resolve a `keeper://<uid>/field/<name>` reference to its secret value. */
export const resolveSecret = async (
  config: string,
  keepersecurityRef: string,
): Promise<string> => {
  const storage = toStorage(config);
  try {
    const results = await getNotationResults(
      sdkOptions(storage),
      keepersecurityRef,
    );
    if (results.length === 0) throw new Error("no value found");
    // A multi-value field resolves to its first value.
    return String(results[0]);
  } catch (err) {
    throw keeperError(`cannot resolve ${keepersecurityRef}`, err, {
      keepersecurityRef,
    });
  }
};

// ── Picker (browse records → fields) ─────────────────────────────────────
// Field VALUES never leave this process: the SDK decrypts whole records, but
// only titles, types and the notation that addresses each field reach the
// caller.

export interface KeeperSecurityRecord {
  uid: string;
  title: string;
  type: string;
  /** Folder path (`Shared / Team`), when the record sits in a shared folder. */
  folder?: string;
}

export interface KeeperSecurityField {
  /** Full `keeper://` reference that resolves exactly this value. */
  ref: string;
  label: string;
  fieldType: string;
}

/** A value a secret could actually inject: a non-blank string or a number. */
const hasValue = (v: unknown): boolean =>
  typeof v === "number" || (typeof v === "string" && v.trim() !== "");

/** A field as it sits in a decrypted record (`data.fields` / `data.custom`). */
interface RawField {
  type?: unknown;
  label?: unknown;
  value?: unknown;
}

/**
 * Field types that cannot be injected as a credential: references to other
 * records/files, and one-time-code fields (whose stored value is the
 * `otpauth://` seed URL, not a code).
 */
const UNPICKABLE_FIELD_TYPES = new Set([
  "fileRef",
  "cardRef",
  "addressRef",
  "recordRef",
  "oneTimeCode",
  "otp",
  "passkey",
]);

/** Notation reserves `/ [ ] \`; a literal one is backslash-escaped. */
export const escapeNotation = (text: string): string =>
  text.replace(/[/[\]\\]/g, (c) => `\\${c}`);

/** `keyPair` → `Key Pair`, for fields with no label of their own. */
const humanize = (type: string): string =>
  type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The parameter that addresses `field` unambiguously within `list`.
 *
 * KSM notation matches `field/<x>` against a field's type OR its label and
 * refuses when more than one field matches, so a record with two `text` fields
 * cannot address either by type. Prefer the label (what the user named it),
 * fall back to the type; `null` when neither is unique.
 */
const uniqueSelector = (field: RawField, list: RawField[]): string | null => {
  const candidates = [asString(field.label), asString(field.type)].filter(
    Boolean,
  );
  for (const c of candidates) {
    const matches = list.filter(
      (x) => asString(x.type) === c || asString(x.label) === c,
    ).length;
    if (matches === 1) return c;
  }
  return null;
};

/**
 * Every value of a record a secret can reference, each with the notation that
 * resolves it. Object-valued fields (`keyPair`, `host`, `name`, …) expand to
 * one entry per string property, e.g. `field/keyPair[0][privateKey]`, since
 * the whole object would resolve to JSON rather than a usable credential.
 * Fields with no value are left out (a secret pointing at one would resolve
 * empty), though they still count when checking a selector is unique, since
 * Keeper's notation counts them too.
 */
export const listRecordFields = (
  record: Pick<KeeperRecord, "recordUid" | "data">,
): KeeperSecurityField[] => {
  const base = `keeper://${record.recordUid}`;
  const out: KeeperSecurityField[] = [];
  const sections: [string, unknown][] = [
    ["field", record.data?.fields],
    ["custom_field", record.data?.custom],
  ];

  for (const [selector, raw] of sections) {
    if (!Array.isArray(raw)) continue;
    const list = raw as RawField[];
    for (const field of list) {
      const type = asString(field.type);
      if (UNPICKABLE_FIELD_TYPES.has(type)) continue;
      const param = uniqueSelector(field, list);
      if (param === null) continue;

      const label = asString(field.label) || humanize(type || "field");
      const ref = `${base}/${selector}/${escapeNotation(param)}`;
      const values = Array.isArray(field.value) ? field.value : [];
      const first: unknown = values[0];

      if (
        first !== null &&
        typeof first === "object" &&
        !Array.isArray(first)
      ) {
        for (const [key, v] of Object.entries(first)) {
          if (typeof v !== "string" || !hasValue(v)) continue;
          out.push({
            ref: `${ref}[0][${escapeNotation(key)}]`,
            label: `${label} › ${humanize(key)}`,
            fieldType: type,
          });
        }
        continue;
      }

      if (!hasValue(first)) continue;
      out.push({ ref, label, fieldType: type });
    }
  }
  return out;
};

/** `Parent / Child` for a folder UID, walking up through `parentUid`. */
const folderPath = (
  uid: string | undefined,
  byUid: Map<string, KeeperFolder>,
): string | undefined => {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = uid ? byUid.get(uid) : undefined;
  while (cur && !seen.has(cur.folderUid)) {
    seen.add(cur.folderUid);
    if (cur.name) names.unshift(cur.name);
    cur = cur.parentUid ? byUid.get(cur.parentUid) : undefined;
  }
  return names.length > 0 ? names.join(" / ") : undefined;
};

/** List the records shared with the KSM application. */
export const listRecords = async (
  config: string,
): Promise<KeeperSecurityRecord[]> => {
  const storage = toStorage(config);
  try {
    // Folder names are cosmetic; an app or SDK that cannot list folders still
    // gets a usable record list.
    const [secrets, folders] = await Promise.all([
      getSecrets(sdkOptions(storage)),
      getFolders(sdkOptions(storage)).catch((err: unknown) => {
        logger.warn(
          { err: errMessage(err) },
          "keepersecurity folder listing failed; showing records without folders",
        );
        return [] as KeeperFolder[];
      }),
    ]);
    const byUid = new Map(folders.map((f) => [f.folderUid, f]));
    const seen = new Set<string>();
    const records: KeeperSecurityRecord[] = [];
    for (const r of secrets.records) {
      // A record shared both directly and via a folder (or as a shortcut)
      // comes back more than once.
      if (seen.has(r.recordUid)) continue;
      seen.add(r.recordUid);
      const folder = folderPath(r.innerFolderUid ?? r.folderUid, byUid);
      records.push({
        uid: r.recordUid,
        title: asString(r.data?.title) || r.recordUid,
        type: asString(r.data?.type),
        ...(folder ? { folder } : {}),
      });
    }
    return records.sort((a, b) => a.title.localeCompare(b.title));
  } catch (err) {
    throw keeperError("cannot list keepersecurity records", err);
  }
};

/** List one record's referenceable fields — labels and refs, never values. */
export const getRecordFields = async (
  config: string,
  recordUid: string,
): Promise<KeeperSecurityField[]> => {
  const storage = toStorage(config);
  let record: KeeperRecord | undefined;
  try {
    const secrets = await getSecrets(sdkOptions(storage), [recordUid]);
    record = secrets.records.find((r) => r.recordUid === recordUid);
  } catch (err) {
    throw keeperError("cannot read keepersecurity record", err, { recordUid });
  }
  if (!record) {
    throw new ServiceError(
      "NOT_FOUND",
      "keepersecurity record not found or not shared with this application",
    );
  }
  return listRecordFields(record);
};
