import { BookMarked } from "lucide-react";
import type { Skill } from "../lib/skills";
import { PageShell } from "./PageShell";
import { SkillsWorkbench } from "./SkillsView";

/**
 * Library: reusable instruction packages. Call one from the composer to
 * inject it into a conversation.
 *
 * Agents used to be a second tab here - they moved to their own dedicated
 * page (/agents, see AgentBuilderView.tsx) once the agent engine grew real
 * modes (workflow/swarm) and a workspace of its own; authoring an agent
 * warrants more room than a tab, and a shared page meant two things (a
 * plain instruction package and something that acts autonomously) were
 * awkwardly squeezed onto one footing.
 */
export function LibraryView({
  skills,
  onSaveSkills,
}: {
  skills: Skill[];
  onSaveSkills: (skills: Skill[]) => void;
}) {
  return (
    <PageShell
      title="Library"
      icon={<BookMarked size={24} className="shrink-0 text-accent" />}
      maxWidth="max-w-6xl"
      bodyScrolls={false}
      subtitle="Reusable instruction packages. Call one from the composer to inject it into a conversation."
    >
      <SkillsWorkbench skills={skills} onSaveSkills={onSaveSkills} />
    </PageShell>
  );
}
