import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  AlertCircle,
  Check,
  ExternalLink,
  GitBranch,
  GitMerge,
  Loader2,
  LogOut,
  Package,
  RefreshCw,
  Settings,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { authClient } from "~/lib/auth-client";
import { orpc } from "~/lib/orpc";
import { cn } from "~/lib/utils";
import { auth } from "~/server/auth";
import type { DependabotPr, Ecosystem, UpdateType } from "~/server/github";
import type { JobStatus, JobView } from "~/server/jobs";

const requireUser = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  if (!request) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user
    ? {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image ?? null,
      }
    : null;
});

export const Route = createFileRoute("/dashboard")({
  beforeLoad: async () => {
    const user = await requireUser();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  loader: async ({ context }) => context.user,
  component: DashboardPage,
});

const ECOSYSTEMS: { value: Ecosystem | "all"; label: string }[] = [
  { value: "all", label: "All ecosystems" },
  { value: "npm", label: "npm" },
  { value: "docker", label: "docker" },
  { value: "github-actions", label: "github actions" },
  { value: "pip", label: "pip" },
  { value: "cargo", label: "cargo" },
  { value: "go", label: "go modules" },
  { value: "maven", label: "maven" },
  { value: "gradle", label: "gradle" },
  { value: "bundler", label: "bundler" },
  { value: "composer", label: "composer" },
  { value: "other", label: "other" },
];

const UPDATE_TYPES: { value: UpdateType | "all"; label: string }[] = [
  { value: "all", label: "All updates" },
  { value: "patch", label: "Patch" },
  { value: "minor", label: "Minor" },
  { value: "major", label: "Major" },
  { value: "unknown", label: "Unknown" },
];

const MERGE_METHODS = [
  { value: "squash", label: "Squash" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase" },
] as const;

function prKey(pr: DependabotPr) {
  return `${pr.repoFullName}#${pr.number}`;
}

function DashboardPage() {
  const user = Route.useLoaderData();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [repoFilter, setRepoFilter] = useState<string>("all");
  const [ecosystemFilter, setEcosystemFilter] = useState<Ecosystem | "all">("all");
  const [updateTypeFilter, setUpdateTypeFilter] = useState<UpdateType | "all">("all");
  const [mergeMethod, setMergeMethod] = useState<"squash" | "merge" | "rebase">("squash");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const prs = useQuery({
    queryKey: ["dependabot", "list"],
    queryFn: () => orpc.dependabot.list(),
    retry: false,
    staleTime: 30_000,
  });

  const jobs = useQuery({
    queryKey: ["jobs", "list"],
    queryFn: () => orpc.jobs.list(),
    retry: false,
    refetchInterval: (q) => {
      const data = q.state.data as JobView[] | undefined;
      if (!data) return 10_000;
      const hasActive = data.some((j) => j.status === "queued" || j.status === "running");
      return hasActive ? 5_000 : 30_000;
    },
  });

  const activeKeys = useMemo(() => new Set(prs.data?.activeKeys ?? []), [prs.data?.activeKeys]);
  const fullPrList = prs.data?.prs ?? [];
  const prList = useMemo(
    () => fullPrList.filter((p) => !activeKeys.has(prKey(p))),
    [fullPrList, activeKeys],
  );
  const watchedCount = prs.data?.watchedCount ?? null;

  const filtered = useMemo(() => {
    return prList.filter((p) => {
      if (repoFilter !== "all" && p.repoFullName !== repoFilter) return false;
      if (ecosystemFilter !== "all" && p.ecosystem !== ecosystemFilter) return false;
      if (updateTypeFilter !== "all" && p.updateType !== updateTypeFilter) return false;
      return true;
    });
  }, [prList, repoFilter, ecosystemFilter, updateTypeFilter]);

  const repoOptions = useMemo(() => {
    const set = new Set(prList.map((p) => p.repoFullName));
    return Array.from(set).sort();
  }, [prList]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.has(prKey(p)));
  const someSelected = filtered.some((p) => selected.has(prKey(p)));

  const stats = useMemo(() => {
    if (!prs.data) return null;
    const ecosystems = new Set(prList.map((p) => p.ecosystem));
    const repos = new Set(prList.map((p) => p.repoFullName));
    return { total: prList.length, repos: repos.size, ecosystems: ecosystems.size };
  }, [prs.data, prList]);

  function toggleAll() {
    if (allFilteredSelected) {
      const next = new Set(selected);
      for (const p of filtered) next.delete(prKey(p));
      setSelected(next);
    } else {
      const next = new Set(selected);
      for (const p of filtered) next.add(prKey(p));
      setSelected(next);
    }
  }

  function toggleOne(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  }

  const selectedPrs = useMemo(() => {
    return prList.filter((p) => selected.has(prKey(p)));
  }, [prList, selected]);

  const enqueueMutation = useMutation({
    mutationFn: async () => {
      if (selectedPrs.length === 0) throw new Error("Nothing selected");
      const byRepo = new Map<string, DependabotPr[]>();
      for (const p of selectedPrs) {
        const key = p.repoFullName;
        const arr = byRepo.get(key) ?? [];
        arr.push(p);
        byRepo.set(key, arr);
      }
      const results = await Promise.allSettled(
        Array.from(byRepo.values()).map((prsInRepo) => {
          const first = prsInRepo[0];
          if (!first) throw new Error("empty repo group");
          return orpc.jobs.enqueue({
            repo: { owner: first.repoOwner, name: first.repoName },
            prs: prsInRepo.map((p) => ({
              number: p.number,
              title: p.title,
              htmlUrl: p.htmlUrl,
            })),
            mergeMethod,
          });
        }),
      );
      const queued = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - queued;
      return { queued, failed, repos: byRepo.size };
    },
    onSuccess: (data) => {
      if (data.failed > 0) {
        toast.warning(`Queued ${data.queued}/${data.repos} repos, ${data.failed} failed to queue`);
      } else {
        toast.success(`Queued ${data.queued} repo${data.queued === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["dependabot", "list"] });
      queryClient.invalidateQueries({ queryKey: ["jobs", "list"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Queue failed");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => orpc.jobs.cancel({ jobId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs", "list"] });
      queryClient.invalidateQueries({ queryKey: ["dependabot", "list"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    },
  });

  const activeJobs = (jobs.data ?? []).filter(
    (j) => j.status === "queued" || j.status === "running",
  );
  const recentDoneJobs = (jobs.data ?? [])
    .filter((j) => j.status === "completed" || j.status === "failed" || j.status === "cancelled")
    .slice(-3);

  async function handleSignOut() {
    await authClient.signOut();
    router.navigate({ to: "/login" });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-md bg-primary text-primary-foreground grid place-items-center text-sm font-semibold">
              D
            </div>
            <div>
              <div className="text-sm font-semibold leading-none">DMO</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Dependabot mass orchestration
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium">{user?.name}</div>
              <div className="text-xs text-muted-foreground">{user?.email}</div>
            </div>
            {user?.image ? (
              <img src={user.image} alt={user.name} className="h-9 w-9 rounded-full border" />
            ) : null}
            <Link
              to="/repos"
              className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent"
              title="Manage watched repositories"
            >
              <Settings className="h-4 w-4" />
              <span className="hidden sm:inline">Repos</span>
              {watchedCount != null ? (
                <Badge variant="outline" className="ml-1 px-1.5 text-xs">
                  {watchedCount}
                </Badge>
              ) : null}
            </Link>
            <Button variant="outline" size="icon" onClick={handleSignOut} title="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-6">
        {activeJobs.length > 0 || recentDoneJobs.length > 0 ? (
          <JobsStrip
            active={activeJobs}
            recent={recentDoneJobs}
            onCancel={(jobId) => cancelMutation.mutate(jobId)}
            cancelling={cancelMutation.isPending ? cancelMutation.variables : null}
          />
        ) : null}

        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            icon={GitBranch}
            label="Open Dependabot PRs"
            value={stats ? stats.total : null}
            loading={prs.isLoading}
          />
          <StatCard
            icon={Package}
            label="Repositories with updates"
            value={stats ? stats.repos : null}
            loading={prs.isLoading}
          />
          <StatCard
            icon={GitMerge}
            label="Selected to merge"
            value={selectedPrs.length}
            loading={false}
            accent={selectedPrs.length > 0}
          />
        </div>

        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <FilterField label="Repository">
                <Select value={repoFilter} onValueChange={setRepoFilter}>
                  <SelectTrigger className="w-[260px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All repositories</SelectItem>
                    {repoOptions.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
              <FilterField label="Ecosystem">
                <Select
                  value={ecosystemFilter}
                  onValueChange={(v) => setEcosystemFilter(v as Ecosystem | "all")}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ECOSYSTEMS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
              <FilterField label="Update type">
                <Select
                  value={updateTypeFilter}
                  onValueChange={(v) => setUpdateTypeFilter(v as UpdateType | "all")}
                >
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UPDATE_TYPES.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
              <div className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => prs.refetch()}
                disabled={prs.isFetching}
              >
                <RefreshCw className={cn("h-4 w-4", prs.isFetching && "animate-spin")} />
                Refresh
              </Button>
            </div>

            <Separator />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Button
                  variant={someSelected ? "secondary" : "ghost"}
                  size="sm"
                  onClick={toggleAll}
                  disabled={filtered.length === 0}
                >
                  {allFilteredSelected ? "Deselect all filtered" : "Select all filtered"}
                </Button>
                {selectedPrs.length > 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {selectedPrs.length} selected
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <Select
                  value={mergeMethod}
                  onValueChange={(v) => setMergeMethod(v as typeof mergeMethod)}
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MERGE_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={() => enqueueMutation.mutate()}
                  disabled={selectedPrs.length === 0 || enqueueMutation.isPending}
                >
                  {enqueueMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GitMerge className="h-4 w-4" />
                  )}
                  Queue merge {selectedPrs.length || ""}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            {prs.isLoading ? (
              <EmptyState icon={Loader2} title="Loading pull requests" spinning />
            ) : prs.isError ? (
              <EmptyState
                icon={AlertCircle}
                title="Failed to load"
                description={(prs.error as Error).message}
              />
            ) : watchedCount === 0 ? (
              <EmptyState
                icon={Settings}
                title="Pick repositories to watch"
                description="DMO only checks repos you opt into. Choose which ones to monitor for Dependabot PRs."
                action={
                  <Link
                    to="/repos"
                    className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    <Settings className="h-4 w-4" />
                    Choose repositories
                  </Link>
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Check}
                title="Nothing to merge"
                description={
                  prList.length === 0
                    ? "No open Dependabot PRs in your watched repositories."
                    : "No PRs match the current filters."
                }
              />
            ) : (
              <PrTable
                prs={filtered}
                selected={selected}
                onToggle={toggleOne}
                allSelected={allFilteredSelected}
                onToggleAll={toggleAll}
              />
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  loading,
  accent,
}: {
  icon: typeof GitBranch;
  label: string;
  value: number | null;
  loading: boolean;
  accent?: boolean;
}) {
  return (
    <Card className={cn(accent && "border-primary/40 bg-primary/5")}>
      <CardContent className="flex items-center gap-4 p-5">
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md",
            accent ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground",
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="text-2xl font-semibold tabular-nums">
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : (value ?? "-")}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PrTable({
  prs,
  selected,
  onToggle,
  allSelected,
  onToggleAll,
}: {
  prs: DependabotPr[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  allSelected: boolean;
  onToggleAll: () => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-10 px-4 py-3">
              <Checkbox
                checked={allSelected}
                onCheckedChange={onToggleAll}
                aria-label="Select all"
              />
            </th>
            <th className="px-2 py-3 text-left">Repository</th>
            <th className="px-2 py-3 text-left">Dependency</th>
            <th className="px-2 py-3 text-left">Update</th>
            <th className="px-2 py-3 text-left">Ecosystem</th>
            <th className="w-8 px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {prs.map((pr) => {
            const key = prKey(pr);
            const isSelected = selected.has(key);
            return (
              <tr
                key={key}
                className={cn(
                  "border-t transition-colors hover:bg-accent/30",
                  isSelected && "bg-primary/5",
                )}
              >
                <td className="px-4 py-3">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => onToggle(key)}
                    aria-label={`Select ${pr.repoFullName}#${pr.number}`}
                  />
                </td>
                <td className="px-2 py-3">
                  <div className="font-medium">{pr.repoFullName}</div>
                  <div className="text-xs text-muted-foreground">#{pr.number}</div>
                </td>
                <td className="px-2 py-3">
                  <div className="font-mono text-xs">{pr.dependency ?? pr.title}</div>
                  {pr.fromVersion && pr.toVersion ? (
                    <div className="text-xs text-muted-foreground font-mono">
                      {pr.fromVersion} → {pr.toVersion}
                    </div>
                  ) : null}
                </td>
                <td className="px-2 py-3">
                  <UpdateBadge type={pr.updateType} />
                </td>
                <td className="px-2 py-3">
                  <Badge variant="outline" className="font-mono">
                    {pr.ecosystem}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <a
                    href={pr.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="Open on GitHub"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UpdateBadge({ type }: { type: UpdateType }) {
  const map: Record<
    UpdateType,
    { variant: "success" | "info" | "warning" | "outline"; label: string }
  > = {
    patch: { variant: "success", label: "patch" },
    minor: { variant: "info", label: "minor" },
    major: { variant: "warning", label: "major" },
    unknown: { variant: "outline", label: "unknown" },
  };
  const { variant, label } = map[type];
  return <Badge variant={variant}>{label}</Badge>;
}

function JobsStrip({
  active,
  recent,
  onCancel,
  cancelling,
}: {
  active: JobView[];
  recent: JobView[];
  onCancel: (jobId: string) => void;
  cancelling: string | null | undefined;
}) {
  const shown = [...active, ...recent];
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <GitMerge className="h-3.5 w-3.5" />
          Merge queue
          {active.length > 0 ? (
            <Badge variant="info" className="ml-1">
              {active.length} active
            </Badge>
          ) : null}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onCancel={onCancel}
              cancelling={cancelling === job.id}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function JobCard({
  job,
  onCancel,
  cancelling,
}: {
  job: JobView;
  onCancel: (jobId: string) => void;
  cancelling: boolean;
}) {
  const active = job.status === "queued" || job.status === "running";
  const done = job.mergedCount + job.failedCount + skippedCount(job);
  const remaining = Math.max(0, job.totalCount - done);
  const pct = job.totalCount === 0 ? 0 : Math.round((done / job.totalCount) * 100);
  const currentItem = active
    ? (job.items.find((i) => i.status === "merging" || i.status === "waiting_rebase") ?? null)
    : null;

  return (
    <div className={cn("rounded-md border p-3 text-sm", jobBorderClass(job.status))}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{job.repoFullName}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <JobStatusBadge status={job.status} />
            <span className="tabular-nums">
              {job.mergedCount}/{job.totalCount} merged
              {job.failedCount > 0 ? `, ${job.failedCount} failed` : null}
            </span>
          </div>
        </div>
        {active ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onCancel(job.id)}
            disabled={cancelling}
            title="Cancel job"
            className="h-7 w-7 shrink-0"
          >
            {cancelling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
          </Button>
        ) : null}
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            "h-full transition-all",
            job.status === "failed" ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      {currentItem ? (
        <div className="mt-2 truncate text-xs text-muted-foreground">
          {currentItem.status === "merging" ? "Merging" : "Waiting for rebase"}: #
          {currentItem.prNumber} {currentItem.title}
        </div>
      ) : active && remaining > 0 ? (
        <div className="mt-2 text-xs text-muted-foreground">{remaining} queued</div>
      ) : null}

      {job.error ? (
        <div className="mt-2 truncate text-xs text-destructive" title={job.error}>
          {job.error}
        </div>
      ) : null}
    </div>
  );
}

function skippedCount(job: JobView): number {
  return job.items.reduce((n, i) => n + (i.status === "skipped" ? 1 : 0), 0);
}

function jobBorderClass(status: JobStatus): string {
  if (status === "running" || status === "queued") return "border-primary/30 bg-primary/[0.04]";
  if (status === "completed") return "border-emerald-600/30 bg-emerald-600/[0.04]";
  if (status === "failed") return "border-destructive/40 bg-destructive/[0.04]";
  return "border-border";
}

function JobStatusBadge({ status }: { status: JobStatus }) {
  const map: Record<
    JobStatus,
    { variant: "success" | "info" | "warning" | "outline"; label: string }
  > = {
    queued: { variant: "info", label: "queued" },
    running: { variant: "info", label: "running" },
    completed: { variant: "success", label: "done" },
    failed: { variant: "warning", label: "failed" },
    cancelled: { variant: "outline", label: "cancelled" },
  };
  const { variant, label } = map[status];
  return <Badge variant={variant}>{label}</Badge>;
}

function EmptyState({
  icon: Icon,
  title,
  description,
  spinning,
  action,
}: {
  icon: typeof Check;
  title: string;
  description?: string;
  spinning?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        <Icon className={cn("h-6 w-6", spinning && "animate-spin")} />
      </div>
      <div className="text-base font-medium">{title}</div>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
