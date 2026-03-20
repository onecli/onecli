import type { Metadata } from "next";
import localFont from "next/font/local";
import { Source_Serif_4 } from "next/font/google";
import "@onecli/ui/globals.css";
import "./globals.css";
import { AuthProvider } from "@/providers/auth-provider";
import { getAuthMode } from "@/lib/auth/auth-mode";
import { ThemeProvider } from "@/providers/theme-provider";
import { Toaster } from "@onecli/ui/components/sonner";

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

// Auth mode is determined at runtime from /app/data/runtime-config.json
// (written by the Docker entrypoint). force-dynamic ensures the layout
// re-renders per request instead of serving prebuilt static pages.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: "OneCLI",
    template: "%s — OneCLI",
  },
  description: "Universal CLI gateway for AI agents.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const authMode = getAuthMode();

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable}`}
      >
        <AuthProvider authMode={authMode}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            {children}
            <Toaster />
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
