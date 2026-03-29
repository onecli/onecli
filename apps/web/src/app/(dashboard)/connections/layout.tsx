import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Connections",
};

export default function ConnectionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex flex-1 flex-col gap-6 max-w-5xl">{children}</div>;
}
