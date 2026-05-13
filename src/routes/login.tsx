import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ShieldCheck, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { authClient } from "~/lib/auth-client";
import { auth } from "~/server/auth";

const getCurrentUser = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  if (!request) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
});

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (user) throw redirect({ to: "/dashboard" });
  },
  component: LoginPage,
});

function LoginPage() {
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (!err) return;
    toast.error(
      err === "oauth"
        ? "GitHub sign-in was cancelled or failed. Please try again."
        : `Sign-in failed: ${err}`,
    );
    params.delete("error");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, []);

  async function handleSignIn() {
    setSigningIn(true);
    const { data, error } = await authClient.signIn.social({
      provider: "github",
      callbackURL: "/dashboard",
      errorCallbackURL: "/login?error=oauth",
    });
    if (error) {
      toast.error(error.message ?? "Could not start GitHub sign-in. Please try again.");
      setSigningIn(false);
      return;
    }
    if (data?.url) {
      window.location.href = data.url;
      return;
    }
    if (!data?.redirect) {
      toast.error("GitHub sign-in did not return a redirect URL.");
      setSigningIn(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-secondary/30 p-12 lg:flex">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <div className="h-8 w-8 rounded-md bg-primary text-primary-foreground grid place-items-center text-sm">
            D
          </div>
          DMO
        </div>
        <div className="space-y-6">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            Dependabot, in bulk.
          </h1>
          <p className="text-base text-muted-foreground max-w-md">
            See every open Dependabot PR across all your repos. Filter by ecosystem and update type,
            then approve and merge them in one click.
          </p>
          <div className="space-y-4 pt-4">
            <Feature icon={Zap} title="One dashboard, every repo">
              Search across all repositories you can access on GitHub.
            </Feature>
            <Feature icon={ShieldCheck} title="Your token, your control">
              Auth via GitHub OAuth. We never store PR data — everything is live from the API.
            </Feature>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Built on TanStack Start, oRPC, Drizzle and better-auth.
        </p>
      </div>
      <div className="flex items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              Use your GitHub account. We request the <code>repo</code> scope so DMO can approve and
              merge pull requests on your behalf.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={handleSignIn} disabled={signingIn} size="lg" className="w-full">
              <GithubMark className="h-4 w-4" />
              {signingIn ? "Redirecting..." : "Continue with GitHub"}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              By signing in you authorize DMO to act on PRs you can already see and merge.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1-.02-1.96-3.2.69-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.11-.75.4-1.26.73-1.55-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.76.11 3.05.73.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.37-5.25 5.65.41.36.78 1.07.78 2.16 0 1.56-.01 2.82-.01 3.21 0 .31.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function Feature({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Zap;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
