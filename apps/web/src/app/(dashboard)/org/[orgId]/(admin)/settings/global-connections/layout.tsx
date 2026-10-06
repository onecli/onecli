export default function GlobalConnectionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex flex-1 flex-col gap-6">{children}</div>;
}
