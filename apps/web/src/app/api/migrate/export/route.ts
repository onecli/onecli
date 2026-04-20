import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { IS_CLOUD } from "@/lib/env";
import { exportToCloud } from "@/lib/services/migrate-export-service";
import { logger } from "@/lib/logger";

const exportSchema = z.object({
  cloudApiKey: z.string().min(1, "Cloud API key is required"),
});

/**
 * POST /api/migrate/export
 *
 * Exports all account data and sends it directly to OneCLI Cloud.
 * The caller receives only an import summary — plaintext secrets
 * never appear in the response.
 */
export const POST = async (request: NextRequest) => {
  if (IS_CLOUD) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const body = await request.json().catch(() => null);
    const parsed = exportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    const result = await exportToCloud(auth.accountId, parsed.data.cloudApiKey);

    logger.info(
      { accountId: auth.accountId, imported: result.imported },
      "migration export completed",
    );

    return NextResponse.json(result);
  } catch (err) {
    logger.error({ err }, "migration export failed");
    return handleServiceError(err);
  }
};
