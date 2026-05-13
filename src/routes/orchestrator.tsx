import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CircleAlert,
  ExternalLink,
  FileX,
  GitPullRequest,
  Loader2,
  Play,
  Save,
  Square,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { parse as parseYaml } from "yaml";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Separator } from "~/components/ui/separator";
import { orpc } from "~/lib/orpc";
import { cn } from "~/lib/utils";
import { auth } from "~/server/auth";
import type { RunItemStatus, RunStatus, RunView } from "~/server/orchestrator";

const requireUser = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  if (!request) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user
    ? { id: session.user.id, name: session.user.name, email: session.user.email }
    : null;
});

export const Route = createFileRoute("/orchestrator")({
  beforeLoad: async () => {
    const user = await requireUser();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: OrchestratorPage,
});

const DEFAULT_TEMPLATE = `version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "sunday"
      time: "08:00"
      timezone: "Europe/Berlin"
  - package-ecosystem: "docker"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "sunday"
      time: "08:00"
      timezone: "Europe/Berlin"
`;

type RepoStatus = "missing" | "matches" | "drifted" | "error";

type RepoRow = {
  owner: string;
  name: string;
  fullName: string;
  status: RepoStatus;
  currentContent: string | null;
  currentPath: string | null;
  error: string | null;
};

function classifyRepo(
  repo: {
    owner: string;
    name: string;
    config: { content: string; path: string } | null;
    error: string | null;
  },
  template: string,
): RepoRow {
  const fullName = `${repo.owner}/${repo.name}`;
  if (repo.error) {
    return {
      owner: repo.owner,
      name: repo.name,
      fullName,
      status: "error",
      currentContent: null,
      currentPath: null,
      error: repo.error,
    };
  }
  if (!repo.config) {
    return {
      owner: repo.owner,
      name: repo.name,
      fullName,
      status: "missing",
      currentContent: null,
      currentPath: null,
      error: null,
    };
  }
  const matches = repo.config.content.trim() === template.trim();
  return {
    owner: repo.owner,
    name: repo.name,
    fullName,
    status: matches ? "matches" : "drifted",
    currentContent: repo.config.content,
    currentPath: repo.config.path,
    error: null,
  };
}

function OrchestratorPage() {
  const queryClient = useQueryClient();
  const [draftTemplate, setDraftTemplate] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const template = useQuery({
    queryKey: ["orchestrator", "template"],
    queryFn: () => orpc.orchestrator.getTemplate(),
    staleTime: 60_000,
  });

  const current = useQuery({
    queryKey: ["orchestrator", "current"],
    queryFn: () => orpc.orchestrator.getCurrent(),
    staleTime: 30_000,
  });

  const runs = useQuery({
    queryKey: ["orchestrator", "runs"],
    queryFn: () => orpc.orchestrator.listRuns(),
    refetchInterval: (q) => {
      const data = q.state.data as RunView[] | undefined;
      const hasActive = data?.some((r) => r.status === "queued" || r.status === "running");
      return hasActive ? 3_000 : false;
    },
  });

  const savedTemplate = template.data?.yamlContent ?? null;
  const templateValue = draftTemplate ?? savedTemplate ?? DEFAULT_TEMPLATE;
  const templateDirty = draftTemplate != null && draftTemplate !== (savedTemplate ?? "");

  const templateError = useMemo(() => {
    if (!templateValue.trim()) return "Template cannot be empty";
    try {
      parseYaml(templateValue);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Invalid YAML";
    }
  }, [templateValue]);

  const repoRows = useMemo<RepoRow[]>(() => {
    if (!current.data) return [];
    return current.data.repos.map((r) => classifyRepo(r, templateValue));
  }, [current.data, templateValue]);

  const counts = useMemo(() => {
    const out = { matches: 0, drifted: 0, missing: 0, error: 0 };
    for (const r of repoRows) out[r.status]++;
    return out;
  }, [repoRows]);

  const selectableRows = useMemo(
    () => repoRows.filter((r) => r.status === "drifted" || r.status === "missing"),
    [repoRows],
  );

  const allSelected =
    selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.fullName));

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableRows.map((r) => r.fullName)));
    }
  }

  const saveTemplate = useMutation({
    mutationFn: async () => orpc.orchestrator.saveTemplate({ yamlContent: templateValue }),
    onSuccess: () => {
      toast.success("Template saved");
      setDraftTemplate(null);
      queryClient.invalidateQueries({ queryKey: ["orchestrator", "template"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to save"),
  });

  const startRun = useMutation({
    mutationFn: async () => {
      const repos = Array.from(selected).map((key) => {
        const [owner, name] = key.split("/");
        return { owner: owner ?? "", name: name ?? "" };
      });
      return orpc.orchestrator.startRun({ repos });
    },
    onSuccess: (data) => {
      toast.success(`Queued sync for ${data.count} repos`);
      setSelected(new Set());
      setShowConfirm(false);
      setConfirmText("");
      queryClient.invalidateQueries({ queryKey: ["orchestrator", "runs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to start run"),
  });

  const cancelRun = useMutation({
    mutationFn: async (runId: string) => orpc.orchestrator.cancelRun({ runId }),
    onSuccess: () => {
      toast.success("Run cancelled");
      queryClient.invalidateQueries({ queryKey: ["orchestrator", "runs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to cancel"),
  });

  const canStartRun =
    selected.size > 0 &&
    !templateError &&
    !templateDirty &&
    savedTemplate != null &&
    !startRun.isPending;

  function onClickSync() {
    if (selected.size === 0) return;
    setShowConfirm(true);
  }

  const confirmPhrase = `sync ${selected.size}`;
  const confirmValid = confirmText.trim().toLowerCase() === confirmPhrase;

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <Link
              to="/dashboard"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Back to dashboard"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <div className="text-sm font-semibold leading-none">Config orchestrator</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Sync a single dependabot.yml across your watched repositories
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 space-y-6">
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">Template</div>
                  <div className="text-xs text-muted-foreground">
                    This YAML is committed as <code>.github/dependabot.yml</code> on every selected
                    repo.
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => saveTemplate.mutate()}
                  disabled={!templateDirty || !!templateError || saveTemplate.isPending}
                >
                  {saveTemplate.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save
                </Button>
              </div>
              <textarea
                value={templateValue}
                onChange={(e) => setDraftTemplate(e.target.value)}
                spellCheck={false}
                className="min-h-[360px] w-full rounded-md border bg-background p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {templateError ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-none" />
                  <span className="break-all">{templateError}</span>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  Validated as YAML. Not validated against GitHub's Dependabot schema.
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Watched repositories</div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    queryClient.invalidateQueries({ queryKey: ["orchestrator", "current"] })
                  }
                  disabled={current.isFetching}
                >
                  {current.isFetching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                  Refresh
                </Button>
              </div>
              <div className="grid grid-cols-4 gap-2 text-xs">
                <StatBadge label="match" value={counts.matches} tone="ok" />
                <StatBadge label="drift" value={counts.drifted} tone="warn" />
                <StatBadge label="missing" value={counts.missing} tone="info" />
                <StatBadge label="error" value={counts.error} tone="bad" />
              </div>
              <Separator />
              {current.isLoading ? (
                <EmptyRow icon={Loader2} text="Loading repositories" spinning />
              ) : current.isError ? (
                <EmptyRow icon={AlertCircle} text={(current.error as Error).message} />
              ) : repoRows.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No watched repositories yet.{" "}
                  <Link to="/repos" className="underline">
                    Pick some
                  </Link>
                  .
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{selected.size} selected</span>
                    <button
                      type="button"
                      onClick={toggleAll}
                      disabled={selectableRows.length === 0}
                      className="underline disabled:opacity-50"
                    >
                      {allSelected ? "Clear" : `Select all (${selectableRows.length})`}
                    </button>
                  </div>
                  <ul className="divide-y rounded-md border">
                    {repoRows.map((r) => (
                      <RepoListRow
                        key={r.fullName}
                        row={r}
                        templateValue={templateValue}
                        selected={selected.has(r.fullName)}
                        onToggle={() => toggle(r.fullName)}
                        expanded={expanded === r.fullName}
                        onToggleExpand={() =>
                          setExpanded(expanded === r.fullName ? null : r.fullName)
                        }
                      />
                    ))}
                  </ul>
                </>
              )}
              <Separator />
              <div className="space-y-2">
                {showConfirm ? (
                  <ConfirmSyncBox
                    confirmPhrase={confirmPhrase}
                    confirmText={confirmText}
                    onChange={setConfirmText}
                    onCancel={() => {
                      setShowConfirm(false);
                      setConfirmText("");
                    }}
                    onConfirm={() => startRun.mutate()}
                    valid={confirmValid}
                    pending={startRun.isPending}
                  />
                ) : (
                  <Button
                    onClick={onClickSync}
                    disabled={!canStartRun}
                    className="w-full"
                    size="lg"
                  >
                    {selected.size > 0 ? `Sync ${selected.size} repos` : "Select repos to sync"}
                  </Button>
                )}
                {templateDirty ? (
                  <div className="text-xs text-amber-600">Save the template before syncing.</div>
                ) : null}
                {!savedTemplate ? (
                  <div className="text-xs text-muted-foreground">
                    Save a template first. The first save is what gets committed.
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="text-sm font-semibold">Recent runs</div>
            {runs.isLoading ? (
              <EmptyRow icon={Loader2} text="Loading" spinning />
            ) : !runs.data || runs.data.length === 0 ? (
              <div className="text-xs text-muted-foreground">No runs yet.</div>
            ) : (
              <ul className="divide-y rounded-md border">
                {runs.data.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    onCancel={() => cancelRun.mutate(run.id)}
                    cancelling={cancelRun.isPending && cancelRun.variables === run.id}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function StatBadge({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "info" | "bad";
}) {
  const colors = {
    ok: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
    warn: "bg-amber-500/10 text-amber-600 border-amber-500/30",
    info: "bg-sky-500/10 text-sky-600 border-sky-500/30",
    bad: "bg-rose-500/10 text-rose-600 border-rose-500/30",
  } as const;
  return (
    <div className={cn("rounded-md border px-2 py-1.5 text-center", colors[tone])}>
      <div className="text-sm font-semibold leading-none">{value}</div>
      <div className="text-[10px] uppercase tracking-wide opacity-70 mt-1">{label}</div>
    </div>
  );
}

function RepoListRow({
  row,
  templateValue,
  selected,
  onToggle,
  expanded,
  onToggleExpand,
}: {
  row: RepoRow;
  templateValue: string;
  selected: boolean;
  onToggle: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const selectable = row.status === "drifted" || row.status === "missing";
  return (
    <li className={cn("text-sm", selected && "bg-primary/5")}>
      <div className="flex items-center gap-3 px-3 py-2">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          disabled={!selectable}
          aria-label={`Select ${row.fullName}`}
        />
        <button type="button" onClick={onToggleExpand} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{row.fullName}</span>
            <StatusBadge status={row.status} />
          </div>
          {row.error ? (
            <div className="mt-0.5 truncate text-xs text-rose-600">{row.error}</div>
          ) : null}
        </button>
      </div>
      {expanded ? (
        <div className="border-t bg-muted/30 px-3 py-3">
          <DiffPanes
            currentContent={row.currentContent}
            currentPath={row.currentPath}
            templateContent={templateValue}
          />
        </div>
      ) : null}
    </li>
  );
}

function StatusBadge({ status }: { status: RepoStatus }) {
  if (status === "matches") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-600">
        <Check className="h-3 w-3" />
        match
      </Badge>
    );
  }
  if (status === "drifted") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600">
        drift
      </Badge>
    );
  }
  if (status === "missing") {
    return (
      <Badge variant="outline" className="gap-1 border-sky-500/40 text-sky-600">
        <FileX className="h-3 w-3" />
        missing
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 border-rose-500/40 text-rose-600">
      <AlertCircle className="h-3 w-3" />
      error
    </Badge>
  );
}

function DiffPanes({
  currentContent,
  currentPath,
  templateContent,
}: {
  currentContent: string | null;
  currentPath: string | null;
  templateContent: string;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {currentPath ?? "current (none)"}
        </div>
        <pre className="max-h-64 overflow-auto rounded border bg-background p-2 text-xs leading-5">
          {currentContent ?? "(no file)"}
        </pre>
      </div>
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          template
        </div>
        <pre className="max-h-64 overflow-auto rounded border bg-background p-2 text-xs leading-5">
          {templateContent}
        </pre>
      </div>
    </div>
  );
}

function ConfirmSyncBox({
  confirmPhrase,
  confirmText,
  onChange,
  onCancel,
  onConfirm,
  valid,
  pending,
}: {
  confirmPhrase: string;
  confirmText: string;
  onChange: (s: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  valid: boolean;
  pending: boolean;
}) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
      <div className="text-xs">
        This will open a pull request on every selected repository. Type{" "}
        <code className="font-mono text-foreground">{confirmPhrase}</code> to confirm.
      </div>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => onChange(e.target.value)}
        placeholder={confirmPhrase}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" onClick={onConfirm} disabled={!valid || pending} className="flex-1">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Open pull requests
        </Button>
      </div>
    </div>
  );
}

function RunRow({
  run,
  onCancel,
  cancelling,
}: {
  run: RunView;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const active = run.status === "queued" || run.status === "running";
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <RunStatusBadge status={run.status} />
            <span className="text-xs text-muted-foreground">
              {new Date(run.createdAt).toLocaleString()}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {run.syncedCount} synced, {run.skippedCount} skipped, {run.failedCount} failed of{" "}
            {run.totalCount}
          </div>
          {run.error ? <div className="mt-0.5 text-xs text-rose-600">{run.error}</div> : null}
        </div>
        {active ? (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={cancelling}>
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cancel"}
          </Button>
        ) : null}
      </div>
      {run.items.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {run.items.map((item) => (
            <li key={item.repoFullName} className="flex items-center gap-2 text-xs">
              <ItemStatusBadge status={item.status} />
              <span className="truncate font-medium">{item.repoFullName}</span>
              {item.prUrl ? (
                <a
                  href={item.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
                >
                  <GitPullRequest className="h-3 w-3" />#{item.prNumber}
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              ) : null}
              {item.error ? <span className="truncate text-rose-600">{item.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { label: string; cls: string }> = {
    queued: { label: "queued", cls: "border-sky-500/40 text-sky-600" },
    running: { label: "running", cls: "border-amber-500/40 text-amber-600" },
    completed: { label: "completed", cls: "border-emerald-500/40 text-emerald-600" },
    failed: { label: "failed", cls: "border-rose-500/40 text-rose-600" },
    cancelled: { label: "cancelled", cls: "border-muted text-muted-foreground" },
  };
  const m = map[status];
  return (
    <Badge variant="outline" className={cn("gap-1", m.cls)}>
      {m.label}
    </Badge>
  );
}

function ItemStatusBadge({ status }: { status: RunItemStatus }) {
  const map: Record<RunItemStatus, string> = {
    queued: "border-muted text-muted-foreground",
    syncing: "border-amber-500/40 text-amber-600",
    synced: "border-emerald-500/40 text-emerald-600",
    pr_open: "border-sky-500/40 text-sky-600",
    no_change: "border-muted text-muted-foreground",
    failed: "border-rose-500/40 text-rose-600",
    skipped: "border-muted text-muted-foreground",
  };
  const label = status.replace("_", " ");
  return (
    <Badge variant="outline" className={cn("gap-1", map[status])}>
      {label}
    </Badge>
  );
}

function EmptyRow({
  icon: Icon,
  text,
  spinning,
}: {
  icon: typeof AlertCircle;
  text: string;
  spinning?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
      <Icon className={cn("h-4 w-4", spinning && "animate-spin")} />
      <span>{text}</span>
    </div>
  );
}
