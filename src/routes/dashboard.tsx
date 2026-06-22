import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ExternalLink,
  FileCode,
  GitBranch,
  GitMerge,
  Loader2,
  LogOut,
  Network,
  Package,
  RefreshCw,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DependencyGraph,
  type GraphInputRepo,
  type GraphOutdatedDep,
} from "~/components/DependencyGraph";
import { ElapsedTimer } from "~/components/ElapsedTimer";
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
import { useLiveUpdates } from "~/lib/live-updates";
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

function buildLlmPrompt(prs: DependabotPr[]): string {
  const byRepo = new Map<string, DependabotPr[]>();
  for (const p of prs) {
    const arr = byRepo.get(p.repoFullName) ?? [];
    arr.push(p);
    byRepo.set(p.repoFullName, arr);
  }

  const sections: string[] = [];
  for (const [repo, list] of byRepo.entries()) {
    list.sort((a, b) => a.number - b.number);
    const lines = list.map((p) => {
      const dep = p.dependency ?? "unknown";
      const versions =
        p.fromVersion && p.toVersion
          ? `${p.fromVersion} to ${p.toVersion} (Dependabot target)`
          : "version not parsed";
      return [
        `- #${p.number} ${dep} (${p.ecosystem}, ${p.updateType}): ${versions}`,
        `  ${p.htmlUrl}`,
        `  title: ${p.title}`,
      ].join("\n");
    });
    sections.push(
      `## ${repo} (${list.length} open Dependabot PR${list.length === 1 ? "" : "s"})\n\n${lines.join("\n")}`,
    );
  }

  const total = prs.length;
  const repoCount = byRepo.size;

  return `I have ${total} open Dependabot PR${total === 1 ? "" : "s"} across ${repoCount} repo${repoCount === 1 ? "" : "s"}. Help me push every dependency to its real latest stable version, not just the version Dependabot proposed. When that is not viable, leave an explicit Dependabot ignore comment so the same PR does not come back next week. Do not merge anything before I confirm the plan.

${sections.join("\n\n")}

How to work through them. Read this fully before touching anything.

## Phase 1: find the real target version

Dependabot's number is a floor, not a target. Training data is stale. For every PR, look up the actual latest published version from the source of truth, not from memory:

- npm: \`bun info <pkg> version\` or \`npm view <pkg> version\` (and \`npm view <pkg> versions --json\` to see the full ladder)
- pypi: \`pip index versions <pkg>\` or pypi.org/project/<pkg>
- cargo: \`cargo search <pkg> --limit 1\` or crates.io
- go modules: \`go list -m -versions <module>\`
- docker: registry tag list, e.g. \`crane ls <image>\` or the registry HTTP API
- github actions: the action repo's GitHub releases (\`gh release list -R <owner>/<repo>\`)
- bundler / composer / maven / gradle: the relevant registry

If the real latest is newer than Dependabot's target, the real latest is your target. Treat Dependabot's PR as a starting branch you will edit, not as the final answer.

For each dependency also collect:
- Upstream release notes between current and real-latest. Read every major and minor entry in that range, not just the top one.
- Coupled packages that must move together. Common families: \`react\` + \`react-dom\` + \`@types/react\` + \`@types/react-dom\`, \`@tanstack/*\` (router, query, start, form move as a set), \`drizzle-orm\` + \`drizzle-kit\`, \`vitest\` + \`@vitest/*\` + \`@vitest/coverage-*\`, \`eslint\` + every \`eslint-*\` plugin, \`@typescript-eslint/*\`, \`vite\` + the framework plugin, \`@types/x\` follows runtime \`x\`. Also check declared peer dependencies in the manifest.
- Whether the new version drops a runtime we still target (Node, Bun, Python, Ruby version floors).
- Whether the new version changes module format (CJS to ESM only is a common trap).

## Phase 2: pick the move for each PR

Every PR gets exactly one of three outcomes.

**A. Push to cutting edge.** The real latest is reachable and the diff is safe. Either:
- Check out the Dependabot branch, edit the manifest to the real latest, regenerate the lockfile, and force-push to the same branch. \`gh pr checkout <num>\` then the lockfile command for the ecosystem (\`bun install\`, \`npm install\`, \`pip install -e .\`, \`cargo update -p <pkg>\`, \`go get <module>@latest && go mod tidy\`).
- If multiple coupled packages need to move as a set, close the individual Dependabot PRs and open one coordinated PR that bumps the whole family to latest. Run the full local test suite before pushing.

**B. Merge as proposed.** Dependabot's target already equals the real latest, the diff is clean, and no coupled package is lagging behind. This is rare for active ecosystems.

**C. Cannot upgrade right now.** Acceptable reasons: requires a peer we cannot bump yet, drops a runtime version we still need, removes an API we depend on, ESM-only flip that breaks the build, known upstream regression, license change, security advisory on the target. "I don't feel like it" is not a reason.

For every C, leave an explicit Dependabot ignore comment so the same PR stops coming back. Pick the narrowest scope that matches the reason:

- \`@dependabot ignore this minor version\` to skip one bad minor and let the next minor through
- \`@dependabot ignore this major version\` to stay on the current major (use this when a major bump is blocked by a peer we cannot move)
- \`@dependabot ignore this dependency\` only if we have intentionally pinned and never want updates from Dependabot for this package

Post the comment and the reason in one go, then close the PR:

\`\`\`
gh pr comment <num> --body $'@dependabot ignore this major version\\n\\nReason: <one line, e.g. requires Node 22, we still target 20>'
gh pr close <num>
\`\`\`

The reason line matters. It is the only thing future-me has to understand why the ignore exists.

## Phase 3: merge order and safety

1. Inside a repo, order by blast radius from low to high: leaf libs first (nothing else depends on them), then shared utilities, then framework cores and toolchain (vite, typescript, bun, drizzle-kit, biome, vitest, tanstack-*). Inside each tier: patch, then minor, then major.
2. Never run two merges in parallel that touch the same lockfile. After every merge, rebase the rest: \`gh pr comment <num> --body "@dependabot rebase"\` or \`gh pr update-branch <num>\`. Wait for CI green on the rebased PR before the next merge.
3. Before merging, verify required status checks with \`gh pr checks <num>\`. A failure that the bump itself produced means move the PR to outcome C and ignore it. A flake means re-run, not merge through.
4. Match the repo's merge policy: \`gh pr merge <num> --squash\` (or --merge / --rebase). If self-approval is required, \`gh pr review <num> --approve\` first.
5. For coordinated multi-package PRs you opened yourself, run build, typecheck, and tests locally before pushing the final commit. Do not rely on CI alone for those.

## Phase 4: report

When done, for each repo produce four lists:
- pushed to latest (PR or coordinated bump, with the final version landed)
- merged as proposed (Dependabot target already equalled latest)
- ignored with comment (dependency, ignore scope, reason, PR closed)
- needs human review (PR, what you tried, what blocked it)

## Now start

Step one before any action: for every PR above, print one line with \`<repo>#<num> <dep>: current=<x> dependabot=<y> latest=<z> -> outcome A/B/C, reason\`. Do not check out any branch, do not comment, do not merge until I confirm that plan.`;
}

function DashboardPage() {
  const user = Route.useLoaderData();
  const router = useRouter();
  const queryClient = useQueryClient();
  useLiveUpdates(["jobs"]);

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
      const entries = Array.from(byRepo.entries());
      const results = await Promise.allSettled(
        entries.map(([, prsInRepo]) => {
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
      const failures = results
        .map((r, idx) => ({ r, repo: entries[idx]?.[0] ?? "" }))
        .filter((x): x is { r: PromiseRejectedResult; repo: string } => x.r.status === "rejected");
      return { queued, failures, repos: byRepo.size };
    },
    onSuccess: (data) => {
      if (data.failures.length > 0) {
        const first = data.failures[0];
        const reason = first
          ? first.r.reason instanceof Error
            ? first.r.reason.message
            : String(first.r.reason)
          : "unknown";
        toast.warning(
          `Queued ${data.queued}/${data.repos} repos. ${data.failures.length} failed: ${reason}`,
        );
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

  async function handleCopyLlmPrompt() {
    const source = selectedPrs.length > 0 ? selectedPrs : filtered;
    if (source.length === 0) {
      toast.error("No PRs to copy");
      return;
    }
    const prompt = buildLlmPrompt(source);
    try {
      await navigator.clipboard.writeText(prompt);
      const scope = selectedPrs.length > 0 ? "selected" : "filtered";
      toast.success(
        `Copied prompt for ${source.length} ${scope} PR${source.length === 1 ? "" : "s"}`,
      );
    } catch {
      toast.error("Clipboard blocked. Check browser permissions.");
    }
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
              to="/orchestrator"
              className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent"
              title="Dependabot config orchestrator"
            >
              <FileCode className="h-4 w-4" />
              <span className="hidden sm:inline">Config</span>
            </Link>
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyLlmPrompt}
                  disabled={filtered.length === 0 && selectedPrs.length === 0}
                  title="Copy a prompt you can paste into Claude Code or another LLM to merge these PRs carefully"
                >
                  <ClipboardCopy className="h-4 w-4" />
                  Copy LLM prompt
                </Button>
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

        {watchedCount && watchedCount > 0 ? (
          <DependencyOverviewSection prList={fullPrList} />
        ) : null}
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
  const queuedCount = job.items.filter((i) => i.status === "queued").length;
  const waitingCount = job.items.filter((i) => i.status === "waiting_rebase").length;
  const startedAt = job.startedAt ?? job.createdAt;

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm transition-colors",
        jobBorderClass(job.status),
        active && "shadow-sm",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{job.repoFullName}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <JobStatusBadge status={job.status} />
            {active ? (
              <ElapsedTimer
                startedAt={startedAt}
                label={job.status === "queued" ? "queued" : "running"}
              />
            ) : null}
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

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            "h-full transition-all",
            job.status === "failed" ? "bg-destructive" : "bg-primary",
            active && done === 0 && "animate-pulse",
          )}
          style={{ width: `${Math.max(active && done === 0 ? 8 : 0, pct)}%` }}
        />
      </div>

      {currentItem ? (
        <div className="mt-3 rounded-md border bg-background/70 px-2 py-1.5 text-xs">
          <div className="font-medium">
            {currentItem.status === "merging" ? "Merging" : "Waiting for rebase"}
          </div>
          <div className="mt-0.5 truncate text-muted-foreground">
            #{currentItem.prNumber} {currentItem.title}
          </div>
        </div>
      ) : active && remaining > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{remaining} remaining</span>
          {queuedCount > 0 ? <span>{queuedCount} queued</span> : null}
          {waitingCount > 0 ? <span>{waitingCount} waiting</span> : null}
        </div>
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

type GraphEcosystem = "npm" | "docker" | "python";

const GRAPH_ECOSYSTEMS: { key: GraphEcosystem; label: string }[] = [
  { key: "npm", label: "npm" },
  { key: "docker", label: "docker" },
  { key: "python", label: "python" },
];

function prEcosystemToGraph(eco: Ecosystem): GraphEcosystem | null {
  if (eco === "npm") return "npm";
  if (eco === "docker") return "docker";
  if (eco === "pip") return "python";
  return null;
}

function DependencyOverviewSection({ prList }: { prList: DependabotPr[] }) {
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [enabledEcosystems, setEnabledEcosystems] = useState<Set<GraphEcosystem>>(
    new Set(["npm", "docker", "python"]),
  );
  const [search, setSearch] = useState("");

  const overview = useQuery({
    queryKey: ["dependencies", "overview"],
    queryFn: () => orpc.dependencies.overview(),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });

  function toggleExpanded() {
    setExpanded((prev) => {
      const next = !prev;
      if (next && !enabled) setEnabled(true);
      return next;
    });
  }

  function toggleEcosystem(key: GraphEcosystem) {
    setEnabledEcosystems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size === 1) return next;
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const repos = overview.data?.repos ?? [];
  const totalDeps = useMemo(() => {
    const set = new Set<string>();
    for (const r of repos) {
      for (const d of r.dependencies) set.add(`${d.ecosystem}:${d.name.toLowerCase()}`);
    }
    return set.size;
  }, [repos]);

  const graphRepos: GraphInputRepo[] = useMemo(
    () =>
      repos.map((r) => ({
        fullName: r.fullName,
        dependencies: r.dependencies.map((d) => ({
          name: d.name,
          version: d.version,
          ecosystem: d.ecosystem,
        })),
      })),
    [repos],
  );

  const outdated: GraphOutdatedDep[] = useMemo(() => {
    const map = new Map<string, GraphOutdatedDep>();
    for (const pr of prList) {
      const eco = prEcosystemToGraph(pr.ecosystem);
      if (!eco || !pr.dependency) continue;
      const key = `${eco}:${pr.dependency.toLowerCase()}`;
      if (!map.has(key)) {
        map.set(key, {
          ecosystem: eco,
          name: pr.dependency,
          fromVersion: pr.fromVersion,
          toVersion: pr.toVersion,
          prUrl: pr.htmlUrl,
          updateType: pr.updateType,
        });
      }
    }
    return Array.from(map.values());
  }, [prList]);

  return (
    <Card>
      <CardContent className="p-0">
        <button
          type="button"
          onClick={toggleExpanded}
          className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-accent/30"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary text-muted-foreground">
              <Network className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold">Dependency overview</div>
              <div className="text-xs text-muted-foreground">
                Force-directed view of every package across your watched repos
                {overview.data ? (
                  <>
                    {" • "}
                    <span className="tabular-nums">{repos.length}</span> repos,{" "}
                    <span className="tabular-nums">{totalDeps}</span> unique deps
                  </>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            {overview.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </div>
        </button>

        {expanded ? (
          <div className="border-t">
            <div className="flex flex-wrap items-center gap-2 p-4">
              <div className="flex items-center gap-1.5">
                {GRAPH_ECOSYSTEMS.map((eco) => {
                  const active = enabledEcosystems.has(eco.key);
                  return (
                    <button
                      key={eco.key}
                      type="button"
                      onClick={() => toggleEcosystem(eco.key)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                        active
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {eco.label}
                    </button>
                  );
                })}
              </div>

              <div className="ml-2 flex-1" />

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter package or repo"
                  className="h-8 w-56 rounded-md border bg-background pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => overview.refetch()}
                disabled={overview.isFetching || !enabled}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", overview.isFetching && "animate-spin")} />
                Refresh
              </Button>
            </div>

            <div className="border-t">
              {overview.isLoading ? (
                <EmptyState icon={Loader2} title="Scanning manifests" spinning />
              ) : overview.isError ? (
                <EmptyState
                  icon={AlertCircle}
                  title="Failed to scan"
                  description={(overview.error as Error).message}
                />
              ) : repos.length === 0 ? (
                <EmptyState
                  icon={Package}
                  title="Nothing to map"
                  description="None of your watched repos contain a package.json, Dockerfile, pyproject.toml, or requirements.txt."
                />
              ) : (
                <DependencyGraph
                  repos={graphRepos}
                  outdated={outdated}
                  ecosystemFilter={enabledEcosystems}
                  search={search}
                  height={640}
                />
              )}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
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
