import { redirect } from "next/navigation";

// OSS: no deploy wizard — redirect to the main deploy page (cloud CTA)
export default function DeployNewPage() {
  redirect("/deploy");
}
