import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import {
  cleanupSigningKeychain,
  decodeCertificateExport,
  parseKeychainSearchList,
  probeSigningKeychain,
  registerSigningKeychain,
  prepareSigningConfig,
  validateNotarizationCredentials
} from '../release/prepare-downstream-signing'
import { sanitizeSigningDiagnostic } from '../release/signing-diagnostics'
import {
  createDownstreamHistory,
  validateDownstreamArtifacts,
  validateDownstreamRelease,
  validateResumableDraft,
  verifyDraftAssets
} from '../release/validate-downstream-release'
import {
  SIGNING_CERTIFICATE_SHA1,
  SIGNING_TEAM_ID,
  validateDeveloperIdRequirement,
  validateMacBundleMetadata
} from '../release/verify-downstream-signature'

const sha = 'a'.repeat(40)
const run = {
  id: 20,
  head_sha: sha,
  head_branch: 'downstream',
  event: 'push',
  path: '.github/workflows/ci.yml',
  head_repository: { full_name: 'metrovoc/cherry-studio' },
  status: 'completed',
  conclusion: 'success'
}
const notes = '<!--LANG:en-->Fork notes<!--LANG:zh-CN-->分支说明<!--LANG:END-->'
const release = { tag_name: 'v2.1.2', draft: false, prerelease: false, body: notes }
const candidate = {
  repository: 'metrovoc/cherry-studio',
  sha,
  downstreamSha: sha,
  tag: 'v2.1.3',
  version: '2.1.3',
  releases: [release],
  runs: [run]
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('downstream publication gates', () => {
  it('accepts an exact successful downstream CI commit with a newer stable version', () => {
    expect(() => validateDownstreamRelease(candidate)).not.toThrow()
  })

  it.each([
    { repository: 'CherryHQ/cherry-studio' },
    { downstreamSha: 'b'.repeat(40) },
    { tag: 'v2.1.4' },
    { version: '2.1.3-beta.1', tag: 'v2.1.3-beta.1' },
    { version: '2.1.1', tag: 'v2.1.1' },
    { releases: [{ ...release, tag_name: 'v2.1.3', draft: true }] },
    { runs: [{ ...run, head_sha: 'b'.repeat(40) }] },
    { runs: [{ ...run, event: 'pull_request' }] },
    { runs: [{ ...run, head_branch: 'main' }] },
    { runs: [{ ...run, path: '.github/workflows/release.yml' }] },
    { runs: [{ ...run, head_repository: { full_name: 'another/fork' } }] },
    { runs: [{ ...run, status: 'in_progress', conclusion: null }] },
    { runs: [run, { ...run, id: 21, conclusion: 'failure' }] }
  ])('rejects unsafe release input %j', (changes) => {
    expect(() => validateDownstreamRelease({ ...candidate, ...changes })).toThrow()
  })

  it('builds history only from published stable fork releases', () => {
    expect(
      createDownstreamHistory(
        [
          release,
          { ...release, tag_name: 'v9.0.0', draft: true },
          { ...release, tag_name: 'v3.0.0-beta.1', prerelease: true },
          { ...release, tag_name: 'v3.0.0+build.1' },
          { ...release, tag_name: 'v1.0.0', body: 'Missing sections' }
        ],
        '2.1.3',
        notes
      )
    ).toEqual([
      { version: '2.1.3', releaseNotes: notes },
      { version: '2.1.2', releaseNotes: notes }
    ])
  })
})

function artifacts() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'downstream-artifacts-'))
  roots.push(directory)
  const name = 'Cherry-Studio-2.1.3-mac-arm64.zip'
  const contents = Buffer.from('archive fixture')
  const sha512 = createHash('sha512').update(contents).digest('base64')
  fs.writeFileSync(path.join(directory, name), contents)
  fs.writeFileSync(path.join(directory, name.replace('.zip', '.dmg')), 'disk image fixture')
  const manifest = { version: '2.1.3', files: [{ url: name, sha512, size: contents.length }], path: name, sha512 }
  fs.writeFileSync(path.join(directory, 'latest-mac.yml'), stringify(manifest))
  return { directory, manifest }
}

describe('downstream artifact integrity', () => {
  it('accepts complete matching single-architecture artifacts', () => {
    const { directory } = artifacts()
    expect(validateDownstreamArtifacts(directory, '2.1.3', 'arm64')).toHaveLength(2)
  })

  it('rejects a changed ZIP after update metadata was written', () => {
    const { directory, manifest } = artifacts()
    fs.appendFileSync(path.join(directory, manifest.path), 'tampered')
    expect(() => validateDownstreamArtifacts(directory, '2.1.3', 'arm64')).toThrow('digest mismatch')
  })

  it.each(['version', 'url', 'size', 'sha512', 'path'])('rejects incorrect %s metadata', (field) => {
    const { directory, manifest } = artifacts()
    const altered = structuredClone(manifest)
    if (field === 'version') altered.version = '2.1.4'
    if (field === 'url') altered.files[0].url = '../other.zip'
    if (field === 'size') altered.files[0].size = 1
    if (field === 'sha512') altered.sha512 = 'wrong'
    if (field === 'path') altered.path = 'other.zip'
    fs.writeFileSync(path.join(directory, 'latest-mac.yml'), stringify(altered))
    expect(() => validateDownstreamArtifacts(directory, '2.1.3', 'arm64')).toThrow()
  })

  it('rejects missing DMGs and architecture mixing', () => {
    const { directory, manifest } = artifacts()
    expect(() => validateDownstreamArtifacts(directory, '2.1.3', 'x64')).toThrow()
    fs.unlinkSync(path.join(directory, manifest.path.replace('.zip', '.dmg')))
    expect(() => validateDownstreamArtifacts(directory, '2.1.3', 'arm64')).toThrow('Missing artifact')
  })
})

describe('packaged macOS update compatibility', () => {
  const metadata = {
    feed: { provider: 'github', owner: 'metrovoc', repo: 'cherry-studio' },
    info: {
      CFBundleIdentifier: 'com.kangfenmao.CherryStudio',
      CFBundleShortVersionString: '2.1.3',
      LSMinimumSystemVersion: '13.0'
    },
    arch: 'arm64',
    version: '2.1.3'
  }

  it('accepts the exact fork feed and installed-app identity', () => {
    expect(() => validateMacBundleMetadata(metadata)).not.toThrow()
  })

  it.each([
    { provider: 'generic' },
    { owner: 'CherryHQ' },
    { repo: 'other' },
    { token: 'must-not-be-embedded' },
    { url: 'https://example.com' },
    { host: 'example.com' },
    { channel: 'beta' },
    { private: true }
  ])('rejects an unsafe packaged feed %j', (change) => {
    expect(() => validateMacBundleMetadata({ ...metadata, feed: { ...metadata.feed, ...change } })).toThrow()
  })

  it.each([
    { CFBundleIdentifier: 'other.app' },
    { CFBundleShortVersionString: '2.1.2' },
    { LSMinimumSystemVersion: '14.0' }
  ])('rejects changed bundle metadata %j', (change) => {
    expect(() => validateMacBundleMetadata({ ...metadata, info: { ...metadata.info, ...change } })).toThrow()
  })

  it('rejects an Intel executable', () => {
    expect(() => validateMacBundleMetadata({ ...metadata, arch: 'x86_64' })).toThrow()
  })
})

describe('interrupted release recovery', () => {
  function draftFixture() {
    const { directory, manifest } = artifacts()
    fs.writeFileSync(path.join(directory, 'release-history.json'), '[]')
    const names = [manifest.path, manifest.path.replace('.zip', '.dmg'), 'latest-mac.yml', 'release-history.json']
    return {
      directory,
      draft: {
        tag_name: 'v2.1.3',
        name: 'v2.1.3',
        target_commitish: sha,
        draft: true,
        prerelease: false,
        assets: names.map((name) => ({
          name,
          state: 'uploaded',
          digest: `sha256:${createHash('sha256')
            .update(fs.readFileSync(path.join(directory, name)))
            .digest('hex')}`
        }))
      }
    }
  }

  it('resumes a complete draft only for the same source and immutable assets', () => {
    const { directory, draft } = draftFixture()
    expect(validateDownstreamRelease({ ...candidate, releases: [release, draft] })).toEqual(draft)
    expect(() => verifyDraftAssets(draft, directory)).not.toThrow()
  })

  it.each([{ draft: false }, { target_commitish: 'b'.repeat(40) }, { name: 'other' }, { assets: [] }])(
    'rejects unsafe draft recovery %j',
    (change) => {
      const { draft } = draftFixture()
      expect(() => validateResumableDraft({ ...draft, ...change }, '2.1.3', sha)).toThrow()
    }
  )

  it('rejects a replaced asset even when other draft fields still match', () => {
    const { directory, draft } = draftFixture()
    fs.writeFileSync(path.join(directory, 'release-history.json'), 'changed')
    expect(() => verifyDraftAssets(draft, directory)).toThrow('digest changed')
  })
})

describe('Developer ID signing preparation', () => {
  const credentials = {
    APPLE_ID: 'notarization@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'test-placeholder',
    APPLE_TEAM_ID: SIGNING_TEAM_ID
  }
  const identity = `1) ${SIGNING_CERTIFICATE_SHA1} "Developer ID Application: Build Identity (${SIGNING_TEAM_ID})"`

  it('accepts a canonical inline DER export without reading a path or URL', () => {
    const bytes = Buffer.from([0x30, 3, 1, 2, 3])
    expect(decodeCertificateExport(bytes.toString('base64'))).toEqual(bytes)
  })

  it.each([
    '',
    'https://example.com/signing.p12',
    '/tmp/signing.p12',
    '~/signing.p12',
    'file:///tmp/signing.p12',
    'not base64!',
    'AAAA',
    'MAMBAgM'
  ])('rejects unsupported certificate source %s', (source) => {
    expect(() => decodeCertificateExport(source)).toThrow()
  })

  it('requires the pinned identity and generates mandatory distribution signing and notarization', () => {
    expect(prepareSigningConfig(identity, '/workspace')).toMatchObject({
      forceCodeSigning: true,
      mac: {
        identity: SIGNING_CERTIFICATE_SHA1,
        type: 'distribution',
        hardenedRuntime: true,
        notarize: true,
        minimumSystemVersion: '13.0'
      }
    })
  })

  it.each([
    identity.replace(SIGNING_CERTIFICATE_SHA1, 'F'.repeat(40)),
    identity.replace('Developer ID Application:', 'Apple Development:'),
    identity.replace(SIGNING_TEAM_ID, 'OTHERTEAM0'),
    `${identity}\n${identity}`,
    ''
  ])('rejects certificate or identity mismatch', (entry) => {
    expect(() => prepareSigningConfig(entry, '/workspace')).toThrow()
  })

  it('requires a full notary credential set for the pinned team', () => {
    expect(() => validateNotarizationCredentials(credentials)).not.toThrow()
    for (const key of Object.keys(credentials)) {
      expect(() => validateNotarizationCredentials({ ...credentials, [key]: '' })).toThrow()
    }
    expect(() => validateNotarizationCredentials({ ...credentials, APPLE_TEAM_ID: 'OTHERTEAM0' })).toThrow()
  })
})

describe('Developer ID designated requirement', () => {
  const terms = [
    'identifier "com.kangfenmao.CherryStudio"',
    'anchor apple generic',
    'certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */',
    `certificate leaf[subject.OU] = "${SIGNING_TEAM_ID}"`
  ]

  it('accepts the exact Developer ID constraints regardless of ordering', () => {
    expect(() => validateDeveloperIdRequirement(terms.join(' and '))).not.toThrow()
    expect(() => validateDeveloperIdRequirement([...terms].reverse().join(' and '))).not.toThrow()
  })

  it.each([
    terms.join(' or '),
    terms.join(' and ').replace(SIGNING_TEAM_ID, 'OTHERTEAM0'),
    terms.join(' and ').replace('com.kangfenmao.CherryStudio', 'another.app'),
    terms.filter((term) => !term.includes('100.6.1.13')).join(' and '),
    `${terms.join(' and ')} or anchor trusted`
  ])('rejects broadened or different trust requirements', (requirement) => {
    expect(() => validateDeveloperIdRequirement(requirement)).toThrow()
  })
})

describe('temporary signing-keychain lifecycle', () => {
  function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-keychain-'))
    roots.push(directory)
    const keychain = path.join(directory, 'temporary signing.keychain-db')
    const backupPath = path.join(directory, 'keychains.json')
    fs.writeFileSync(keychain, 'temporary keychain fixture')
    return { directory, keychain, backupPath }
  }

  it('parses quoted keychain paths without whitespace splitting or shell evaluation', () => {
    expect(
      parseKeychainSearchList('    "/Library/Keychains/System.keychain"\n    "/tmp/Name With Spaces.keychain-db"\n')
    ).toEqual(['/Library/Keychains/System.keychain', '/tmp/Name With Spaces.keychain-db'])
    expect(() => parseKeychainSearchList('unquoted value')).toThrow()
    expect(() => parseKeychainSearchList('"relative/path"')).toThrow()
  })

  it('adds the signing keychain without hiding existing keychains, then restores the exact list', () => {
    const { keychain, backupPath } = fixture()
    const original = ['/tmp/Login With Spaces.keychain-db', '/Library/Keychains/System.keychain']
    const commands: string[][] = []
    const execute = (_command: string, args: string[]) => {
      commands.push(args)
      return original.map((entry) => JSON.stringify(entry)).join('\n')
    }
    registerSigningKeychain({ keychain, backupPath, execute })
    expect(commands[1]).toEqual(['list-keychains', '-d', 'user', '-s', keychain, ...original])
    expect(JSON.parse(fs.readFileSync(backupPath, 'utf8'))).toEqual(original)
    cleanupSigningKeychain({ keychain, backupPath, execute })
    expect(commands[2]).toEqual(['list-keychains', '-d', 'user', '-s', ...original])
    expect(commands[3]).toEqual(['delete-keychain', keychain])
    expect(fs.existsSync(keychain)).toBe(false)
    expect(fs.existsSync(backupPath)).toBe(false)
  })

  it('keeps a recoverable original list if installing the new list fails', () => {
    const { keychain, backupPath } = fixture()
    expect(() =>
      registerSigningKeychain({
        keychain,
        backupPath,
        execute: (_command: string, args: string[]) => {
          if (args.includes('-s')) throw new Error('cannot set list')
          return '"/tmp/original.keychain-db"'
        }
      })
    ).toThrow()
    expect(JSON.parse(fs.readFileSync(backupPath, 'utf8'))).toEqual(['/tmp/original.keychain-db'])
  })

  it.each(['restore', 'delete'])('removes private temporary files even when %s fails', (failure) => {
    const { keychain, backupPath, directory } = fixture()
    const exported = path.join(directory, 'signing.p12')
    fs.writeFileSync(exported, 'export fixture')
    fs.writeFileSync(backupPath, JSON.stringify(['/tmp/original.keychain-db']))
    const commands: string[][] = []
    expect(() =>
      cleanupSigningKeychain({
        keychain,
        backupPath,
        files: [exported],
        execute: (_command: string, args: string[]) => {
          commands.push(args)
          if (
            (failure === 'restore' && args[0] === 'list-keychains') ||
            (failure === 'delete' && args[0] === 'delete-keychain')
          )
            throw new Error('cleanup failed')
        }
      })
    ).toThrow('Signing cleanup failed')
    expect(commands).toContainEqual(['delete-keychain', keychain])
    expect([keychain, backupPath, exported].some((file) => fs.existsSync(file))).toBe(false)
  })

  it('compiles and signs an isolated arm64 probe with the exact production identity before verification', () => {
    const { directory, keychain } = fixture()
    const commands: Array<{ command: string; args: string[] }> = []
    let verified = ''
    probeSigningKeychain({
      directory,
      keychain,
      entitlements: '/workspace/build/entitlements.mac.plist',
      execute: (command: string, args: string[]) => {
        commands.push({ command, args })
      },
      verifyIdentity: (binary: string) => {
        verified = binary
      }
    })
    expect(commands[0].command).toBe('/usr/bin/xcrun')
    expect(commands[0].args.slice(0, 5)).toEqual(['clang', '-x', 'c', '-', '-arch'])
    expect(commands[1]).toEqual({
      command: '/usr/bin/codesign',
      args: [
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
        '/workspace/build/entitlements.mac.plist',
        verified
      ]
    })
    expect(fs.existsSync(path.dirname(verified))).toBe(false)
  })

  it.each(['signing', 'verification'])('removes the probe and fails closed after %s failure', (failure) => {
    const { directory, keychain } = fixture()
    expect(() =>
      probeSigningKeychain({
        directory,
        keychain,
        entitlements: '/workspace/entitlements.plist',
        execute: (command: string) => {
          if (failure === 'signing' && command === '/usr/bin/codesign') throw new Error('private native error')
        },
        verifyIdentity: () => {
          if (failure === 'verification') throw new Error('identity mismatch')
        }
      })
    ).toThrow('Temporary signing probe failed before app packaging')
    expect(fs.readdirSync(directory).filter((name) => name.startsWith('signing-probe-'))).toEqual([])
  })
})

describe('safe signing diagnostics', () => {
  it.each([
    'Developer ID Application',
    'Developer ID Installer',
    'Apple Development',
    'Apple Distribution',
    'Mac Developer',
    '3rd Party Mac Developer Application'
  ])('redacts unexpected %s signer names', (kind) => {
    const diagnostic = sanitizeSigningDiagnostic(new Error(`Wrong signer: ${kind}: Example Person (OTHERTEAM0)`), {})
    expect(diagnostic).toContain('[redacted signing identity]')
    expect(diagnostic).not.toContain('Example Person')
  })
  it('keeps useful stderr while removing secrets, certificate names, stdout and command arguments', () => {
    const secrets = {
      CSC_LINK: 'base64-export-placeholder',
      CSC_KEY_PASSWORD: 'p12-password-placeholder',
      APPLE_ID: 'account@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'notary-password-placeholder',
      APPLE_TEAM_ID: 'SECRETTEAM',
      KEYCHAIN_PASSWORD: 'keychain-password-placeholder'
    }
    const error = Object.assign(new Error('Command failed: codesign --sign raw-command-value'), {
      stdout: 'never-log-stdout',
      stderr: Buffer.from(
        `Unable to use Developer ID Application: Example Person (SECRETTEAM)\nThe specified item could not be found in the keychain. ${Object.values(secrets).join(' ')}`
      )
    })
    const diagnostic = sanitizeSigningDiagnostic(error, secrets)
    expect(diagnostic).toContain('The specified item could not be found in the keychain.')
    for (const value of [...Object.values(secrets), 'Example Person', 'raw-command-value', 'never-log-stdout']) {
      expect(diagnostic).not.toContain(value)
    }
  })

  it('strips execFile command headers and retains safe message-only errors', () => {
    expect(
      sanitizeSigningDiagnostic(
        new Error('Command failed: codesign --sign private-command-arguments\nerror: item not found'),
        {}
      )
    ).toBe('error: item not found')
    expect(
      sanitizeSigningDiagnostic(new Error('Command failed: codesign --sign private-command-arguments'), {})
    ).not.toContain('private-command-arguments')
    expect(sanitizeSigningDiagnostic(new Error('Signing certificate changed'), {})).toBe('Signing certificate changed')
  })

  it.each(['compile', 'sign', 'verify'])('reports %s probe failure without leaking raw native errors', (stage) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-diagnostic-'))
    roots.push(directory)
    const nativeError = Object.assign(new Error('Command failed: raw-command-arguments'), {
      stderr: 'native stage diagnostic'
    })
    expect(() =>
      probeSigningKeychain({
        directory,
        keychain: '/tmp/test.keychain-db',
        entitlements: '/tmp/entitlements.plist',
        execute: (command: string) => {
          if (
            (stage === 'compile' && command === '/usr/bin/xcrun') ||
            (stage === 'sign' && command === '/usr/bin/codesign')
          )
            throw nativeError
        },
        verifyIdentity: () => {
          if (stage === 'verify') throw nativeError
        }
      })
    ).toThrow(`Temporary signing probe failed before app packaging (${stage}): native stage diagnostic`)
    expect(fs.readdirSync(directory)).toEqual([])
  })
})
