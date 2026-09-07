// Thin interface over the three AWS Marketplace APIs a SaaS seller calls
// (plans/aws-marketplace-listing.md §2), on the Concurrent Agreements
// integration standard: the buyer is identified by CustomerAWSAccountId and
// each agreement's LicenseArn (the legacy CustomerIdentifier is not
// populated for new listings and is never used). The real client loads the
// AWS SDK lazily; the fake is used whenever the listing is not configured
// (dev, OSS, tests) and can be scripted from e2e setup.

import {
  AWS_MARKETPLACE_PRODUCT_CODE,
  AWS_MARKETPLACE_REGION,
  isAwsMarketplaceConfigured,
} from "./env";

export interface ResolvedCustomer {
  customerAwsAccountId: string;
  /** The license granted by the agreement this registration came from. */
  licenseArn: string;
  productCode: string;
}

export interface MarketplaceEntitlement {
  /** License this entitlement belongs to (Concurrent Agreements key). */
  licenseArn: string;
  dimension: string;
  /** Committed units on this dimension (agents for the contract dimension). */
  value: number;
  expirationDate: Date | null;
}

export interface UsageRecordResult {
  meteringRecordId: string | null;
  status: "Success" | "CustomerNotSubscribed" | "DuplicateRecord";
}

export interface AwsMarketplaceClient {
  /** Exchange the x-amzn-marketplace-token for the buyer's identity. */
  resolveCustomer(registrationToken: string): Promise<ResolvedCustomer>;
  /**
   * Entitlements for a buyer on our product, across all of their licenses.
   * A buyer with several concurrent agreements gets several rows per
   * dimension, distinguished by licenseArn.
   */
  getEntitlements(
    customerAwsAccountId: string,
  ): Promise<MarketplaceEntitlement[]>;
  /**
   * Report one usage record on a metered dimension, billed against a
   * specific license's rate card. Per the Concurrent Agreements contract,
   * the request carries CustomerAWSAccountId + LicenseArn and NO
   * request-level ProductCode (sending both risks duplicate billing).
   */
  meterUsage(record: {
    customerAwsAccountId: string;
    licenseArn: string;
    dimension: string;
    quantity: number;
    timestamp: Date;
  }): Promise<UsageRecordResult>;
}

class RealAwsMarketplaceClient implements AwsMarketplaceClient {
  async resolveCustomer(registrationToken: string): Promise<ResolvedCustomer> {
    const { MarketplaceMeteringClient, ResolveCustomerCommand } =
      await import("@aws-sdk/client-marketplace-metering");
    const client = new MarketplaceMeteringClient({
      region: AWS_MARKETPLACE_REGION,
    });
    const out = await client.send(
      new ResolveCustomerCommand({ RegistrationToken: registrationToken }),
    );
    if (!out.CustomerAWSAccountId || !out.LicenseArn || !out.ProductCode) {
      throw new Error("ResolveCustomer returned an incomplete response");
    }
    return {
      customerAwsAccountId: out.CustomerAWSAccountId,
      licenseArn: out.LicenseArn,
      productCode: out.ProductCode,
    };
  }

  async getEntitlements(customerAwsAccountId: string) {
    const { MarketplaceEntitlementServiceClient, GetEntitlementsCommand } =
      await import("@aws-sdk/client-marketplace-entitlement-service");
    const client = new MarketplaceEntitlementServiceClient({
      region: AWS_MARKETPLACE_REGION,
    });
    const entitlements: MarketplaceEntitlement[] = [];
    let nextToken: string | undefined;
    do {
      const out = await client.send(
        new GetEntitlementsCommand({
          ProductCode: AWS_MARKETPLACE_PRODUCT_CODE,
          Filter: { CUSTOMER_AWS_ACCOUNT_ID: [customerAwsAccountId] },
          NextToken: nextToken,
        }),
      );
      for (const e of out.Entitlements ?? []) {
        entitlements.push({
          licenseArn: e.LicenseArn ?? "",
          dimension: e.Dimension ?? "",
          value: e.Value?.IntegerValue ?? 0,
          expirationDate: e.ExpirationDate ?? null,
        });
      }
      nextToken = out.NextToken ?? undefined;
    } while (nextToken);
    return entitlements;
  }

  async meterUsage(record: {
    customerAwsAccountId: string;
    licenseArn: string;
    dimension: string;
    quantity: number;
    timestamp: Date;
  }): Promise<UsageRecordResult> {
    const { MarketplaceMeteringClient, BatchMeterUsageCommand } =
      await import("@aws-sdk/client-marketplace-metering");
    const client = new MarketplaceMeteringClient({
      region: AWS_MARKETPLACE_REGION,
    });
    const out = await client.send(
      new BatchMeterUsageCommand({
        // No request-level ProductCode: the LicenseArn identifies both the
        // product and the specific agreement; sending both double-bills.
        UsageRecords: [
          {
            CustomerAWSAccountId: record.customerAwsAccountId,
            LicenseArn: record.licenseArn,
            Dimension: record.dimension,
            Quantity: record.quantity,
            Timestamp: record.timestamp,
          },
        ],
      }),
    );
    const processed = out.Results?.[0];
    if (processed) {
      return {
        meteringRecordId: processed.MeteringRecordId ?? null,
        status:
          processed.Status === "DuplicateRecord"
            ? "DuplicateRecord"
            : processed.Status === "CustomerNotSubscribed"
              ? "CustomerNotSubscribed"
              : "Success",
      };
    }
    const unprocessed = out.UnprocessedRecords?.[0];
    throw new Error(
      `BatchMeterUsage did not process the record${unprocessed ? " (returned unprocessed)" : ""}`,
    );
  }
}

/**
 * In-memory fake for dev/tests: registration tokens are
 * `fake:<awsAccountId>:<licenseArn>`, entitlements are scriptable per
 * buyer account via the exported handles, metering records accumulate.
 */
export class FakeAwsMarketplaceClient implements AwsMarketplaceClient {
  entitlementsByAccount = new Map<string, MarketplaceEntitlement[]>();
  meteredRecords: {
    customerAwsAccountId: string;
    licenseArn: string;
    dimension: string;
    quantity: number;
    timestamp: Date;
  }[] = [];

  async resolveCustomer(registrationToken: string): Promise<ResolvedCustomer> {
    if (!registrationToken.startsWith("fake:")) {
      throw new Error("Invalid registration token");
    }
    const [, awsAccountId, ...arnParts] = registrationToken.split(":");
    if (!awsAccountId) throw new Error("Invalid registration token");
    return {
      customerAwsAccountId: awsAccountId,
      licenseArn: arnParts.length
        ? arnParts.join(":")
        : `arn:aws:license-manager::${awsAccountId}:license:l-fake`,
      productCode: AWS_MARKETPLACE_PRODUCT_CODE || "fake-product",
    };
  }

  async getEntitlements(customerAwsAccountId: string) {
    return this.entitlementsByAccount.get(customerAwsAccountId) ?? [];
  }

  async meterUsage(record: {
    customerAwsAccountId: string;
    licenseArn: string;
    dimension: string;
    quantity: number;
    timestamp: Date;
  }): Promise<UsageRecordResult> {
    this.meteredRecords.push(record);
    return {
      meteringRecordId: `fake-${this.meteredRecords.length}`,
      status: "Success",
    };
  }
}

let _client: AwsMarketplaceClient | null = null;

export function getAwsMarketplaceClient(): AwsMarketplaceClient {
  if (!_client) {
    _client = isAwsMarketplaceConfigured()
      ? new RealAwsMarketplaceClient()
      : new FakeAwsMarketplaceClient();
  }
  return _client;
}

/** Test-only: replace the singleton (pass null to reset). */
export function setAwsMarketplaceClient(
  client: AwsMarketplaceClient | null,
): void {
  _client = client;
}
