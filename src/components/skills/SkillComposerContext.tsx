import { createContext, useContext, type ReactNode } from "react";
import type { Skill } from "../../lib/skills";

export interface SkillComposerContextValue {
  skills: Skill[];
  onOpenInfo: (skillId: string) => void;
}

const SkillComposerContext = createContext<SkillComposerContextValue | null>(null);

export function SkillComposerProvider({
  value,
  children,
}: {
  value: SkillComposerContextValue;
  children: ReactNode;
}) {
  return <SkillComposerContext.Provider value={value}>{children}</SkillComposerContext.Provider>;
}

export function useSkillComposerContext(): SkillComposerContextValue {
  const ctx = useContext(SkillComposerContext);
  if (!ctx) throw new Error("useSkillComposerContext must be used within a SkillComposerProvider");
  return ctx;
}

/**
 * A skill token's `getTextContent()` must resolve the skill's live slug (not a
 * frozen copy) so a rename is reflected consistently in what's shown and what
 * gets sent — but that method runs inside Lexical's node tree, not React, so
 * it can't read the SkillComposerContext. Mirrored the same way App.tsx
 * mirrors `conversations` into `conversationsRef` for non-React readers.
 */
export const liveSkillsRegistry: { current: Skill[] } = { current: [] };

export function liveSkillLookup(skillId: string): Skill | undefined {
  return liveSkillsRegistry.current.find((s) => s.id === skillId);
}
