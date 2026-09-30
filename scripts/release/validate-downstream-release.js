const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const semver = require('semver')
const { parse } = require('yaml')

function validateDownstreamRelease({ repository, sha, downstreamSha, tag, version, releases, runs }) {
  if (repository !== 'metrovoc/cherry-studio') throw new Error('Only the downstream fork may publish')
  if (!/^[a-f0-9]{40}$/.test(sha) || sha !== downstreamSha) throw new Error('Release must be the downstream HEAD')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || tag !== `v${version}`) {
    throw new Error('Tag must match the stable package version')
  }
  const existing = releases.find((release) => release.tag_name === tag)
  if (existing) validateResumableDraft(existing, version, sha)
  for (const release of releases.filter((entry) => !entry.draft && !entry.prerelease)) {
    const previous = semver.valid(release.tag_name)
    if (previous && !semver.gt(version, previous)) throw new Error('Version must be newer than every published release')
  }
  const run = runs
    .filter((entry) => entry.head_sha === sha && entry.head_branch === 'downstream' && entry.event === 'push')
    .sort((a, b) => b.id - a.id)[0]
  if (
    !run ||
    run.head_repository?.full_name !== repository ||
    run.path !== '.github/workflows/ci.yml' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  ) {
    throw new Error('The latest exact-SHA downstream CI workflow must have succeeded')
  }
  return existing ?? null
}

function validateResumableDraft(release, version, sha) {
  const expected = [
    `Cherry-Studio-${version}-mac-arm64.zip`,
    `Cherry-Studio-${version}-mac-arm64.dmg`,
    'latest-mac.yml',
    'release-history.json'
  ].sort()
  if (
    !release.draft ||
    release.prerelease ||
    release.tag_name !== `v${version}` ||
    release.name !== `v${version}` ||
    release.target_commitish !== sha
  ) {
    throw new Error('Existing release is not a draft for this exact source commit')
  }
  const assets = release.assets ?? []
  if (
    JSON.stringify(assets.map((asset) => asset.name).sort()) !== JSON.stringify(expected) ||
    assets.some((asset) => asset.state !== 'uploaded' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || ''))
  ) {
    throw new Error('Draft assets are incomplete or lack immutable SHA256 digests; operator recovery required')
  }
}

function verifyDraftAssets(release, directory) {
  for (const asset of release.assets) {
    const digest = createHash('sha256')
      .update(fs.readFileSync(path.join(directory, asset.name)))
      .digest('hex')
    if (`sha256:${digest}` !== asset.digest) throw new Error('Draft asset digest changed')
  }
}

function hasLanguageSections(notes) {
  return typeof notes === 'string' && /<!--LANG:en-->[\s\S]+<!--LANG:zh-CN-->[\s\S]+<!--LANG:END-->/.test(notes)
}

function createDownstreamHistory(releases, version, releaseNotes) {
  if (!hasLanguageSections(releaseNotes)) throw new Error('Release notes require English and Chinese sections')
  return [
    { version, releaseNotes },
    ...releases
      .filter(
        (entry) =>
          !entry.draft &&
          !entry.prerelease &&
          /^v\d+\.\d+\.\d+$/.test(entry.tag_name) &&
          semver.valid(entry.tag_name) &&
          hasLanguageSections(entry.body)
      )
      .sort((a, b) => semver.rcompare(a.tag_name, b.tag_name))
      .map((entry) => ({ version: semver.clean(entry.tag_name), releaseNotes: entry.body || '' }))
  ]
}

function validateDownstreamArtifacts(directory, version, arch) {
  if (arch !== 'arm64') throw new Error('Only the downstream arm64 release is supported')
  const names = ['zip', 'dmg'].map((extension) => `Cherry-Studio-${version}-mac-${arch}.${extension}`)
  for (const name of names) {
    if (!fs.statSync(path.join(directory, name), { throwIfNoEntry: false })?.size)
      throw new Error(`Missing artifact: ${name}`)
  }
  const manifest = parse(fs.readFileSync(path.join(directory, 'latest-mac.yml'), 'utf8'))
  if (manifest.version !== version || !Array.isArray(manifest.files) || manifest.files.length !== 1) {
    throw new Error('Update manifest must contain this version and exactly one ZIP')
  }
  const zip = fs.readFileSync(path.join(directory, names[0]))
  const digest = createHash('sha512').update(zip).digest('base64')
  const file = manifest.files[0]
  if (file.url !== names[0] || file.size !== zip.length || file.sha512 !== digest) {
    throw new Error('Update ZIP name, size or digest mismatch')
  }
  if (manifest.path !== names[0] || manifest.sha512 !== digest) throw new Error('Legacy update metadata mismatch')
  return names
}

function main() {
  const version = require('../../package.json').version
  if (process.argv[2] === 'artifacts') {
    validateDownstreamArtifacts('dist', version, 'arm64')
    return
  }
  const releases = JSON.parse(fs.readFileSync(process.env.RELEASES_FILE, 'utf8')).flat()
  const runs = JSON.parse(fs.readFileSync(process.env.CI_RUNS_FILE, 'utf8')).workflow_runs
  const draft = validateDownstreamRelease({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    downstreamSha: process.env.DOWNSTREAM_SHA,
    tag: process.env.RELEASE_TAG,
    version,
    releases,
    runs
  })
  if (draft && process.argv[2] !== 'prepare') verifyDraftAssets(draft, 'dist')
  if (process.argv[2] === 'prepare') {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `resume=${Boolean(draft)}\n`)
    const { releaseNotes } = parse(fs.readFileSync('electron-builder.yml', 'utf8')).releaseInfo
    fs.writeFileSync(
      'resources/cherry-studio/release-history.json',
      `${JSON.stringify(createDownstreamHistory(releases, version, releaseNotes), null, 2)}\n`
    )
    fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'downstream-release-notes.md'), releaseNotes)
  }
}

if (require.main === module) main()
module.exports = {
  validateDownstreamRelease,
  createDownstreamHistory,
  validateDownstreamArtifacts,
  validateResumableDraft,
  verifyDraftAssets
}
