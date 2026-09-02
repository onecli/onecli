import type { AppPermissionDefinition } from "./types";

// AWS endpoint shapes, and why each tool enumerates its hosts.
//
// `hostMatches` allows a SINGLE `*` (prefix/suffix split), so one pattern
// cannot express every host shape a single AWS service answers on. S3 alone
// serves all of these, and they are the same API:
//
//   s3.amazonaws.com                      global (legacy, still live)
//   s3.us-east-1.amazonaws.com            regional
//   example.s3.us-east-1.amazonaws.com    virtual-hosted (SDK default per bucket)
//
// Each tool therefore lists the shapes it answers on. Deliberately NOT
// `s3*.amazonaws.com`: that also matches `s3tables.*` and `s3-control.*`,
// SEPARATE services with their own IAM actions — an S3 grant must never reach
// them. Enumerating keeps every pattern narrow, so the permit surface is
// exactly what is written here (pinned, with those negative controls, by
// `aws-endpoint-coverage.test.ts`).
//
// Virtual-hosted S3 (`<bucket>.s3.<region>.amazonaws.com`) and the
// account-specific DynamoDB endpoint (`<account>.ddb.<region>.amazonaws.com`)
// need TWO independent blanks — a bucket/account AND a region — which
// `hostMatches` now expresses via its label-bounded multi-wildcard regime.
// `*.s3.*.amazonaws.com` matches a bucket in any region while still refusing
// `s3tables.*` / `s3-control.*` (separate services) and any deeper host, since
// each `*` stands for exactly one label.
//
// `*.api.aws` is AWS's dual-stack twin of `*.amazonaws.com` and is already in
// the provider's injection zone, so the credential is injected there; the
// catalog mirrors it or a tool rule would refuse a host the gateway signs.

/** Regional + global + dual-stack shapes of a single-subdomain AWS service. */
const serviceHosts = (service: string): string[] => [
  `${service}.amazonaws.com`,
  `${service}.*.api.aws`,
];

// S3 answers on path-style (`s3.<region>.…`, plus the global apex) AND
// virtual-hosted style (`<bucket>.s3.<region>.…`), which the SDK uses by
// default for every per-bucket object call.
const S3_HOSTS = [
  "s3.amazonaws.com",
  "s3.*.api.aws",
  // Virtual-hosted: one label for the bucket, one for the region.
  "*.s3.*.amazonaws.com",
  "*.s3.amazonaws.com",
  "*.s3.*.api.aws",
];

// Query-protocol services answer the same Action on POST (SDK default, form
// body) and on GET (`/?Action=…`). Both are live: an unsigned GET returns 403
// (auth), not 405 (method) — the endpoint accepts the verb. Both run the same
// Action under the same IAM permission, so the verb is not a privilege
// boundary; pinning POST only refused hand-rolled/curl callers while the SDK
// passed.
const QUERY_METHODS = ["POST", "GET"];

export const awsPermissions: AppPermissionDefinition = {
  provider: "aws",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "s3_list_buckets",
          name: "List S3 buckets",
          description: "List all S3 buckets in the account",
          hostPattern: "s3.*.amazonaws.com",
          hostAliasPatterns: S3_HOSTS,
          pathPattern: "/",
          method: "GET",
        },
        {
          id: "s3_read_objects",
          name: "Read S3 objects",
          description: "List and download objects from S3 buckets",
          hostPattern: "s3.*.amazonaws.com",
          hostAliasPatterns: S3_HOSTS,
          pathPattern: "/*",
          method: "GET",
        },
        {
          id: "lambda_list_functions",
          name: "List Lambda functions",
          description: "List all Lambda functions in the account",
          hostPattern: "lambda.*.amazonaws.com",
          hostAliasPatterns: serviceHosts("lambda"),
          pathPattern: "/2015-03-31/functions",
          method: "GET",
        },
        {
          id: "lambda_get_function",
          name: "Get Lambda function",
          description: "Get configuration and details of a Lambda function",
          hostPattern: "lambda.*.amazonaws.com",
          hostAliasPatterns: serviceHosts("lambda"),
          pathPattern: "/2015-03-31/functions/*",
          method: "GET",
        },
        {
          id: "ec2_access",
          name: "Access EC2",
          description: "Describe and manage EC2 instances and resources",
          hostPattern: "ec2.*.amazonaws.com",
          hostAliasPatterns: serviceHosts("ec2"),
          pathPattern: "/*",
          methods: QUERY_METHODS,
        },
        {
          id: "cloudwatch_logs_access",
          name: "Access CloudWatch Logs",
          description: "Read log groups, streams, and log events",
          hostPattern: "logs.*.amazonaws.com",
          hostAliasPatterns: serviceHosts("logs"),
          pathPattern: "/*",
          methods: QUERY_METHODS,
        },
        {
          id: "iam_access",
          name: "Access IAM",
          description: "List and describe users, roles, and policies",
          // IAM is global-only: one endpoint, no regional subdomains.
          hostPattern: "iam.amazonaws.com",
          hostAliasPatterns: ["iam.*.api.aws"],
          pathPattern: "/*",
          methods: QUERY_METHODS,
        },
        {
          id: "sts_access",
          name: "Access STS",
          description: "Get caller identity and assume roles",
          hostPattern: "sts.*.amazonaws.com",
          hostAliasPatterns: serviceHosts("sts"),
          pathPattern: "/*",
          methods: QUERY_METHODS,
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "s3_upload",
          name: "Upload to S3",
          description: "Upload and write objects to S3 buckets",
          hostPattern: "s3.*.amazonaws.com",
          hostAliasPatterns: S3_HOSTS,
          pathPattern: "/*",
          method: "PUT",
        },
        {
          id: "s3_delete",
          name: "Delete from S3",
          description: "Delete objects from S3 buckets",
          hostPattern: "s3.*.amazonaws.com",
          hostAliasPatterns: S3_HOSTS,
          pathPattern: "/*",
          method: "DELETE",
        },
        {
          id: "lambda_invoke",
          name: "Invoke Lambda function",
          description: "Execute a Lambda function",
          hostPattern: "lambda.*.amazonaws.com",
          hostAliasPatterns: serviceHosts("lambda"),
          pathPattern: "/2015-03-31/functions/*/invocations",
          method: "POST",
        },
        {
          id: "lambda_delete",
          name: "Delete Lambda function",
          description: "Delete a Lambda function",
          hostPattern: "lambda.*.amazonaws.com",
          hostAliasPatterns: serviceHosts("lambda"),
          pathPattern: "/2015-03-31/functions/*",
          method: "DELETE",
        },
        {
          id: "dynamodb_access",
          name: "Access DynamoDB",
          description: "Read, write, and manage DynamoDB tables and items",
          // Both the classic per-region endpoint and the account-specific
          // `<account>.ddb.<region>.amazonaws.com` shape current SDKs prefer.
          hostPattern: "dynamodb.*.amazonaws.com",
          hostAliasPatterns: [
            ...serviceHosts("dynamodb"),
            "*.ddb.*.amazonaws.com",
            "*.ddb.*.api.aws",
          ],
          pathPattern: "/*",
          methods: QUERY_METHODS,
        },
        {
          id: "ses_send",
          name: "Send emails via SES",
          description: "Send emails using Simple Email Service",
          // SES v2 serves its API under /v2/email/ (outbound-emails is one
          // operation among many); the v1 Query API answers on `/`.
          hostPattern: "email.*.amazonaws.com",
          hostAliasPatterns: [
            "email.amazonaws.com",
            "email.*.api.aws",
            "ses.*.amazonaws.com",
          ],
          pathPattern: "/v2/email/*",
          aliasPatterns: ["/"],
          methods: QUERY_METHODS,
        },
        {
          id: "secrets_manager_access",
          name: "Access Secrets Manager",
          description: "Read, create, and manage secrets",
          hostPattern: "secretsmanager.*.amazonaws.com",
          hostAliasPatterns: serviceHosts("secretsmanager"),
          pathPattern: "/*",
          methods: QUERY_METHODS,
        },
        {
          id: "cloudformation_access",
          name: "Access CloudFormation",
          description: "Create, update, and manage CloudFormation stacks",
          hostPattern: "cloudformation.*.amazonaws.com",
          hostAliasPatterns: serviceHosts("cloudformation"),
          pathPattern: "/*",
          methods: QUERY_METHODS,
        },
      ],
    },
  ],
};
