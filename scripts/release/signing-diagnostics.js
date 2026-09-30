const { stripVTControlCharacters } = require('node:util')

const SECRET_NAMES = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'KEYCHAIN_PASSWORD',
  'MAC_SIGNING_REQUIREMENT',
  'MAC_SIGNING_CERTIFICATE_SHA1'
]

function sanitizeSigningDiagnostic(error, environment = process.env) {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : error?.stderr
  let detail = typeof stderr === 'string' && stderr.trim() ? stderr : error?.message
  if (typeof detail !== 'string' || !detail.trim()) return 'No native diagnostic was returned'
  detail = stripVTControlCharacters(detail).replace(/^Command failed:[^\r\n]*(?:\r?\n|$)/, '')
  for (const value of SECRET_NAMES.map((name) => environment[name])
    .filter((value) => typeof value === 'string' && value.length)
    .sort((a, b) => b.length - a.length)) {
    detail = detail.split(value).join('[redacted]')
  }
  return (
    detail
      .replace(
        /(?:Developer ID (?:Application|Installer)|Apple (?:Development|Distribution)|Mac Developer|3rd Party Mac Developer (?:Application|Installer)):[^\r\n()]*(?:\([^\r\n()]*\))?/g,
        '[redacted signing identity]'
      )
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000) || 'Command execution failed without a safe diagnostic'
  )
}

module.exports = { sanitizeSigningDiagnostic }
