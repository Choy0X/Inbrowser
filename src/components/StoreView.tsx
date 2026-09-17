import { useState } from "react";
import { Store } from "lucide-react";
import type { Skill } from "../lib/skills";
import { PageShell } from "./PageShell";
import { PluginCatalog } from "./PluginsView";
import { SkillStore } from "./SkillStore";
import { Tabs } from "./ui";

/**
 * One store.
 *
 * Installing used to be split across two unrelated pages - language runtimes
 * and local models on /plugins, marketplace skills buried in a tab on /skills -
 * so "where do I get more?" had two different answers. Everything installable
 * now lives here under categories; authoring stays on /library.
 */
type StoreTab = "runtimes" | "tools" | "models" | "skills";

export function StoreView({
  skills,
  onSaveSkills,
}: {
  skills: Skill[];
  onSaveSkills: (skills: Skill[]) => void;
}) {
  const [tab, setTab] = useState<StoreTab>("runtimes");

  return (
    <PageShell
      title="Store"
      icon={<Store size={24} className="shrink-0 text-accent" />}
      maxWidth="max-w-4xl"
      bodyScrolls={false}
      subtitle="Language runtimes, tools, local models and skills. Everything installs into this browser and runs on your device."
      toolbar={
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: "runtimes", label: "Runtimes" },
            { value: "tools", label: "Tools" },
            { value: "models", label: "Models" },
            { value: "skills", label: "Skills" },
          ]}
        />
      }
    >
      {tab === "skills" ? (
        <SkillStore skills={skills} onSaveSkills={onSaveSkills} />
      ) : (
        <PluginCatalog category={tab} />
      )}
    </PageShell>
  );
}
