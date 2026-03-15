"use server";

import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { cryptoService } from "@/lib/crypto";
import {
  DEFAULT_AGENT_NAME,
  DEMO_SECRET_NAME,
  DEMO_SECRET_VALUE,
} from "@/lib/constants";

const generateApiKey = () => `oc_${randomBytes(32).toString("hex")}`;
const generateAccessToken = () => `aoc_${randomBytes(32).toString("hex")}`;

export async function ensureUser() {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.upsert({
    where: { externalAuthId: session.id },
    create: {
      externalAuthId: session.id,
      email: session.email ?? "",
      name: session.name,
      apiKey: generateApiKey(),
    },
    update: {
      email: session.email ?? "",
      name: session.name,
    },
    select: { id: true, apiKey: true },
  });

  if (!user.apiKey) {
    await db.user.update({
      where: { id: user.id },
      data: { apiKey: generateApiKey() },
    });
  }

  return { id: user.id };
}

/**
 * Seeds default agent, demo secret, and API key for the current user.
 * Skips anything that already exists. Idempotent — safe to call on every page load.
 */
export async function seedDefaults() {
  const session = await getServerSession();
  if (!session) return;

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true, apiKey: true, demoSeeded: true },
  });

  if (!user) return;

  const ops = [];

  if (!user.apiKey) {
    ops.push(
      db.user.update({
        where: { id: user.id },
        data: { apiKey: generateApiKey() },
      }),
    );
  }

  const hasDefaultAgent = await db.agent.findFirst({
    where: { userId: user.id, isDefault: true },
    select: { id: true },
  });

  if (!hasDefaultAgent) {
    ops.push(
      db.agent.create({
        data: {
          name: DEFAULT_AGENT_NAME,
          accessToken: generateAccessToken(),
          isDefault: true,
          userId: user.id,
        },
      }),
    );
  }

  if (!user.demoSeeded) {
    ops.push(
      db.secret.create({
        data: {
          name: DEMO_SECRET_NAME,
          type: "generic",
          encryptedValue: cryptoService.encrypt(DEMO_SECRET_VALUE),
          hostPattern: "httpbin.org",
          pathPattern: "/anything/*",
          injectionConfig: {
            headerName: "Authorization",
            valueFormat: "Bearer {value}",
          },
          userId: user.id,
        },
      }),
      db.user.update({
        where: { id: user.id },
        data: { demoSeeded: true },
      }),
    );
  }

  if (ops.length > 0) {
    await db.$transaction(ops);
  }
}
