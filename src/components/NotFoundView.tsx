import { FileQuestion } from "lucide-react";
import { PageShell } from "./PageShell";
import { Section } from "./ui";
import { NavLink } from "./ui/NavLink";
import { indexableRoutes } from "../lib/seo/routeTable";

/**
 * A real 404 page.
 *
 * The catch-all route used to be `<Navigate to="/" replace />`, which sent every
 * mistyped URL to the homepage. Paired with a server that answered 200 for any
 * unknown path, that is a textbook soft 404: the URL looks like a working page,
 * so it stays crawlable and considered for indexing indefinitely, and a visitor
 * who followed a broken link is silently told nothing was wrong. The server now
 * returns a real 404 status and this is what it returns it with.
 */
export function NotFoundView() {
  return (
    <PageShell
      title="Page not found"
      icon={<FileQuestion size={24} className="shrink-0 text-accent" />}
      subtitle="That page does not exist. It may have been renamed or removed."
    >
      <div className="space-y-3">
        {indexableRoutes().map((route) => (
          <Section key={route.path} title={route.h1} description={route.description}>
            <NavLink
              to={route.path}
              className="text-sm text-accent underline underline-offset-2 hover:text-accent/80"
            >
              {route.path}
            </NavLink>
          </Section>
        ))}
      </div>
    </PageShell>
  );
}
