import type { ReactNode } from "react";

/**
 * The plain text inside a React node tree.
 *
 * Shared by the markdown renderer (reading a citation index out of a badge) and
 * DataTable (reading a cell's value to decide whether a column is numeric and
 * how to sort it). Deliberately shallow: it walks arrays and reads strings and
 * numbers, and returns "" for elements, because both callers work on the output
 * of remark/rehype where the text is always at the top level of the children.
 */
export function flattenNode(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenNode).join("");
  // An element: recurse into its children so a linked or bolded cell still
  // yields its text, which is what makes "is this column numeric?" correct for
  // a table whose numbers happen to be bolded.
  const children = (node as { props?: { children?: ReactNode } })?.props?.children;
  return children === undefined ? "" : flattenNode(children);
}
