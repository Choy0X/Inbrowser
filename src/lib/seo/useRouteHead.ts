import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { applyRouteSeo } from "./head";

/**
 * Retitle the document whenever the client router changes route.
 *
 * Called once, from App. See ./head.ts for what it updates and what it
 * deliberately leaves alone.
 */
export function useRouteHead(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    applyRouteSeo(pathname);
  }, [pathname]);
}
