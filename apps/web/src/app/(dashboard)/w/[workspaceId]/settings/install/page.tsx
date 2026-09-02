import { Suspense } from "react";
import type { Metadata } from "next";
import { InstallContent } from "./_components/install-content";

export const metadata: Metadata = {
  title: "Install",
};

export default function InstallPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <Suspense>
        <InstallContent />
      </Suspense>
    </div>
  );
}
