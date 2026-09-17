import { DecoratorNode, type EditorConfig, type LexicalEditor, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import { skillSlug } from "../../lib/skills";
import { liveSkillLookup, useSkillComposerContext } from "./SkillComposerContext";

export type SerializedSkillTokenNode = Spread<{ skillId: string }, SerializedLexicalNode>;

function SkillTokenComponent({ skillId }: { skillId: string }) {
  const { skills, onOpenInfo } = useSkillComposerContext();
  const skill = skills.find((s) => s.id === skillId);
  const label = skill ? `/${skillSlug(skill)}` : `/${skillId}`;
  return (
    <button
      type="button"
      contentEditable={false}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenInfo(skillId);
      }}
      className="mx-0.5 inline-flex cursor-pointer select-none items-center rounded px-0.5 align-baseline font-medium text-accent hover:underline"
    >
      {label}
    </button>
  );
}

/**
 * An atomic inline pill for a called skill, e.g. "/code-reviewer". Renders as
 * a clickable link (opens SkillInfoDialog); its serialized text content is
 * always the skill's current slug (see getTextContent), so a rename is
 * reflected identically in both what's shown and what's sent.
 */
export class SkillTokenNode extends DecoratorNode<JSX.Element> {
  __skillId: string;

  static getType(): string {
    return "skill-token";
  }

  static clone(node: SkillTokenNode): SkillTokenNode {
    return new SkillTokenNode(node.__skillId, node.__key);
  }

  static importJSON(serializedNode: SerializedSkillTokenNode): SkillTokenNode {
    return $createSkillTokenNode(serializedNode.skillId);
  }

  exportJSON(): SerializedSkillTokenNode {
    return { ...super.exportJSON(), type: "skill-token", version: 1, skillId: this.__skillId };
  }

  constructor(skillId: string, key?: NodeKey) {
    super(key);
    this.__skillId = skillId;
  }

  createDOM(): HTMLElement {
    return document.createElement("span");
  }

  updateDOM(): false {
    return false;
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  getSkillId(): string {
    return this.__skillId;
  }

  getTextContent(): string {
    const skill = liveSkillLookup(this.__skillId);
    return skill ? `/${skillSlug(skill)}` : `/${this.__skillId}`;
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return <SkillTokenComponent skillId={this.__skillId} />;
  }
}

export function $createSkillTokenNode(skillId: string): SkillTokenNode {
  return new SkillTokenNode(skillId);
}

export function $isSkillTokenNode(node: LexicalNode | null | undefined): node is SkillTokenNode {
  return node instanceof SkillTokenNode;
}
