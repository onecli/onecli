"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/providers/auth-provider";

export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;

    if (isAuthenticated) {
      router.replace("/overview");
    } else {
      router.replace("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  return (
    <div className="flex min-h-svh items-center justify-center">
      <div className="text-muted-foreground">Loading...</div>
    </div>
  );
}
