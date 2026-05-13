import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
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
    staleTime: 60_000,
  });

  const filtered = useMemo(() => {
    if (!prs.data) return [];
    return prs.data.filter((p) => {
      if (repoFilter !== "all" && p.repoFullName !== repoFilter) return false;
      if (ecosystemFilter !== "all" && p.ecosystem !== ecosystemFilter) return false;
      if (updateTypeFilter !== "all" && p.updateType !== updateTypeFilter) return false;
      return true;
    });
  }, [prs.data, repoFilter, ecosystemFilter, updateTypeFilter]);

  const repoOptions = useMemo(() => {
    if (!prs.data) return [];
    const set = new Set(prs.data.map((p) => p.repoFullName));
    return Array.from(set).sort();
  }, [prs.data]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.has(prKey(p)));
  const someSelected = filtered.some((p) => selected.has(prKey(p)));

  const stats = useMemo(() => {
    if (!prs.data) return null;
    const ecosystems = new Set(prs.data.map((p) => p.ecosystem));
    const repos = new Set(prs.data.map((p) => p.repoFullName));
    return { total: prs.data.length, repos: repos.size, ecosystems: ecosystems.size };
  }, [prs.data]);

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
    if (!prs.data) return [] as DependabotPr[];
    return prs.data.filter((p) => selected.has(prKey(p)));
  }, [prs.data, selected]);

  const mergeMutation = useMutation({
    mutationFn: async () => {
      if (selectedPrs.length === 0) throw new Error("Nothing selected");
      return orpc.dependabot.approveAndMerge({
        prs: selectedPrs.map((p) => ({
          owner: p.repoOwner,
          repo: p.repoName,
          number: p.number,
        })),
        mergeMethod,
      });
    },
    onSuccess: (data) => {
      if (data.failed > 0) {
        toast.warning(`Merged ${data.merged}/${data.total}, ${data.failed} failed`, {
          description: data.results
            .filter((r) => !r.ok)
            .slice(0, 3)
            .map((r) => `${r.repoFullName}#${r.number}: ${r.error}`)
            .join("\n"),
        });
      } else {
        toast.success(`Merged ${data.merged} pull requests`);
      }
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["dependabot", "list"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Merge failed");
    },
  });

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
            <Button variant="outline" size="icon" onClick={handleSignOut} title="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-6">
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
                  onClick={() => mergeMutation.mutate()}
                  disabled={selectedPrs.length === 0 || mergeMutation.isPending}
                >
                  {mergeMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GitMerge className="h-4 w-4" />
                  )}
                  Approve and merge {selectedPrs.length || ""}
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
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Check}
                title="Nothing to merge"
                description={
                  prs.data && prs.data.length === 0
                    ? "No open Dependabot PRs in your repositories."
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

function EmptyState({
  icon: Icon,
  title,
  description,
  spinning,
}: {
  icon: typeof Check;
  title: string;
  description?: string;
  spinning?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        <Icon className={cn("h-6 w-6", spinning && "animate-spin")} />
      </div>
      <div className="text-base font-medium">{title}</div>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}
