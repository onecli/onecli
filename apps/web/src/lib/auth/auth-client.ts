"use client";

import { createAuthClient } from "better-auth/react";
import { BETTER_AUTH_BASE_PATH } from "@onecli/api/lib/better-auth-contract";
import { API_ORIGIN } from "@/lib/api-fetch";

/**
 * The browser's half of the self-hosted identity layer.
 *
 * Auth lives on the API origin, not this one, so the client is pointed there
 * explicitly; it sends credentials by default, which is the same cookie
 * posture the rest of the dashboard's API calls use.
 *
 * Built lazily by the provider rather than at module scope: the API origin is
 * injected into the page at runtime (a prebuilt image cannot bake a
 * deployment's URL), so reading it at import time can see the fallback value.
 */
export const createOnpremAuthClient = () =>
  createAuthClient({
    baseURL: API_ORIGIN,
    basePath: BETTER_AUTH_BASE_PATH,
  });

export type OnpremAuthClient = ReturnType<typeof createOnpremAuthClient>;
