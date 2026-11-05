"use client";

import {
  clearChunkErrorReload,
  useChunkErrorReload,
} from "@/hooks/use-chunk-error-reload";

/**
 * Global error boundary for the entire app. Reloads once on a ChunkLoadError
 * after a deploy (see `useChunkErrorReload`).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useChunkErrorReload(error);

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
              clearChunkErrorReload();
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
