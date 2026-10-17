<p align="center">
  <img src="../build/icon.png" width="112" height="112" alt="Cherry Studio icon">
</p>

<h1 align="center">Cherry Studio · metrovoc build</h1>

<p align="center">
  An unofficial macOS build of <a href="https://github.com/CherryHQ/cherry-studio">Cherry Studio</a>
  with reworked Quick Assistant and Selection Assistant windows.
</p>

<p align="center">
  <a href="https://github.com/metrovoc/cherry-studio/releases/latest"><b>Download</b></a> ·
  <a href="https://docs.cherry-ai.com/docs/en-us">User guide</a> ·
  <a href="https://github.com/metrovoc/cherry-studio/issues">Issues</a> ·
  <a href="../README.md">Upstream README</a>
</p>

> [!NOTE]
> This build is not affiliated with or endorsed by CherryHQ. Please report problems with it here, not to the upstream project.

## What's different

Everything not listed here is upstream Cherry Studio. Each release is rebased on the current upstream `main` branch, so it can include upstream changes that are not in an official release yet.

**Quick Assistant**

- Conversations are saved to history and can be continued later. You can browse saved conversations and switch assistants without leaving the panel.
- Works as a transient macOS panel: it closes when you click outside it, keeps keyboard and input-method focus, and holds your scroll position while a reply streams in.

**Selection Assistant**

- Result conversations can be saved, and the toolbar can be customized.
- Shortcuts dismiss all result windows at once, and shortcut settings take less space.
- Result windows stay above the app you selected text in, including full-screen Spaces, without bringing the main window forward.

**Models**

- GPT-6 Sol, GPT-6.1 Sol and GPT-6 Luna for OpenAI and OpenAI Codex, with their reasoning levels, fast mode and built-in web search.
- The model catalog is published from this fork, so its models are kept when upstream updates the catalog.

**Reliability**

- With retries enabled, requests recover from network changes that happen before a response starts.

## Install

Requires macOS 13 or later on Apple Silicon.

1. Download the DMG from the [latest release](https://github.com/metrovoc/cherry-studio/releases/latest).
2. Drag Cherry Studio into Applications.

Builds are signed with a Developer ID and notarized by Apple. Updates arrive through the app's usual update notification.

### Switching from the official app

This build uses the same app identity as the official Cherry Studio. Installing it replaces the official app and keeps your existing data. From then on, updates come from this fork.

- **Back up first.** Use Settings → Data before switching.
- **Grant permissions again.** The code signature is different, so macOS asks again for permissions such as Accessibility, which the Selection Assistant needs.
- **Switching back.** You can reinstall the official app at any time. An official release older than this build's upstream base may not be able to open data this build has upgraded, so restore your backup if it fails to start.

## Versions

Version numbers continue upstream's 2.x line but are assigned independently. This build's 2.1.10 is not the same as an official 2.1.10. Starting with 2.1.10, each release's notes link the upstream commit it is based on.

## Reporting problems

- **Problems with this build:** use [this fork's issues](https://github.com/metrovoc/cherry-studio/issues/new/choose) and include the version shown in Settings → About.
- **Problems that also happen in the official app:** report them [upstream](https://github.com/CherryHQ/cherry-studio/issues).
- **Security issues:** report them privately through [GitHub vulnerability reporting](https://github.com/metrovoc/cherry-studio/security/advisories/new).

## Maintaining this fork

| Branch | Role |
| --- | --- |
| `downstream` | Default branch. Rebased on upstream `main`; every release is built from it. |
| `main` | Exact mirror of upstream `main`. Never commit to it. |
| `x-files/downstream-provider-registry` | Published model catalog, pinned by `scripts/release/catalog-pin.json`. |
| Other branches | Contributions sent upstream as pull requests, based on `main`. |

These parts belong to the fork. Keep them through every rebase, and keep the fork's side when they conflict with upstream:

- **Fork documentation and issue intake:** `.github/README.md` and `.github/ISSUE_TEMPLATE/`, which replaces upstream's templates.
- **Release pipeline:** `.github/workflows/downstream-release.yml` and `scripts/release/`; see [the release guide](../scripts/release/README.md).
- **Update feed:**
  - The `publish` settings in `electron-builder.yml` and `dev-app-update.yml` point at this repository.
  - `RELEASE_HISTORY_URL` in `src/main/services/AppUpdaterService.ts` does too.
  - Release notes in `electron-builder.yml` keep both English and Chinese sections, because the app requires them.
- **Fork links:**
  - The repository and release links in `src/renderer/pages/settings/AboutSettings/AboutSettings.tsx`, along with its unofficial-build notice.
  - `FEEDBACK_GITHUB_URL` in `src/renderer/components/feedback/FeedbackDialog.tsx`.
  - The feedback and releases items in `src/main/services/AppMenuService.ts`.
- **macOS window behavior:** `packages/macos-panel/` and `patches/selection-hook@*.patch`.
- **Model catalog:** fork models in `packages/provider-registry/` and catalog publishing in `scripts/publishRegistryCatalog.js`.

Repository settings that live outside Git:

- Only the `CI` and `Downstream macOS release` workflows are enabled. When a rebase brings in a new upstream workflow, disable it on this repository.
- Issues and private vulnerability reporting are enabled.

## License

[AGPL-3.0](../LICENSE), the same as upstream. The source for each release is the Git tag of the same name. Cherry Studio and its icon belong to CherryHQ.
