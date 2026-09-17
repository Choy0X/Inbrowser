import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { trackPageview } from "../analytics";
import { applyRouteSeo } from "./head";

/**
 * Retitle the document whenever the client router changes route, and record
 * a page view for it.
 *
 * Called once, from App. See ./head.ts for what it updates and what it
 * deliberately leaves alone, and ../analytics.ts for why the page view is
 * sent from here rather than left to GA's own automatic one.
 */
export function useRouteHead(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const seo = applyRouteSeo(pathname);
    trackPageview(seo, pathname);
  }, [pathname]);
}
