import { describe, expect, it } from "vitest";
import { getAppPermissionDefinition } from "./index";
import { allGroupTools, hostPatternsOf, type AppTool } from "./types";
import { hostMatches, pathMatches } from "../../lib/path-match";

// Endpoint coverage for the AWS catalogs, anchored on endpoint shapes OBSERVED
// from the AWS CLI/SDK (`aws <svc> … --debug`) and the AWS General Reference,
// not on assumption. The catalog's whole job is to describe where a service
// actually answers; when AWS's real shape drifts from what is written here, a
// tool-scoped grant silently refuses traffic the same credential is signed for
// — the failure this file exists to catch.
//
// Whole-app ("full access") grants are NOT affected by any of this: they match
// host-only over the provider's injection zone. Everything below is about the
// per-tool arm.

const tool = (provider: string, id: string): AppTool => {
  const def = getAppPermissionDefinition(provider);
  if (!def) throw new Error(`no catalog for ${provider}`);
  const found = def.groups
    .flatMap((group) => allGroupTools(group))
    .find((t) => t.id === id);
  if (!found) throw new Error(`no tool ${provider}/${id}`);
  return found;
};

/** The tool's own (host, path, method) fan-out — the per-tool arm of
 * `appTargetMatches` / `app_target_matches`, without the injection-mirror
 * fold (which is disabled for AWS: it is a multi-host-family app, so a tool
 * rule must never bleed across sibling services). */
const toolMatches = (
  t: AppTool,
  host: string,
  method: string,
  path: string,
): boolean => {
  if (!hostPatternsOf(t).some((pattern) => hostMatches(host, pattern)))
    return false;
  const methods = t.methods ?? (t.method ? [t.method] : []);
  if (methods.length > 0 && !methods.includes(method)) return false;
  return [t.pathPattern, ...(t.aliasPatterns ?? [])].some((pattern) =>
    pathMatches(path, pattern),
  );
};

const PROVIDERS = ["aws", "aws-role"] as const;

// (tool id, method, host, path) triples observed from real AWS SDK traffic.
const COVERED: ReadonlyArray<readonly [string, string, string, string]> = [
  // S3 path-style: regional, global, and dual-stack.
  ["s3_list_buckets", "GET", "s3.us-east-1.amazonaws.com", "/"],
  ["s3_list_buckets", "GET", "s3.amazonaws.com", "/"],
  ["s3_read_objects", "GET", "s3.eu-west-1.amazonaws.com", "/my-bucket"],
  ["s3_upload", "PUT", "s3.us-east-1.amazonaws.com", "/my-bucket/key.txt"],
  ["s3_delete", "DELETE", "s3.us-east-1.amazonaws.com", "/my-bucket/key.txt"],
  // STS: SDK POST, the documented Query-over-GET form, and the global endpoint.
  ["sts_access", "POST", "sts.us-east-1.amazonaws.com", "/"],
  [
    "sts_access",
    "GET",
    "sts.us-east-1.amazonaws.com",
    "/?Action=GetCallerIdentity&Version=2011-06-15",
  ],
  [
    "sts_access",
    "GET",
    "sts.amazonaws.com",
    "/?Action=GetCallerIdentity&Version=2011-06-15",
  ],
  // IAM is global-only.
  ["iam_access", "POST", "iam.amazonaws.com", "/"],
  ["iam_access", "GET", "iam.amazonaws.com", "/?Action=ListRoles"],
  // Lambda's REST surface.
  [
    "lambda_list_functions",
    "GET",
    "lambda.us-east-1.amazonaws.com",
    "/2015-03-31/functions",
  ],
  [
    "lambda_invoke",
    "POST",
    "lambda.us-east-1.amazonaws.com",
    "/2015-03-31/functions/my-fn/invocations",
  ],
  // Query-protocol services: both verbs, regional and global.
  ["ec2_access", "POST", "ec2.us-east-1.amazonaws.com", "/"],
  [
    "ec2_access",
    "GET",
    "ec2.us-east-1.amazonaws.com",
    "/?Action=DescribeInstances",
  ],
  ["cloudwatch_logs_access", "POST", "logs.us-east-1.amazonaws.com", "/"],
  [
    "cloudformation_access",
    "POST",
    "cloudformation.us-east-1.amazonaws.com",
    "/",
  ],
  [
    "secrets_manager_access",
    "POST",
    "secretsmanager.us-east-1.amazonaws.com",
    "/",
  ],
  ["dynamodb_access", "POST", "dynamodb.us-east-1.amazonaws.com", "/"],
  // SES v2 serves the whole API under /v2/email/, not just outbound-emails.
  [
    "ses_send",
    "POST",
    "email.us-east-1.amazonaws.com",
    "/v2/email/outbound-emails",
  ],
  ["ses_send", "GET", "email.us-east-1.amazonaws.com", "/v2/email/identities"],
];

// The security boundary: hosts a tool must NEVER match. `s3tables` and
// `s3-control` are separate services with their own IAM actions, and they are
// exactly what a tempting `s3*.amazonaws.com` glob would have swallowed.
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ["s3_read_objects", "s3tables.us-east-1.amazonaws.com"],
  ["s3_read_objects", "s3-control.us-east-1.amazonaws.com"],
  ["s3_read_objects", "s3express-control.us-east-1.amazonaws.com"],
  ["s3_upload", "s3tables.us-east-1.amazonaws.com"],
  ["s3_delete", "s3-control.us-east-1.amazonaws.com"],
  // No AWS tool may reach a sibling service's endpoint.
  ["s3_read_objects", "ec2.us-east-1.amazonaws.com"],
  ["sts_access", "iam.amazonaws.com"],
  ["iam_access", "sts.us-east-1.amazonaws.com"],
  ["lambda_invoke", "ec2.us-east-1.amazonaws.com"],
  ["dynamodb_access", "s3.us-east-1.amazonaws.com"],
  // A look-alike registrable domain must never match a suffix pattern.
  ["s3_read_objects", "s3.us-east-1.amazonaws.com.evil.test"],
  ["sts_access", "sts.us-east-1.amazonaws.com.evil.test"],
];

describe.each(PROVIDERS)("%s catalog covers real AWS endpoints", (provider) => {
  it.each(COVERED)("%s %s %s%s", (id, method, host, path) => {
    expect(toolMatches(tool(provider, id), host, method, path)).toBe(true);
  });
});

describe.each(PROVIDERS)(
  "%s tools never reach sibling services",
  (provider) => {
    it.each(FORBIDDEN)("%s must not match %s", (id, host) => {
      const t = tool(provider, id);
      // Any path/method — the host axis alone must refuse.
      expect(toolMatches(t, host, "GET", "/")).toBe(false);
      expect(toolMatches(t, host, "POST", "/anything")).toBe(false);
    });
  },
);

// The shapes that #988 could not express and #989 closed: virtual-hosted S3
// (`<bucket>.s3.<region>.amazonaws.com`, the SDK default for every per-bucket
// object call) and DynamoDB's account-specific endpoint. Both need TWO blanks —
// one for the bucket/account, one for the region — which the matcher's
// label-bounded multi-wildcard regime now provides. These were pinned as
// expected-FALSE while the gap stood; they are the proof it is closed.
describe.each(PROVIDERS)(
  "%s covers multi-wildcard endpoint shapes",
  (provider) => {
    it.each([
      [
        "s3_read_objects",
        "GET",
        "my-bucket.s3.us-east-1.amazonaws.com",
        "/key",
      ],
      ["s3_read_objects", "GET", "my-bucket.s3.amazonaws.com", "/key"],
      ["s3_upload", "PUT", "my-bucket.s3.eu-west-2.amazonaws.com", "/key"],
      [
        "dynamodb_access",
        "POST",
        "123456789012.ddb.us-east-1.amazonaws.com",
        "/",
      ],
    ] as const)("%s %s %s%s", (id, method, host, path) => {
      expect(toolMatches(tool(provider, id), host, method, path)).toBe(true);
    });

    // …while a deeper host still fails: each `*` is exactly ONE label, so the
    // pattern stays anchored and cannot creep down the tree.
    it("does not match a deeper host than the pattern's depth", () => {
      expect(
        toolMatches(
          tool(provider, "s3_read_objects"),
          "a.b.s3.us-east-1.amazonaws.com",
          "GET",
          "/key",
        ),
      ).toBe(false);
    });
  },
);
