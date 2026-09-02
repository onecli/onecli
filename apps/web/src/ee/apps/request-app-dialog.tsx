"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { submitAppRequest } from "./request-app-action";

interface RequestAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  initialUrl?: string;
}

/**
 * Derive a favicon URL (via Google's favicon service) from free-form user
 * input. Accepts bare domains (e.g. "notion.so"), full URLs, and anything
 * URL-parseable that has a dotted hostname. Returns null while the input
 * is incomplete or unparseable so the header icon falls back to the
 * placeholder.
 */
const getFaviconUrl = (rawUrl: string): string | null => {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const { hostname } = new URL(withProtocol);
    if (!hostname.includes(".")) return null;
    return `/v1/favicon?domain=${encodeURIComponent(hostname)}`;
  } catch {
    return null;
  }
};

export const RequestAppDialog = ({
  open,
  onOpenChange,
  initialName = "",
  initialUrl = "",
}: RequestAppDialogProps) => {
  const [name, setName] = useState(initialName);
  const [websiteUrl, setWebsiteUrl] = useState(initialUrl);
  const [submitting, setSubmitting] = useState(false);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setWebsiteUrl(initialUrl);
    }
  }, [open, initialName, initialUrl]);

  // Debounce favicon lookup — wait 500ms after the user stops typing,
  // then resolve. Avoids flickering the Google globe for partial input.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFaviconUrl(getFaviconUrl(websiteUrl));
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [websiteUrl]);

  const reset = () => {
    setName("");
    setWebsiteUrl("");
    setFaviconUrl(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || submitting) return;

    setSubmitting(true);
    const result = await submitAppRequest(
      trimmedName,
      websiteUrl.trim() || null,
    );
    setSubmitting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Got it! We'll email you when it's live.");
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="bg-muted flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg">
              {faviconUrl ? (
                <Image
                  key={faviconUrl}
                  src={faviconUrl}
                  alt=""
                  width={20}
                  height={20}
                  className="size-5"
                  unoptimized
                  onError={() => setFaviconUrl(null)}
                />
              ) : (
                <Plus className="text-muted-foreground size-4" />
              )}
            </div>
            <div>
              <DialogTitle className="text-base">Request an app</DialogTitle>
              <DialogDescription className="text-xs">
                Can&apos;t find the app you need? Tell us about it and
                we&apos;ll do our best to add it within a week.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="grid gap-1.5">
            <Label htmlFor="app-request-name">
              App name
              <span className="text-destructive ml-0.5">*</span>
            </Label>
            <Input
              id="app-request-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Notion"
              maxLength={100}
              autoFocus
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="app-request-url">
              Website URL
              <span className="text-muted-foreground ml-1 text-xs">
                (optional)
              </span>
            </Label>
            <Input
              id="app-request-url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="e.g. notion.so"
              maxLength={500}
            />
          </div>

          <Button
            type="submit"
            className="w-full"
            loading={submitting}
            disabled={!name.trim() || submitting}
          >
            {submitting ? "Submitting..." : "Submit request"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
};
