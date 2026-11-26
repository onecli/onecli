import { redirect } from "next/navigation";
import { resolveDefaultHome } from "@/lib/dashboard/home-landing";

/** The org index: the viewer's default org's first agent, in one hop, or
 *  org creation when they belong to no org. */
export default async function OrgIndexPage() {
  redirect((await resolveDefaultHome()) ?? "/create-org");
}
