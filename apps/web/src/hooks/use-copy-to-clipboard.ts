import { useState, useCallback } from "react";

// navigator.clipboard only exists in secure contexts; plain-HTTP self-hosts
// (a supported deployment) get the execCommand fallback instead of a silent
// no-op. `copied` flips — and `copy` resolves true — only when a copy path
// actually ran, so callers can gate their own feedback honestly.
const fallbackCopy = (text: string): boolean => {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand("copy");
  } finally {
    el.remove();
  }
};

export function useCopyToClipboard(timeout = 2000) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(text);
        } else if (!fallbackCopy(text)) {
          return false;
        }
      } catch {
        return false;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), timeout);
      return true;
    },
    [timeout],
  );

  return { copied, copy };
}
