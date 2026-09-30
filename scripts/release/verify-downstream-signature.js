const { execFileSync, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parse } = require('yaml')

const SIGNING_CERTIFICATE_SHA1 = 'E1A605A41412F1C3A204AD8E9318EC97F62939B9'
const SIGNING_TEAM_ID = 'PH4977K248'
const REQUIREMENT_TERMS = [
  'identifier "com.kangfenmao.CherryStudio"',
  'anchor apple generic',
  'certificate 1[field.1.2.840.113635.100.6.2.6]',
  'certificate leaf[field.1.2.840.113635.100.6.1.13]',
  `certificate leaf[subject.OU] = ${SIGNING_TEAM_ID}`
]

function validateDeveloperIdRequirement(requirement) {
  const terms = requirement
    .trim()
    .replace(/^designated =>\s*/, '')
    .replace(/\/\* exists \*\//g, '')
    .replace(new RegExp(`"${SIGNING_TEAM_ID}"`, 'g'), SIGNING_TEAM_ID)
    .split(/\s+and\s+/)
    .map((term) => term.trim().replace(/\s+/g, ' '))
    .sort()
  if (JSON.stringify(terms) !== JSON.stringify([...REQUIREMENT_TERMS].sort())) {
    throw new Error('Designated requirement must preserve the Developer ID app and team identity')
  }
}

function run(command, args, options) {
  try {
    return execFileSync(command, args, options)
  } catch {
    throw new Error(`macOS verification failed: ${command}`)
  }
}

function validateMacBundleMetadata({ feed, info, arch, version }) {
  if (
    feed.provider !== 'github' ||
    feed.owner !== 'metrovoc' ||
    feed.repo !== 'cherry-studio' ||
    feed.token !== undefined ||
    feed.url !== undefined ||
    feed.host !== undefined ||
    feed.private === true ||
    (feed.channel !== undefined && feed.channel !== 'latest')
  ) {
    throw new Error('Packaged updater must use the public stable fork feed')
  }
  if (
    info.CFBundleIdentifier !== 'com.kangfenmao.CherryStudio' ||
    info.CFBundleShortVersionString !== version ||
    info.LSMinimumSystemVersion !== '13.0' ||
    arch !== 'arm64'
  ) {
    throw new Error('Packaged app identity, version, minimum system or architecture mismatch')
  }
}

function verifyDownstreamSignature(appPath) {
  validateMacBundleMetadata({
    feed: parse(fs.readFileSync(path.join(appPath, 'Contents/Resources/app-update.yml'), 'utf8')),
    info: JSON.parse(
      run('plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents/Info.plist')], {
        encoding: 'utf8'
      })
    ),
    arch: run('lipo', ['-archs', path.join(appPath, 'Contents/MacOS/Cherry Studio')], {
      encoding: 'utf8'
    }).trim(),
    version: require('../../package.json').version
  })
  const requirement = REQUIREMENT_TERMS.join(' and ')
  run('codesign', ['--verify', '--deep', '--strict', '-R', requirement, appPath], { stdio: 'pipe' })
  const result = spawnSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8' })
  const actual = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .find((line) => line.startsWith('designated => '))
    ?.slice(14)
    .trim()
  if (result.status !== 0 || !actual) throw new Error('Unable to inspect designated requirement')
  validateDeveloperIdRequirement(actual)
  const details = spawnSync('codesign', ['-d', '--verbose=4', appPath], { encoding: 'utf8' })
  if (details.status !== 0 || !/flags=.*\bruntime\b/.test(`${details.stdout}\n${details.stderr}`)) {
    throw new Error('Hardened runtime is required')
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'downstream-signature-'))
  try {
    const prefix = path.join(temporary, 'certificate')
    run('codesign', ['-d', '--extract-certificates', prefix, appPath], { stdio: 'pipe' })
    const digest = createHash('sha1')
      .update(fs.readFileSync(`${prefix}0`))
      .digest('hex')
    if (digest.toUpperCase() !== SIGNING_CERTIFICATE_SHA1) throw new Error('Signing certificate changed')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  run('xcrun', ['stapler', 'validate', appPath], { stdio: 'pipe' })
  run('spctl', ['--assess', '--type', 'execute', appPath], { stdio: 'pipe' })
}

exports.default = async (context) => {
  if (context.electronPlatformName !== 'darwin') throw new Error('Only macOS is supported')
  verifyDownstreamSignature(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`))
}
exports.verifyDownstreamSignature = verifyDownstreamSignature
exports.validateMacBundleMetadata = validateMacBundleMetadata
exports.validateDeveloperIdRequirement = validateDeveloperIdRequirement
exports.SIGNING_CERTIFICATE_SHA1 = SIGNING_CERTIFICATE_SHA1
exports.SIGNING_TEAM_ID = SIGNING_TEAM_ID
if (require.main === module) verifyDownstreamSignature(process.argv[2])
