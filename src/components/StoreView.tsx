import { useEffect, useState } from "react";
import { Store } from "lucide-react";
import type { Skill } from "../lib/skills";
import { getPluginState, usePluginStates } from "../lib/pluginStore";
import { PageShell } from "./PageShell";
import { PackageCatalog, PluginCatalog } from "./PluginsView";
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
type StoreTab = "runtimes" | "tools" | "models" | "packages" | "skills";

export function StoreView({
  skills,
  onSaveSkills,
}: {
  skills: Skill[];
  onSaveSkills: (skills: Skill[]) => void;
}) {
  const [tab, setTab] = useState<StoreTab>("runtimes");

  // Python libraries are only meaningful once the runtime that imports them is
  // installed, so the tab appears with it. Installing Python is done on the
  // Runtimes tab right here, so this updates in place.
  const pluginStates = usePluginStates();
  const pythonInstalled = getPluginState(pluginStates, "python").installed;

  // Uninstalling Python while its own tab is open would otherwise leave the
  // Tabs strip with a value none of its options carry.
  useEffect(() => {
    if (!pythonInstalled && tab === "packages") setTab("runtimes");
  }, [pythonInstalled, tab]);

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
            ...(pythonInstalled ? [{ value: "packages" as const, label: "Packages" }] : []),
            { value: "skills", label: "Skills" },
          ]}
        />
      }
    >
      {tab === "skills" ? (
        <SkillStore skills={skills} onSaveSkills={onSaveSkills} />
      ) : tab === "packages" ? (
        <PackageCatalog />
      ) : (
        <PluginCatalog category={tab} />
      )}
    </PageShell>
  );
}
