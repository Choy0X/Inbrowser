import { Section } from "./ui";
import { FEATURE_GROUPS } from "../lib/seo/content/featureGroups";

export function DiscoverFeaturesContent() {
  return (
    <div className="space-y-8">
      {FEATURE_GROUPS.map((group) => (
        <div key={group.category}>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-fg-faint">
            {group.category}
          </h2>
          <div className="space-y-3">
            {group.features.map((feature) => (
              <Section key={feature.name} title={feature.name} description={feature.description}>
                <p className="text-sm text-fg-dim">{feature.example}</p>
              </Section>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
