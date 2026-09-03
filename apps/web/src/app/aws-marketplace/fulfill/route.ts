// AWS Marketplace fulfillment intake (plans/aws-marketplace-listing.md §3).
// After a buyer subscribes, AWS POSTs an application/x-www-form-urlencoded
// body with `x-amzn-marketplace-token` to this URL. The token is opaque,
// single-purpose, and expires in 4 hours; the buyer may not be signed in
// yet, so it is parked in a short-lived httpOnly cookie and the buyer is
// routed through the registration page (which handles login/signup first).
//
// HOSTED ONLY (the /v1 intake's cloudOnly law, applied to the web edition):
// the marketplace only ever redirects buyers to OUR fulfillment URL, so on
// a self-host this surface does not exist — a plain 404, same as the API's
// cloudOnly gate, leaking nothing about what cloud runs.

import { NextRequest, NextResponse } from "next/server";
import { AWS_MP_TOKEN_COOKIE } from "@/ee/billing/aws-marketplace/token-cookie";
import { IS_CLOUD } from "@/lib/env";

const TOKEN_COOKIE = AWS_MP_TOKEN_COOKIE;
const TOKEN_TTL_SECONDS = 4 * 60 * 60; // matches the token's own 4h validity

export async function POST(request: NextRequest) {
  if (!IS_CLOUD) return new NextResponse(null, { status: 404 });
  const form = await request.formData().catch(() => null);
  const token = form?.get("x-amzn-marketplace-token");

  const url = new URL("/aws-marketplace/register", request.url);
  if (typeof token !== "string" || token.length === 0) {
    url.searchParams.set("error", "missing-token");
    return NextResponse.redirect(url, 303);
  }

  const res = NextResponse.redirect(url, 303);
  res.cookies.set(TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: TOKEN_TTL_SECONDS,
    path: "/",
  });
  return res;
}

// A buyer who lands here with GET (bookmark, refresh) goes to the
// registration page, which explains how to restart from AWS if the parked
// token is gone.
export async function GET(request: NextRequest) {
  if (!IS_CLOUD) return new NextResponse(null, { status: 404 });
  return NextResponse.redirect(
    new URL("/aws-marketplace/register", request.url),
    303,
  );
}
