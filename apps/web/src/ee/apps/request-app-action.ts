"use server";

import { after } from "next/server";
import { z } from "zod";
import { db } from "@onecli/db";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { sendEmail } from "@onecli/api/services/email-service";
import { notifyDiscord } from "@onecli/api/ee/notifications/discord";
import { logger } from "@onecli/api/lib/logger";
import { safeAction, type ActionResult } from "@/lib/safe-action";

const requestSchema = z.object({
  name: z.string().trim().min(1, "App name is required").max(100),
  websiteUrl: z
    .string()
    .trim()
    .max(500)
    .transform((v) => {
      if (!v) return null;
      return /^https?:\/\//i.test(v) ? v : `https://${v}`;
    })
    .nullable(),
});

const FROM = "Jonathan from OneCLI <jonathan@onecli.sh>";
const REPLY_TO = "jonathan@reply.onecli.sh";

const buildEmailBody = (
  userName: string | null,
  appName: string,
  appWebsite: string | null,
) => {
  const greeting = userName ? `Hey ${userName}` : "Hey";
  const websiteLine = appWebsite ? ` (${appWebsite})` : "";
  return `${greeting},

Thanks for letting us know you want OneCLI to support ${appName}${websiteLine}.

We're shipping fast (15+ new integrations in the last 2 days) and we'll do our best to have this one live in under a week. I'll email you the moment it is.

If you have a specific use case or urgent timeline, just reply and I'll prioritize it.

Jonathan`;
};

export const submitAppRequest = async (
  rawName: string,
  rawWebsiteUrl: string | null,
): Promise<ActionResult> => {
  return safeAction(async () => {
    const parsed = requestSchema.safeParse({
      name: rawName,
      websiteUrl: rawWebsiteUrl && rawWebsiteUrl.trim() ? rawWebsiteUrl : null,
    });
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? "Invalid request");
    }
    const { name: appName, websiteUrl } = parsed.data;

    const { userId, userEmail } = await resolveOrgContext();
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    const userName = user?.name ?? null;

    logger.info(
      { userId, email: userEmail, appName, websiteUrl },
      "app request submitted",
    );

    after(async () => {
      await sendEmail({
        from: FROM,
        replyTo: REPLY_TO,
        to: userEmail,
        subject: `We got your request for ${appName}`,
        text: buildEmailBody(userName, appName, websiteUrl),
      }).catch((err) => {
        logger.warn({ err, email: userEmail }, "app request ack email failed");
      });

      notifyDiscord("app_request", {
        email: userEmail,
        name: userName,
        appName,
        appWebsite: websiteUrl,
      });
    });
  });
};
