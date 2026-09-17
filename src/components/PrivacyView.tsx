import { Shield } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { PageShell } from "./PageShell";
import { Tabs } from "./ui";
import { PrivacyPolicyContent } from "./PrivacyPolicyContent";
import { DiscoverFeaturesContent } from "./DiscoverFeaturesContent";

type PrivacyTab = "features" | "policy";

const PATH_FOR: Record<PrivacyTab, string> = {
  features: "/features",
  policy: "/privacy",
};

/**
 * Two pages behind one component.
 *
 * The tab used to be `useState`, which meant the feature list - by some distance
 * the most descriptive prose in the app - had no URL of its own, could not be
 * linked to, and could not be indexed. Worse, `/privacy` opened on it, so the
 * one URL that existed showed the wrong document for its own name.
 *
 * The tab is now read from the path, so `/features` and `/privacy` are separate
 * addressable pages with their own title, description and structured data, and
 * switching tabs is a navigation. Nothing about how it looks changed.
 */
export function PrivacyView() {
  const navigate = useNavigate();
  const tab: PrivacyTab = useLocation().pathname === PATH_FOR.features ? "features" : "policy";

  return (
    <PageShell
      title={tab === "features" ? "Discover Features" : "Privacy Policy"}
      icon={<Shield size={24} className="shrink-0 text-accent" />}
      subtitle={
        tab === "features"
          ? "Everything this app can do, with examples."
          : "What happens to your data, in plain language."
      }
      maxWidth="max-w-3xl"
      toolbar={
        <Tabs
          value={tab}
          onChange={(next: PrivacyTab) => navigate(PATH_FOR[next])}
          options={[
            { value: "features", label: "Discover Features" },
            { value: "policy", label: "Privacy Policy" },
          ]}
        />
      }
    >
      {tab === "features" ? <DiscoverFeaturesContent /> : <PrivacyPolicyContent />}
    </PageShell>
  );
}
