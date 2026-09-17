---
name: Bug report
about: Something is broken or behaves differently than documented
title: ''
labels: bug
assignees: ''

---

<!--
Before filing:
- Search open issues first. A "+1" on an existing one is more useful than a duplicate.
- Hard reload (Ctrl/Cmd + Shift + R). A stale service worker explains a surprising number of these.
- If it is WebGPU or a local model, check chrome://gpu or about:support before blaming the app.
- Questions and "how do I" belong in Discussions, not here.
-->

## What happened

<!-- One or two sentences. What you saw. -->

## What you expected

<!-- What should have happened instead. -->

## Steps to reproduce

1.
2.
3.

**Happens every time?** <!-- always / sometimes / saw it once -->

## Where in the app

<!-- Delete the ones that do not apply. -->

Chat / Local models (WebGPU) / Hosted providers / Code runtimes / Agents / Skills /
Memory / Scheduled tasks / Web search / File and document handling / Image, video, audio /
Import and export / PWA and offline / Proxy relay / Self-hosting / UI and theming

## Environment

| | |
|---|---|
| App | <!-- inbrowser.tech, or self-hosted (commit or tag) --> |
| Browser + version | <!-- e.g. Chrome 141, Firefox 145, Safari 26.2 --> |
| OS | <!-- e.g. Windows 11, macOS 15.2, Ubuntu 24.04, Android 15 --> |
| GPU | <!-- e.g. RTX 4070, Apple M2, Intel Iris Xe. Leave blank if not model-related. --> |
| Model | <!-- exact name, and whether it is local (WebLLM / Gemini Nano) or a hosted provider --> |
| Runtime | <!-- only for code execution bugs: Python, C, PHP, ... --> |

## Console output

<!--
Open DevTools (F12) > Console, reproduce the bug, paste what appears.
Scrub API keys and anything personal before pasting.
-->

```
paste here
```

## Screenshot or recording

<!-- Optional, but a 5-second clip usually beats three paragraphs. -->

## Already tried

- [ ] Hard reload / cleared the service worker
- [ ] A fresh browser profile or private window
- [ ] A different model or provider
- [ ] A different browser
- [ ] Searched existing issues

## Anything else

<!-- Extensions or content blockers installed, corporate network, VPN or proxy configured,
     storage nearly full, first time using the app vs. after a long session. -->
