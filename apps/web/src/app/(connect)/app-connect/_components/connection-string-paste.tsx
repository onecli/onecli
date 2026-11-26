"use client";

import { useState } from "react";
import { Check, ClipboardPaste } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { parseConnectionString } from "@/lib/connections/parse-connection-string";

/**
 * A one-line shortcut above a database form: paste
 * `postgresql://user:pass@host:5432/db` and the fields below fill in, so the
 * user still sees and can correct every value. Collapsed to a single link by
 * default so the form stays quiet for people who type the fields.
 */
export const ConnectionStringPaste = ({
  onParsed,
}: {
  onParsed: (fields: Record<string, string>) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<{
    tone: "ok" | "warn" | "error";
    text: string;
  } | null>(null);

  const apply = (raw: string) => {
    const parsed = parseConnectionString(raw);
    if (!parsed) {
      setMessage({
        tone: "error",
        text: "That isn't a postgres:// or postgresql:// connection string.",
      });
      return;
    }
    onParsed(parsed.fields);
    // Done: the box closes, so the form shows only the fields it filled.
    // The string held the password, so nothing of it is kept.
    setValue("");
    setOpen(false);
    setMessage(
      parsed.plaintextRequested
        ? {
            tone: "warn",
            text: "Filled in from the connection string, with No encryption as it asked.",
          }
        : {
            tone: "ok",
            text: "Filled in from the connection string. Check the fields below.",
          },
    );
  };

  if (!open)
    return (
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {message && message.tone !== "error" && (
          <p
            role="status"
            className={
              message.tone === "warn"
                ? "flex items-center gap-1.5 text-amber-700 dark:text-amber-400"
                : "flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400"
            }
          >
            <Check className="size-3.5" aria-hidden="true" />
            {message.text}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            setOpen(true);
          }}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 underline-offset-2 hover:underline dark:text-foreground/70"
        >
          <ClipboardPaste className="size-3.5" aria-hidden="true" />
          {message ? "Paste another" : "Paste a connection string instead"}
        </button>
      </div>
    );

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor="connect-url" className="text-sm font-medium">
          Connection string
        </label>
        <button
          type="button"
          onClick={() => {
            setValue("");
            setMessage(null);
            setOpen(false);
          }}
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline dark:text-foreground/70"
        >
          Cancel
        </button>
      </div>
      <Input
        id="connect-url"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (text) {
            e.preventDefault();
            apply(text);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply(value);
          }
        }}
        placeholder="postgresql://user:password@host:5432/database"
        className="min-h-11 font-mono text-sm"
        aria-describedby="connect-url-help"
      />
      <p
        id="connect-url-help"
        role={message ? "status" : undefined}
        className={
          message?.tone === "error"
            ? "text-destructive text-xs"
            : message?.tone === "warn"
              ? "text-xs text-amber-700 dark:text-amber-400"
              : "text-muted-foreground text-xs dark:text-foreground/70"
        }
      >
        {message?.text ?? "Paste it to fill in the fields below."}
      </p>
    </div>
  );
};
