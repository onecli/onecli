"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@onecli/ui/lib/utils";
import { settingsSections } from "@/lib/nav-config";

export const SettingsNav = () => {
  const pathname = usePathname();

  return (
    <nav className="space-y-5">
      {settingsSections.map((section) => (
        <div key={section.label} className="space-y-1">
          <p className="text-muted-foreground px-2 pb-1 text-xs font-medium">
            {section.label}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const isActive = pathname === item.url;
              return (
                <li key={item.url}>
                  <Link
                    href={item.url}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
                      isActive
                        ? "bg-brand/10 font-medium text-brand hover:bg-brand/15"
                        : "text-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="truncate">{item.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
};
