"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@onecli/ui/lib/utils";
import { settingsSections } from "@/lib/settings-nav-items";

export const SettingsMobileNav = () => {
  const pathname = usePathname();
  const items = settingsSections.flatMap((s) => s.items);

  return (
    <nav className="flex gap-1 overflow-x-auto border-b px-4 py-2 scrollbar-hide md:hidden">
      {items.map((item) => {
        const isActive = pathname === item.url;
        return (
          <Link
            key={item.url}
            href={item.url}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-brand/10 font-medium text-brand"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.title}
          </Link>
        );
      })}
    </nav>
  );
};
