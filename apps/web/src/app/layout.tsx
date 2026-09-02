import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Source_Serif_4 } from "next/font/google";
import { headers } from "next/headers";
import "@onecli/ui/globals.css";
import "./globals.css";
import { AuthProvider } from "@/providers/auth-provider";
import { IS_CLOUD } from "@/lib/env";
import { apiOrigin, gatewayHttpOrigin } from "@onecli/api/lib/public-origins";
import { QueryProvider } from "@/providers/query-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { Toaster } from "@onecli/ui/components/sonner";
import { ThemeColorSync } from "./_components/theme-color-sync";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-serif",
});

// The API/gateway origins are runtime decisions (env-derived), not build-time
// ones — the same prebuilt image serves any deployment. force-dynamic ensures
// the layout re-renders per request instead of baking the localhost fallbacks
// injected below into a prebuilt page.
export const dynamic = "force-dynamic";

// What the injected script (below) sets the browser-side origins to.
//
// Dev: the dev server proxies `/v1`, `/auth` and `/gw` under its own origin
// (`next.config.js` rewrites), so the browser must call the origin it is
// already on — whatever that is. `location.origin` resolves it in the browser,
// which is what makes an ngrok tunnel work with zero config: the injected
// value cannot name a tunnel hostname the server does not know.
//
// Production: the absolute env-configured URLs, injected per request because a
// prebuilt image cannot bake a deployment's addresses. Browsers talk to the
// api-server and gateway directly.
const browserOriginScript = () =>
  process.env.NODE_ENV === "development"
    ? `window.__GATEWAY_API_URL__=location.origin+"/gw";window.__API_URL__=location.origin`
    : `window.__GATEWAY_API_URL__=${JSON.stringify(gatewayHttpOrigin())};window.__API_URL__=${JSON.stringify(apiOrigin())}`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: {
    default: "OneCLI",
    template: "%s - OneCLI",
  },
  description: "Universal CLI gateway for AI agents.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Set by proxy.ts alongside the request's Content-Security-Policy (cloud;
  // OC-01). Next stamps it on its own scripts automatically; this reaches the
  // inline scripts Next does not own — next-themes' theme bootstrap and the
  // self-host origin injection below. Absent (onprem) it renders as no attr.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning className="bg-background">
      {!IS_CLOUD && (
        <head>
          <script
            nonce={nonce}
            dangerouslySetInnerHTML={{
              __html: browserOriginScript(),
            }}
          />
        </head>
      )}
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable}`}
        suppressHydrationWarning
      >
        <AuthProvider>
          <QueryProvider>
            <ThemeProvider
              attribute="class"
              defaultTheme="light"
              enableSystem
              disableTransitionOnChange
              nonce={nonce}
            >
              <ThemeColorSync />
              {children}
              <Toaster />
            </ThemeProvider>
          </QueryProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
