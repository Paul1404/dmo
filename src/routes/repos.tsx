import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ArrowLeft, Check, GitBranch, Loader2, Lock, Save, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Separator } from "~/components/ui/separator";
import { orpc } from "~/lib/orpc";
import { cn } from "~/lib/utils";
import { auth } from "~/server/auth";

const requireUser = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  if (!request) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user
    ? { id: session.user.id, name: session.user.name, email: session.user.email }
    : null;
});

export const Route = createFileRoute("/repos")({
  beforeLoad: async () => {
    const user = await requireUser();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: ReposPage,
});

function repoKey(owner: string, name: string) {
  return `${owner}/${name}`;
}

function ReposPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Set<string> | null>(null);

  const accessible = useQuery({
    queryKey: ["repos", "accessible"],
    queryFn: () => orpc.repos.list(),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const watched = useQuery({
    queryKey: ["repos", "watched"],
    queryFn: () => orpc.repos.getWatched(),
    retry: false,
    staleTime: 60_000,
  });

  const initialSelected = useMemo(() => {
    if (!watched.data) return null;
    return new Set(watched.data.map((r) => repoKey(r.owner, r.name)));
  }, [watched.data]);

  const selected = draft ?? initialSelected ?? new Set<string>();

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setDraft(next);
  }

  const filtered = useMemo(() => {
    if (!accessible.data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return accessible.data;
    return accessible.data.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [accessible.data, search]);

  const dirty =
    draft != null &&
    initialSelected != null &&
    (draft.size !== initialSelected.size || Array.from(draft).some((k) => !initialSelected.has(k)));

  const save = useMutation({
    mutationFn: async () => {
      const repos = Array.from(selected).map((key) => {
        const [owner, name] = key.split("/");
        return { owner: owner ?? "", name: name ?? "" };
      });
      return orpc.repos.setWatched({ repos });
    },
    onSuccess: (data) => {
      toast.success(`Watching ${data.count} ${data.count === 1 ? "repository" : "repositories"}`);
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ["repos", "watched"] });
      queryClient.invalidateQueries({ queryKey: ["dependabot", "list"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    },
  });

  function selectAllFiltered() {
    const next = new Set(selected);
    for (const r of filtered) next.add(repoKey(r.owner, r.name));
    setDraft(next);
  }

  function clearAll() {
    setDraft(new Set());
  }

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <Link
              to="/dashboard"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Back to dashboard"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <div className="text-sm font-semibold leading-none">Watched repositories</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Pick the repos you want DMO to check for Dependabot PRs
              </div>
            </div>
          </div>
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending} size="sm">
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save {selected.size > 0 ? `(${selected.size})` : ""}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-6">
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[240px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by owner or name"
                  className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={selectAllFiltered}
                disabled={filtered.length === 0}
              >
                Select all {search ? "filtered" : ""}
              </Button>
              <Button variant="ghost" size="sm" onClick={clearAll} disabled={selected.size === 0}>
                Clear all
              </Button>
            </div>
            <Separator />
            <div className="text-xs text-muted-foreground">
              {selected.size} selected
              {accessible.data ? ` of ${accessible.data.length} accessible` : ""}
              {dirty ? " (unsaved)" : ""}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            {accessible.isLoading || watched.isLoading ? (
              <EmptyState icon={Loader2} title="Loading repositories" spinning />
            ) : accessible.isError ? (
              <EmptyState
                icon={GitBranch}
                title="Failed to load repositories"
                description={(accessible.error as Error).message}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={GitBranch}
                title="No repositories match"
                description={
                  accessible.data && accessible.data.length === 0
                    ? "GitHub returned no repositories. Check your token scopes."
                    : "Try a different search."
                }
              />
            ) : (
              <ul className="divide-y">
                {filtered.map((r) => {
                  const key = repoKey(r.owner, r.name);
                  const checked = selected.has(key);
                  const id = `repo-${key}`;
                  return (
                    <li
                      key={key}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3 hover:bg-accent/30",
                        checked && "bg-primary/5",
                      )}
                    >
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={() => toggle(key)}
                        aria-label={`Watch ${r.fullName}`}
                      />
                      <label htmlFor={id} className="flex-1 min-w-0 cursor-pointer">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{r.fullName}</span>
                          {r.private ? (
                            <Badge variant="outline" className="gap-1">
                              <Lock className="h-3 w-3" />
                              private
                            </Badge>
                          ) : null}
                        </div>
                      </label>
                      {checked ? <Check className="h-4 w-4 text-primary" /> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => router.navigate({ to: "/dashboard" })}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save {selected.size > 0 ? `(${selected.size})` : ""}
          </Button>
        </div>
      </main>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  spinning,
}: {
  icon: typeof GitBranch;
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
