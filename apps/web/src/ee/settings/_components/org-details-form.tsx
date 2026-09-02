"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Check } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card, CardContent, CardFooter } from "@onecli/ui/components/card";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { updateOrganizationAction } from "../actions";

interface Props {
  orgId: string;
  orgName: string;
  readOnly?: boolean;
}

export const OrgDetailsForm = ({ orgId, orgName, readOnly }: Props) => {
  const [name, setName] = useState(orgName);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const isDirty = name.trim() !== orgName;

  const handleSave = () => {
    startTransition(async () => {
      const result = await updateOrganizationAction(orgId, {
        name: name.trim(),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Organization updated");
    });
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(orgId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="grid gap-2">
          <Label htmlFor="org-name" className="select-text">
            Organization name
          </Label>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            readOnly={readOnly}
            className={
              readOnly ? "text-muted-foreground cursor-not-allowed" : ""
            }
          />
        </div>
        <div className="grid gap-2">
          <Label className="select-text">Organization ID</Label>
          <div className="flex gap-2">
            <Input
              value={orgId}
              readOnly
              className="text-muted-foreground cursor-not-allowed"
            />
            <Button
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={handleCopy}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      </CardContent>
      {!readOnly && (
        <CardFooter className="justify-end gap-2 border-t px-6 py-4">
          <Button
            variant="outline"
            disabled={!isDirty || pending}
            onClick={() => setName(orgName)}
          >
            Cancel
          </Button>
          <Button disabled={!isDirty || pending} onClick={handleSave}>
            {pending ? "Saving..." : "Save"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
};
