"use client";

import { useEffect } from "react";

/**
 * Global error boundary for the entire app.
 *
 * Handles ChunkLoadError gracefully — after a deployment, cached HTML may
 * reference old JS chunks that no longer exist. A single reload fetches
 * the new HTML with correct chunk references. Session storage prevents
 * infinite reload loops.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (
      error.name === "ChunkLoadError" ||
      error.message?.includes("ChunkLoadError")
    ) {
      const key = "chunk-error-reloaded";
      const alreadyReloaded = sessionStorage.getItem(key);

      if (!alreadyReloaded) {
        sessionStorage.setItem(key, "1");
        window.location.reload();
        return;
      }

      // Clear flag so future deploys can retry
      sessionStorage.removeItem(key);
    }
  }, [error]);

  return (
    <html>
      <body>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            fontFamily: "system-ui, sans-serif",
            gap: "16px",
          }}
        >
          <h2 style={{ fontSize: "18px", fontWeight: 600 }}>
            Something went wrong
          </h2>
          <p style={{ fontSize: "14px", color: "#666" }}>
            A new version may have been deployed. Try refreshing the page.
          </p>
          <button
            onClick={() => {
              sessionStorage.removeItem("chunk-error-reloaded");
              reset();
            }}
            style={{
              padding: "8px 16px",
              fontSize: "14px",
              borderRadius: "6px",
              border: "1px solid #ddd",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
