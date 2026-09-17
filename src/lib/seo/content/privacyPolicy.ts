/**
 * The privacy policy, as data.
 *
 * Lifted out of PrivacyPolicyContent.tsx for the same reason as
 * featureGroups.ts: the React view renders it for a visitor and the build-time
 * shell generator renders it for a crawler, and a policy that says two
 * different things depending on whether you run JavaScript is worse than a
 * policy nobody indexes.
 *
 * Takes the brand strings as arguments rather than importing appConfig, so the
 * module stays free of `__APP_CONFIG__` and vite.config.ts can call it during
 * the build. Paragraphs are plain strings; the JSX version used `<br /><br />`
 * for the breaks inside the relay section, which is the same thing said less
 * accessibly.
 */

export interface PolicyLink {
  href: string;
  label: string;
}

export interface PolicySection {
  title: string;
  paragraphs: string[];
  /** Rendered after the paragraphs, as a short list of external references. */
  links?: PolicyLink[];
}

export interface PolicyBrand {
  name: string;
  url: string;
  repoUrl: string;
}

export function privacyPolicySections(brand: PolicyBrand): PolicySection[] {
  const app = brand.name;
  return [
    {
      title: "No backend, no accounts",
      paragraphs: [
        `${app} runs entirely in your browser tab. Nothing here requires an account or sign-up, and no server of ours receives, stores, or logs your conversations, files, or usage. To be exact rather than absolute: a server of ours does serve you this page, so it sees the request for the page itself, the way any web server does. What it does not see is anything you do afterwards - your chats, your files and your settings never leave your browser. There are two narrow exceptions, both described below: the starter prompts on the empty chat screen, and the optional proxy relay, which is used only if you choose to configure a proxy yourself.`,
      ],
    },
    {
      title: "The starter prompts on the empty screen",
      paragraphs: [
        `The suggestions on the empty chat screen refresh once a day, so your browser asks a server of ours for them. That request carries two things: whether it is currently morning, afternoon, evening or night where you are, and up to three yes/no flags for what your selected model can do - whether it can look at images, run tools, and reason at length. They are there so you are not offered a prompt about a photo on a model that cannot see one.`,
        `It carries nothing else. No account, no identifier, no cookie, nothing about your conversations or your files, and not even the date. The list you receive is the same list everyone with the same model abilities receives at that hour; it is not built from anything you have done. ${app} writes the result into your browser's storage so the screen still works offline, and that copy never goes anywhere.`,
        `The prompts themselves are written once a day by ${app}'s server, not per visitor, and your request never causes one to be written - it only reads the copy already in memory. If you would rather your browser made no such request at all, whoever deployed this copy of ${app} can switch the feature off, and a version with it off simply shows the screen without suggestions.`,
      ],
    },
    {
      title: "Everything is stored locally",
      paragraphs: [
        `Conversations, skills, memories, scheduled tasks, and settings are all saved in your browser's own storage (IndexedDB, localStorage, OPFS, and Cache Storage). None of it is transmitted anywhere by ${app}. You are always in control: delete a single conversation, clear all chats, or remove individual memories at any time.`,
      ],
    },
    {
      title: "AI providers are called directly from your browser",
      paragraphs: [
        `When you chat, search, or generate media, the request goes straight from your browser to whichever provider you selected - a keyless provider from the built-in list, your own API-keyed connection, or a self-hosted OmniRoute gateway you configured. Unless you have configured a proxy, ${app} does not relay that traffic through a server of its own, so each provider sees only your own request rather than a shared pool of everyone's traffic. Each provider is responsible for its own privacy practices once your request reaches it.`,
      ],
    },
    {
      title: "The optional proxy relay",
      paragraphs: [
        "If you configure a proxy in Settings, requests take a different path, because a browser cannot speak the protocols real proxies use. They are sent to the same server that served you this page, which opens a tunnel through a Cloudflare worker out to the proxy you chose. Two components, and they see very different things.",
        "The worker sees nothing readable. Your proxy's address and credentials are encrypted before they leave the relay, and everything after that is the encrypted connection to the provider, which the worker has no key for. It exists so that the proxy operator sees a Cloudflare address rather than any machine of ours.",
        "The relay itself does see your requests. It establishes the secure connection to the provider on your behalf, so the request, the response, and any API key it carries pass through it in readable form. There is no way around that: whichever machine assembles the request necessarily sees what is in it. What we can tell you is what it does with them, which is nothing - it keeps no logs, writes nothing to disk, and holds a request only for as long as it takes to forward it. The relay address is also a setting, so you can point it at one you run yourself rather than ours.",
        "None of this applies until you add a proxy. With no proxy configured the relay is never contacted, and your requests go straight from your browser to the provider you picked.",
      ],
    },
    {
      title: "Web search and page reading",
      paragraphs: [
        `Search and "read this page" features fetch results and page text via r.jina.ai and DuckDuckGo's results page, called directly from your browser rather than through a server of ours - or through your proxy, if you configured one, in which case the relay above applies to them too.`,
      ],
    },
    {
      title: "API keys stay on your device",
      paragraphs: [
        "Any provider API key you enter is stored locally in your browser and sent only to the provider it belongs to - directly, or through the relay above if you configured a proxy. Keys and proxy passwords are deliberately excluded from the backup export/import feature, so an exported backup file never contains them.",
      ],
    },
    {
      title: "Local and offline AI models",
      paragraphs: [
        "Models you install to run in-browser (WebLLM on WebGPU, or Chrome's built-in Gemini Nano) run entirely on your own device. Once a model is downloaded, using it for chat requires no further network traffic at all.",
      ],
    },
    {
      title: "Installing skills",
      paragraphs: [
        "Installing a skill or marketplace entry fetches its files from GitHub or jsdelivr directly from your browser, the same way any other page asset would load.",
      ],
    },
    {
      title: "Site analytics",
      paragraphs: [
        `${app}'s public site uses Google Analytics to measure aggregate traffic to ${brand.url} - which pages are visited, roughly how many people, and where from. It works by a script that sets a cookie and reports page views to Google, whose own privacy policy governs what happens to that data on their side.`,
        `It sees which page you loaded, never what you typed. A conversation page reports only that a conversation page was viewed, not which one - the conversation's own address never reaches Google, the same way it never reaches a server of ours. A build with no analytics id configured, which is the default for anyone self-hosting this repository, loads no analytics at all.`,
      ],
    },
    {
      title: "Changes to this policy",
      paragraphs: [
        "This page reflects the app's current, actual behavior rather than a static legal document, so it is updated alongside the app itself. See the change log for a history of what shipped.",
      ],
    },
    {
      title: "Questions",
      paragraphs: [
        `${app} is open source. Review the code yourself or raise a question at the repository, or visit the site.`,
      ],
      links: [
        { href: brand.repoUrl, label: brand.repoUrl },
        { href: brand.url, label: brand.url },
      ],
    },
  ];
}
