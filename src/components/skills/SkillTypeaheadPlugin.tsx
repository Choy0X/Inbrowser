import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { TextNode, type LexicalEditor, type TextNode as TextNodeType } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalTypeaheadMenuPlugin, MenuOption, useBasicTypeaheadTriggerMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { Wand2 } from "lucide-react";
import { resolveSkillSlugs, skillSlug, type Skill } from "../../lib/skills";
import { $createSkillTokenNode } from "./SkillTokenNode";
import { insertSkillToken } from "./insertSkillToken";

class SkillOption extends MenuOption {
  skill: Skill;
  constructor(skill: Skill) {
    super(skillSlug(skill));
    this.skill = skill;
  }
}

const MENU_MARGIN = 12;

/**
 * Positions the menu with `position: fixed`, computed from the anchor's own
 * viewport rect rather than relying on document flow — portaled straight to
 * `document.body` (same pattern as Tooltip.tsx) so it can never affect page
 * layout or push other content down. Flips above the anchor when there isn't
 * room below (whichever side has more space), and clamps horizontally so it
 * never runs off the left/right edge of the viewport.
 *
 * When flipping up, clearance is measured from the WHOLE composer's top edge
 * (`editor.getRootElement()`), not just the caret's own line — a multi-line
 * message means the caret can sit well below the composer's top, and using
 * only the caret line let the menu creep down and cover text being typed.
 */
function useFixedMenuPosition(editor: LexicalEditor, anchorRef: RefObject<HTMLElement | null>, sizingKey: unknown) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const composerTop = editor.getRootElement()?.getBoundingClientRect().top ?? anchorRect.top;

    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const spaceAbove = composerTop;
    const openUp = spaceBelow < menuRect.height + MENU_MARGIN && spaceAbove > spaceBelow;

    const top = openUp
      ? Math.max(MENU_MARGIN, composerTop - menuRect.height - MENU_MARGIN)
      : Math.min(anchorRect.bottom + MENU_MARGIN, window.innerHeight - menuRect.height - MENU_MARGIN);

    let left = anchorRect.left;
    if (left + menuRect.width > window.innerWidth - MENU_MARGIN) {
      left = window.innerWidth - menuRect.width - MENU_MARGIN;
    }
    left = Math.max(MENU_MARGIN, left);

    const maxHeight = Math.max(120, (openUp ? spaceAbove : spaceBelow) - MENU_MARGIN * 2);

    setStyle({ position: "fixed", top, left, maxHeight, visibility: "visible" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, anchorRef, sizingKey]);

  return { menuRef, style };
}

function SkillMenuList({
  editor,
  anchorRef,
  options,
  selectedIndex,
  onHover,
  onPick,
}: {
  editor: LexicalEditor;
  anchorRef: RefObject<HTMLElement | null>;
  options: SkillOption[];
  selectedIndex: number | null;
  onHover: (index: number) => void;
  onPick: (option: SkillOption) => void;
}) {
  const { menuRef, style } = useFixedMenuPosition(editor, anchorRef, options);

  return (
    <div
      ref={menuRef}
      style={style}
      className="z-50 w-72 overflow-y-auto rounded-xl border border-border bg-bg-elevated p-1.5 shadow-lift"
    >
      {options.map((option, i) => (
        <button
          key={option.key}
          type="button"
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(option)}
          className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left ${
            i === selectedIndex ? "bg-bg-hover" : ""
          }`}
        >
          <Wand2 size={16} className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">/{option.key}</span>
            <span className="line-clamp-2 text-xs leading-4 text-fg-faint">{option.skill.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * claude.ai-style "type / to see a live filtered command menu" for skills.
 * Also auto-converts a completed `/<slug> ` typed or pasted as plain text — a
 * defensive path for paste/programmatic text; normal interactive typing is
 * already caught by the menu below before a full token could be typed
 * unassisted.
 */
export function SkillTypeaheadPlugin({ skills }: { skills: Skill[] }) {
  const [editor] = useLexicalComposerContext();
  const [queryString, setQueryString] = useState<string | null>(null);

  const checkForTriggerMatch = useBasicTypeaheadTriggerMatch("/", { minLength: 0 });

  const enabledSkills = useMemo(() => skills.filter((s) => s.enabled), [skills]);
  const bySlug = useMemo(() => resolveSkillSlugs(enabledSkills), [enabledSkills]);

  const options = useMemo(() => {
    const q = (queryString ?? "").trim().toLowerCase();
    const filtered = q
      ? enabledSkills.filter((s) => skillSlug(s).includes(q) || s.name.toLowerCase().includes(q))
      : enabledSkills;
    return filtered.slice(0, 8).map((s) => new SkillOption(s));
  }, [enabledSkills, queryString]);

  const onSelectOption = useCallback(
    (option: SkillOption, nodeToRemove: TextNodeType | null, closeMenu: () => void) => {
      editor.update(() => {
        nodeToRemove?.remove();
      });
      insertSkillToken(editor, option.skill.id);
      closeMenu();
    },
    [editor]
  );

  useEffect(() => {
    return editor.registerNodeTransform(TextNode, (node) => {
      try {
        const text = node.getTextContent();
        const match = /(^|\s)\/([a-z0-9-]+)\s$/i.exec(text);
        if (!match) return;
        const skill = bySlug.get(match[2].toLowerCase());
        if (!skill) return;
        const start = match.index + match[1].length;
        const end = start + 1 + match[2].length; // "/slug", trailing space stays
        const pieces = start > 0 ? node.splitText(start, end) : node.splitText(end);
        const matched = start > 0 ? pieces[1] : pieces[0];
        if (!matched) return;
        matched.insertBefore($createSkillTokenNode(skill.id));
        matched.remove();
      } catch {
        /* never let a transform bug break typing */
      }
    });
  }, [editor, bySlug]);

  if (enabledSkills.length === 0) return null;

  return (
    <LexicalTypeaheadMenuPlugin<SkillOption>
      onQueryChange={setQueryString}
      onSelectOption={onSelectOption}
      triggerFn={checkForTriggerMatch}
      options={options}
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current && options.length > 0
          ? createPortal(
              <SkillMenuList
                editor={editor}
                anchorRef={anchorRef}
                options={options}
                selectedIndex={selectedIndex}
                onHover={setHighlightedIndex}
                onPick={selectOptionAndCleanUp}
              />,
              document.body
            )
          : null
      }
    />
  );
}
