import { $getRoot, $getSelection, $insertNodes, $isRangeSelection, $nodesOfType, type LexicalEditor, type RangeSelection } from "lexical";
import { $createSkillTokenNode, SkillTokenNode } from "./SkillTokenNode";

export type InsertSkillTokenResult = "inserted" | "duplicate";

/** Skill ids already present as tokens anywhere in the editor, read fresh each call. */
export function activeSkillIdsInEditor(editor: LexicalEditor): Set<string> {
  const ids = new Set<string>();
  editor.getEditorState().read(() => {
    for (const node of $nodesOfType(SkillTokenNode)) ids.add(node.getSkillId());
  });
  return ids;
}

/**
 * The one shared gate for inserting a skill token — both the picker-click
 * path and the typed-token path call through this, so the once-per-skill-
 * per-message rule lives in exactly one place.
 */
export function insertSkillToken(
  editor: LexicalEditor,
  skillId: string,
  fallbackSelection?: RangeSelection | null
): InsertSkillTokenResult {
  if (activeSkillIdsInEditor(editor).has(skillId)) return "duplicate";
  editor.update(() => {
    const node = $createSkillTokenNode(skillId);
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      $insertNodes([node]);
    } else if (fallbackSelection) {
      fallbackSelection.insertNodes([node]);
    } else {
      $getRoot().selectEnd().insertNodes([node]);
    }
  });
  editor.focus();
  return "inserted";
}
