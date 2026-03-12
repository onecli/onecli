"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { ChevronDown } from "lucide-react";

export const KeyManagementCard = () => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Key Management</CardTitle>
        <CardDescription>
          Select which Key Management System to use for encrypting your project
          data
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="relative w-full max-w-sm">
          <select
            defaultValue="default"
            className="bg-muted text-foreground border-border w-full appearance-none rounded-md border px-3 py-2 pr-9 text-sm"
          >
            <option value="default">Default OneCLI KMS</option>
          </select>
          <ChevronDown className="text-muted-foreground pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2" />
        </div>
        <Button variant="secondary" className="w-fit" disabled>
          Save
        </Button>
      </CardContent>
    </Card>
  );
};
