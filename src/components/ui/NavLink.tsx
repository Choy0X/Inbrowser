import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

/**
 * An internal link that is a real link.
 *
 * Every navigation in this app used to be a `<button onClick={navigate(...)}>`.
 * Three things follow from that, and all three were true here:
 *
 *   - a crawler landing on any page found no `<a href>` at all, so no other
 *     route was discoverable and the site had no link graph;
 *   - middle-click, Cmd-click and Ctrl-click did nothing, because there is no
 *     URL for the browser to open in a new tab;
 *   - the status bar showed no destination on hover, and screen readers
 *     announced a button rather than a link.
 *
 * So this renders an anchor with a real `href` and intercepts only the plain
 * left-click, letting the client router handle that one. Modifier-clicks and
 * anything that is not the primary button fall through to the browser
 * untouched, which is what makes "open in new tab" work again.
 */
export interface NavLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
  children: ReactNode;
}

export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink(
  { to, children, onClick, ...rest },
  ref,
) {
  const navigate = useNavigate();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // Let the browser own anything that is not a plain left-click: a modifier
    // means the visitor asked for a new tab or window, and only button 0 is a
    // primary click at all.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(to);
  };

  return (
    <a ref={ref} href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
});
