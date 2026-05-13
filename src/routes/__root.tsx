import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { Toaster } from "sonner";
import appCss from "~/styles/app.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "DMO — Dependabot Mass Orchestration" },
      {
        name: "description",
        content:
          "Mass-approve and merge Dependabot pull requests across all your GitHub repositories from one dashboard.",
      },
      { name: "color-scheme", content: "light dark" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootLayout,
});

function RootLayout() {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <Outlet />
        <Toaster richColors position="bottom-right" />
        <Scripts />
      </body>
    </html>
  );
}
