"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@onecli/ui/components/dialog";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { ChevronLeft, ChevronRight, Ellipsis } from "lucide-react";

interface AuditLogEntry {
  id: string;
  action: string;
  service: string;
  status: string;
  source: string;
  metadata: unknown;
  createdAt: Date;
}

interface AuditLogTableProps {
  logs: AuditLogEntry[];
  page: number;
  totalPages: number;
  total: number;
  hasActiveFilters?: boolean;
  loading?: boolean;
}

const sourceStyle = (source: string) => {
  switch (source) {
    case "cli":
      return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300";
    case "app":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
    default:
      return "";
  }
};

const sourceLabel = (source: string) => {
  switch (source) {
    case "cli":
      return "Agent";
    default:
      return "App";
  }
};

const statusVariant = (status: string) => {
  switch (status) {
    case "success":
      return "default" as const;
    case "denied":
      return "destructive" as const;
    case "error":
      return "destructive" as const;
    default:
      return "secondary" as const;
  }
};

function formatTimestamp(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(date));
}

const SkeletonRows = () => (
  <>
    {Array.from({ length: 3 }).map((_, i) => (
      <TableRow key={i}>
        <TableCell>
          <Skeleton className="h-4 w-32" />
        </TableCell>
        <TableCell>
          <Skeleton className="h-4 w-28" />
        </TableCell>
        <TableCell>
          <Skeleton className="h-4 w-16" />
        </TableCell>
        <TableCell>
          <Skeleton className="h-5 w-14 rounded-full" />
        </TableCell>
        <TableCell>
          <Skeleton className="h-5 w-10 rounded-full" />
        </TableCell>
        <TableCell />
      </TableRow>
    ))}
  </>
);

export function AuditLogTable({
  logs,
  page,
  totalPages,
  total,
  hasActiveFilters,
  loading,
}: AuditLogTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const goToPage = (newPage: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(newPage));
    router.push(`/audit?${params.toString()}`);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Activity</CardTitle>
          {loading ? (
            <Skeleton className="h-4 w-16" />
          ) : (
            <p className="text-muted-foreground text-sm font-normal">
              {total} {total === 1 ? "event" : "events"}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!loading && logs.length === 0 ? (
          <p className="text-muted-foreground py-12 text-center text-sm">
            {hasActiveFilters
              ? "No matching audit logs."
              : "No audit logs yet."}
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <SkeletonRows />
                ) : (
                  logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatTimestamp(log.createdAt)}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {log.action}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <ServiceIcon service={log.service} />
                          <span className="capitalize">{log.service}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(log.status)}>
                          {log.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={sourceStyle(log.source)}
                        >
                          {sourceLabel(log.source)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {log.metadata ? (
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                              >
                                <Ellipsis className="size-4" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>Metadata</DialogTitle>
                              </DialogHeader>
                              <pre className="bg-muted overflow-auto rounded-md p-4 font-mono text-sm">
                                {JSON.stringify(log.metadata, null, 2)}
                              </pre>
                            </DialogContent>
                          </Dialog>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-4">
                <p className="text-muted-foreground text-sm">
                  Page {page} of {totalPages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => goToPage(page - 1)}
                  >
                    <ChevronLeft className="mr-1 size-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => goToPage(page + 1)}
                  >
                    Next
                    <ChevronRight className="ml-1 size-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ServiceIcon({ service }: { service: string }) {
  const cls = "size-4 shrink-0";
  switch (service.toLowerCase()) {
    case "google":
      return (
        <svg className={cls} viewBox="0 0 24 24">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
      );
    case "github":
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
        </svg>
      );
    case "resend":
      return (
        <svg className={cls} viewBox="0 0 1800 1800" fill="currentColor">
          <path d="M1000.46 450C1174.77 450 1278.43 553.669 1278.43 691.282C1278.43 828.896 1174.77 932.563 1000.46 932.563H912.382L1350 1350H1040.82L707.794 1033.48C683.944 1011.47 672.936 985.781 672.935 963.765C672.935 932.572 694.959 905.049 737.161 893.122L908.712 847.244C973.85 829.812 1018.81 779.353 1018.81 713.298C1018.8 632.567 952.745 585.78 871.095 585.78H450V450H1000.46Z" />
        </svg>
      );
    case "onecli":
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="#19BA5D">
          <path
            d="M3 4.5L9.5 10L3 15.5"
            stroke="#19BA5D"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <path
            d="M11 4.5L17.5 10L11 15.5"
            stroke="#19BA5D"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <rect x="3" y="19" width="16" height="2.5" rx="1.25" />
        </svg>
      );
    default:
      return null;
  }
}
