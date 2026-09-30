# Downstream macOS releases

`downstream-release.yml` publishes the notarized stable arm64 build for
`metrovoc/cherry-studio`, using the explicitly selected Developer ID Application
certificate. It requires macOS 13 or later. The first move from an Apple
Development-signed installation is a signing-identity migration and requires a
verified bootstrap installation; do not assume the old app's permissions or
updater identity automatically carry over.

## Signing setup

The workflow uses the existing repository secrets; it does not depend on a
GitHub environment:

- `CSC_LINK`: canonical base64-encoded PKCS#12 export containing the selected
  Developer ID Application certificate and its private key; URLs and paths are
  rejected rather than fetched or opened
- `CSC_KEY_PASSWORD`: the export's nonempty password
- `APPLE_ID`: the Apple account used for notarization
- `APPLE_APP_SPECIFIC_PASSWORD`: its app-specific notarization password
- `APPLE_TEAM_ID`: the selected certificate's team

The public certificate fingerprint and team are pinned in
`verify-downstream-signature.js`. A missing credential, wrong certificate, wrong
team, failed notarization, absent stapled ticket, or failed Gatekeeper assessment
stops publication. There is no unsigned, development-signing, or unnotarized
fallback. The base64 export is imported once into a temporary keychain; it is
never passed to electron-builder for a second automatic import.

Use GitHub's secure secret entry UI. Never put credential values or personal
certificate names in source files, issue comments, or workflow inputs. Signed
app bundles naturally contain the public certificate's identity information.
Repository secrets are not branch-scoped: the workflow's downstream-only and
exact-CI gates do not replace repository write-access and workflow-review
controls.

## Catalog prerequisite

Catalog publication happens separately under the `metrovoc` identity, with a
verified signed commit. The release workflow never creates catalog commits,
pushes the catalog branch, or uses personal publishing credentials.

Before a release, publish the matching catalog to
`x-files/downstream-provider-registry` and record its exact 40-character commit
SHA in `scripts/release/catalog-pin.json`. An unset pin deliberately blocks
publication. CI requires GitHub to report both author and committer as `metrovoc`
and the commit signature as verified. The commit author name must be `metrovoc`,
and its final message paragraph must contain an exact DCO `Signed-off-by` line
matching that name and the author email reported by GitHub. The workflow derives
the email from commit metadata; no personal email is hardcoded. The catalog
branch tip must equal that pin.

CI checks out the immutable pinned commit and reproduces its catalog from the
bundled source using the recorded revision. Any manifest or content mismatch
stops the release. It rechecks the catalog branch tip and verified authorship
immediately before making the app release public. Catalog updates and releases
are separate operations, so an advanced catalog may exist before its app release.

The workflow's built-in GitHub token is used for read-only CI/catalog checks and
for creating the matching release tag and publishing app release assets. It does
not write catalog content. No bot catalog author exception or personal token is
required.

## Release

1. Update `package.json` to a stable version strictly newer than every published
   fork release, and update the English and Chinese release notes in
   `electron-builder.yml`
2. Publish and pin the matching verified `metrovoc` catalog commit as described
   above
3. Push the reviewed version-bump commit or an unpublished release fix to `downstream`; each push
   starts an unprivileged Ubuntu preflight that waits for the complete exact-SHA CI
4. Verify the signing and notarization job succeeds for that exact commit

Pushes without a newer stable version finish without publishing. CI
failure or a moved downstream HEAD stops the release. A matching tag is created
only after signing and artifact validation; existing conflicting tags are refused.

Manual dispatch from `downstream` is optional for retries. GitHub exposes manual
dispatch only once the workflow exists on the default branch; the primary
branch-push trigger works without modifying a clean upstream mirror.

The workflow checks the CI gate before dependency installation and again before
publication. It verifies the exact certificate and designated requirement before
creating archives after notarization, then checks the stapled ticket and
Gatekeeper acceptance of both archive bundles, the packaged fork updater
feed, app identity/version, macOS 13 minimum, arm64 architecture, ZIP checksums,
and matching bundled catalog. Only the ZIP, DMG, `latest-mac.yml`, and fork-only
`release-history.json` become release assets. Prior notes lacking the app's
English/Chinese language sections are omitted from the history asset.

The workflow never overwrites published releases or moves tags. A complete draft
can resume only for the exact source commit and expected asset set: its existing
assets are downloaded, SHA256-checked against GitHub's asset records, and fully
reverified instead of rebuilt. Incomplete drafts require explicit operator
recovery. Inspect failures before retrying; never bypass the signing, catalog,
CI, version, or branch-head gates.
