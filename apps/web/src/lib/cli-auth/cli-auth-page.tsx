import { CliAuthConfirm } from "./cli-auth-confirm";

interface Props {
  searchParams: Promise<{ code?: string }>;
}

export default async function CliAuthPage({ searchParams }: Props) {
  const { code } = await searchParams;
  return <CliAuthConfirm code={code} />;
}
