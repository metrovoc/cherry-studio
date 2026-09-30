const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { sanitizeSigningDiagnostic } = require('./signing-diagnostics')

const {
  SIGNING_CERTIFICATE_SHA1,
  SIGNING_TEAM_ID,
  verifyMacSignatureIdentity
} = require('./verify-downstream-signature')

function decodeCertificateExport(value) {
  const encoded = typeof value === 'string' ? value.replace(/\s/g, '') : ''
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.startsWith('/')) {
    throw new Error('CSC_LINK must contain a base64 PKCS#12 export, never a URL or path')
  }
  const certificate = Buffer.from(encoded, 'base64')
  if (certificate.toString('base64') !== encoded || certificate[0] !== 0x30) {
    throw new Error('CSC_LINK is not a canonical base64 DER export')
  }
  return certificate
}

function validateNotarizationCredentials(environment) {
  if (
    !environment.APPLE_ID ||
    !environment.APPLE_APP_SPECIFIC_PASSWORD ||
    environment.APPLE_TEAM_ID !== SIGNING_TEAM_ID
  ) {
    throw new Error('Complete notarization credentials for the pinned signing team are required')
  }
}

function prepareSigningConfig(identities, workspace) {
  const entries = [...identities.matchAll(/\b([A-F0-9]{40}) "([^"]+)"/g)]
  if (
    entries.length !== 1 ||
    entries[0][1] !== SIGNING_CERTIFICATE_SHA1 ||
    !entries[0][2].startsWith('Developer ID Application: ') ||
    !entries[0][2].endsWith(` (${SIGNING_TEAM_ID})`)
  ) {
    throw new Error('Export must contain exactly the pinned Developer ID Application identity and team')
  }
  return {
    extends: path.join(workspace, 'electron-builder.yml'),
    forceCodeSigning: true,
    mac: {
      identity: SIGNING_CERTIFICATE_SHA1,
      type: 'distribution',
      hardenedRuntime: true,
      minimumSystemVersion: '13.0',
      notarize: true
    },
    afterSign: path.join(workspace, 'scripts/release/verify-downstream-signature.js')
  }
}

function parseKeychainSearchList(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const value = JSON.parse(line)
      if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Invalid keychain search-list entry')
      return value
    })
}

function registerSigningKeychain({ keychain, backupPath, execute = execFileSync }) {
  const original = parseKeychainSearchList(
    execute('/usr/bin/security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
  ).filter((entry) => entry !== keychain)
  fs.writeFileSync(backupPath, JSON.stringify(original), { mode: 0o600 })
  execute('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain, ...original], { stdio: 'pipe' })
}

function cleanupSigningKeychain({ keychain, backupPath, files = [], execute = execFileSync }) {
  const errors = []
  try {
    if (fs.existsSync(backupPath)) {
      const original = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
      if (!Array.isArray(original) || original.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))) {
        throw new Error('Invalid saved keychain search list')
      }
      execute('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...original], { stdio: 'pipe' })
    }
  } catch {
    errors.push('search-list restoration')
  }
  try {
    if (fs.existsSync(keychain)) execute('/usr/bin/security', ['delete-keychain', keychain], { stdio: 'pipe' })
  } catch {
    errors.push('keychain deletion')
  }
  for (const file of [keychain, backupPath, ...files]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      errors.push('temporary-file deletion')
    }
  }
  if (errors.length) throw new Error(`Signing cleanup failed: ${errors.join(', ')}`)
}

function probeSigningKeychain({
  directory,
  keychain,
  entitlements,
  execute = execFileSync,
  verifyIdentity = verifyMacSignatureIdentity
}) {
  const temporary = fs.mkdtempSync(path.join(directory, 'signing-probe-'))
  const binary = path.join(temporary, 'probe')
  let stage = 'compile'
  try {
    execute('/usr/bin/xcrun', ['clang', '-x', 'c', '-', '-arch', 'arm64', '-mmacosx-version-min=13.0', '-o', binary], {
      input: 'int main(void) { return 0; }\n',
      stdio: 'pipe'
    })
    stage = 'sign'
    execute(
      '/usr/bin/codesign',
      [
        '--sign',
        SIGNING_CERTIFICATE_SHA1,
        '--force',
        '--keychain',
        keychain,
        '--timestamp',
        '--options',
        'runtime',
        '--identifier',
        'com.kangfenmao.CherryStudio',
        '--entitlements',
        entitlements,
        binary
      ],
      { stdio: 'pipe' }
    )
    stage = 'verify'
    verifyIdentity(binary)
  } catch (error) {
    throw new Error(
      `Temporary signing probe failed before app packaging (${stage}): ${sanitizeSigningDiagnostic(error)}`
    )
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function main() {
  const keychain = path.join(process.env.RUNNER_TEMP, 'downstream-signing.keychain-db')
  const backupPath = path.join(process.env.RUNNER_TEMP, 'signing-keychains.json')
  if (process.argv[2] === 'register-keychain') {
    registerSigningKeychain({ keychain, backupPath })
    return
  }
  if (process.argv[2] === 'cleanup') {
    cleanupSigningKeychain({
      keychain,
      backupPath,
      files: ['signing.p12', 'signing-identities.txt', 'downstream-builder.json'].map((file) =>
        path.join(process.env.RUNNER_TEMP, file)
      )
    })
    return
  }
  if (process.argv[2] === 'probe') {
    probeSigningKeychain({
      directory: process.env.RUNNER_TEMP,
      keychain,
      entitlements: path.join(process.env.GITHUB_WORKSPACE, 'build/entitlements.mac.plist')
    })
    return
  }
  if (process.argv[2] === 'certificate') {
    if (!process.env.CSC_KEY_PASSWORD) throw new Error('CSC_KEY_PASSWORD is required')
    fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'signing.p12'), decodeCertificateExport(process.env.CSC_LINK), {
      mode: 0o600
    })
    return
  }
  validateNotarizationCredentials(process.env)
  const identities = fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'signing-identities.txt'), 'utf8')
  const config = prepareSigningConfig(identities, process.env.GITHUB_WORKSPACE)
  const identityName = [...identities.matchAll(/\b([A-F0-9]{40}) "([^"]+)"/g)][0][2]
  console.log(`::add-mask::${identityName}`)
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'downstream-builder.json'), JSON.stringify(config), {
    mode: 0o600
  })
}

if (require.main === module) main()
module.exports = {
  decodeCertificateExport,
  validateNotarizationCredentials,
  prepareSigningConfig,
  parseKeychainSearchList,
  registerSigningKeychain,
  cleanupSigningKeychain,
  probeSigningKeychain
}
