const fs = require('node:fs')
const path = require('node:path')

const { SIGNING_CERTIFICATE_SHA1, SIGNING_TEAM_ID } = require('./verify-downstream-signature')

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

function main() {
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
module.exports = { decodeCertificateExport, validateNotarizationCredentials, prepareSigningConfig }
