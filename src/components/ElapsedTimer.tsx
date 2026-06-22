import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function ElapsedTimer({
  startedAt,
  label = "elapsed",
  active = true,
  className,
}: {
  startedAt: string;
  label?: string;
  active?: boolean;
  className?: string;
}) {
  const started = Date.parse(startedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (Number.isNaN(started)) return null;

  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 text-xs font-medium tabular-nums text-muted-foreground",
        active && "border-primary/25 text-foreground",
        className,
      )}
      title={`${label} time`}
    >
      <Clock className="h-3.5 w-3.5" />
      {formatElapsed(now - started)}
    </span>
  );
}
