import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { publishRegistryCatalog } from '../publishRegistryCatalog'
import { validateCatalogCommit, verifyCatalogContents } from '../release/verify-downstream-catalog'

const pin = { commit: 'a'.repeat(40) }
const commit = {
  sha: pin.commit,
  author: { login: 'metrovoc' },
  committer: { login: 'metrovoc' },
  commit: {
    verification: { verified: true, reason: 'valid' },
    author: { name: 'metrovoc', email: 'metrovoc@example.test' },
    message: 'chore(provider-registry): publish catalog\n\nSigned-off-by: metrovoc <metrovoc@example.test>\n'
  }
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('catalog commit identity', () => {
  it('accepts only the pinned verified metrovoc commit at the catalog branch tip', () => {
    expect(() => validateCatalogCommit({ pin, commit, branchHead: pin.commit })).not.toThrow()
  })

  it.each([
    { pin: { commit: null } },
    { pin: { commit: 'main' } },
    { branchHead: 'b'.repeat(40) },
    { commit: { ...commit, sha: 'b'.repeat(40) } },
    { commit: { ...commit, author: { login: 'github-actions[bot]' } } },
    { commit: { ...commit, committer: { login: 'github-actions[bot]' } } },
    { commit: { ...commit, author: null } },
    { commit: { ...commit, commit: { ...commit.commit, message: 'Unsigned catalog' } } },
    { commit: { ...commit, commit: { ...commit.commit, message: 'Signed-off-by: metrovoc <someone@example.test>' } } },
    {
      commit: { ...commit, commit: { ...commit.commit, author: { name: 'Someone', email: 'metrovoc@example.test' } } }
    },
    { commit: { ...commit, commit: { verification: { verified: false, reason: 'unsigned' } } } },
    { commit: { ...commit, commit: { verification: { verified: true, reason: 'expired_key' } } } }
  ])('rejects unpublished, stale, bot-authored or unverified catalog input %j', (changes) => {
    expect(() => validateCatalogCommit({ pin, commit, branchHead: pin.commit, ...changes })).toThrow()
  })
})

describe('catalog workflow preflight', () => {
  function runGate(changes: { pin?: unknown; commit?: unknown; branchHead?: string } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-workflow-test-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'scripts/release'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts/release/catalog-pin.json'), JSON.stringify(changes.pin ?? pin))
    fs.writeFileSync(path.join(root, 'commit.json'), JSON.stringify(changes.commit ?? commit))
    fs.writeFileSync(path.join(root, 'output'), '')
    const workflow = parse(
      fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/downstream-release.yml'), 'utf8')
    )
    const step = workflow.jobs.preflight.steps.find((candidate: { id?: string }) => candidate.id === 'catalog')
    const result = spawnSync(
      'bash',
      [
        '-e',
        '-o',
        'pipefail',
        '-c',
        `
      gh() {
        case "$2" in
          */commits/*) cat "$COMMIT_FIXTURE" ;;
          */git/ref/heads/x-files/downstream-provider-registry) printf '%s\\n' "$CATALOG_BRANCH_SHA" ;;
          *) return 9 ;;
        esac
      }
      ${step.run}
    `
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'metrovoc/cherry-studio',
          GITHUB_OUTPUT: path.join(root, 'output'),
          RUNNER_TEMP: root,
          COMMIT_FIXTURE: path.join(root, 'commit.json'),
          CATALOG_BRANCH_SHA: changes.branchHead ?? pin.commit
        }
      }
    )
    return { status: result.status, output: fs.readFileSync(path.join(root, 'output'), 'utf8') }
  }

  it('passes the immutable commit to the signing job only after identity verification', () => {
    expect(runGate()).toEqual({ status: 0, output: `sha=${pin.commit}\n` })
  })

  it.each([
    { pin: { commit: null } },
    { pin: { commit: 'main' } },
    { branchHead: 'b'.repeat(40) },
    { commit: { ...commit, sha: 'b'.repeat(40) } },
    { commit: { ...commit, author: { login: 'github-actions[bot]' } } },
    { commit: { ...commit, committer: { login: 'github-actions[bot]' } } },
    { commit: { ...commit, commit: { ...commit.commit, message: 'No signoff' } } },
    { commit: { ...commit, commit: { ...commit.commit, message: 'Signed-off-by: metrovoc <someone@example.test>' } } },
    { commit: { ...commit, commit: { verification: { verified: false, reason: 'unsigned' } } } }
  ])('blocks unsafe catalog identity before the credential job: %j', (changes) => {
    const result = runGate(changes)
    expect(result.status).not.toBe(0)
    expect(result.output).toBe('')
  })
})

async function catalogFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-release-test-'))
  roots.push(root)
  const sourceDirectory = path.join(root, 'source')
  const catalogDirectory = path.join(root, 'catalog')
  fs.cpSync(path.resolve(__dirname, '../../packages/provider-registry/data'), sourceDirectory, { recursive: true })
  fs.mkdirSync(catalogDirectory)
  const options = {
    catalogDirectory,
    sourceDirectory,
    compatDirectory: path.resolve(__dirname, '../../packages/provider-registry/compat'),
    currentVersion: 2,
    minAppVersion: '2.1.2',
    version: '2.1.3'
  }
  await publishRegistryCatalog({
    ...options,
    destinationDirectory: catalogDirectory,
    sourceAppVersion: options.version,
    revision: 1_790_104_000
  })
  return options
}

function editManifest(directory: string, changes: object) {
  const file = path.join(directory, 'v2/manifest.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...changes }))
}

describe('catalog release correspondence', () => {
  it('accepts a byte-exact publication, including older-schema projections, without editing it', async () => {
    const options = await catalogFixture()
    const manifest = fs.readFileSync(path.join(options.catalogDirectory, 'v2/manifest.json'))
    await expect(verifyCatalogContents(options)).resolves.toBeUndefined()
    expect(fs.readFileSync(path.join(options.catalogDirectory, 'v2/manifest.json'))).toEqual(manifest)
  })

  it.each([
    { sourceAppVersion: '2.1.2' },
    { schemaVersion: 1 },
    { minAppVersion: '1.0.0' },
    { revision: 0 },
    { revision: 1.5 },
    { revision: '1790104000' },
    { files: {} }
  ])('rejects a catalog manifest inconsistent with the released app: %j', async (changes) => {
    const options = await catalogFixture()
    editManifest(options.catalogDirectory, changes)
    await expect(verifyCatalogContents(options)).rejects.toThrow()
  })

  it.each(['v1', 'v2'])('rejects differing published bytes in %s', async (schema) => {
    const options = await catalogFixture()
    fs.appendFileSync(path.join(options.catalogDirectory, schema, 'models.json'), '\n')
    await expect(verifyCatalogContents(options)).rejects.toThrow('differs')
  })

  it('rejects a bundled catalog that fails the current frozen schema', async () => {
    const options = await catalogFixture()
    fs.writeFileSync(path.join(options.sourceDirectory, 'models.json'), '{}')
    await expect(verifyCatalogContents(options)).rejects.toThrow()
  })

  it('rejects missing published files', async () => {
    const options = await catalogFixture()
    fs.rmSync(path.join(options.catalogDirectory, 'v2/providers.json'))
    await expect(verifyCatalogContents(options)).rejects.toThrow('differs')
  })

  it('rejects symlinks rather than copying or following them', async () => {
    const options = await catalogFixture()
    const file = path.join(options.catalogDirectory, 'v2/models.json')
    fs.rmSync(file)
    fs.symlinkSync(path.join(options.sourceDirectory, 'models.json'), file)
    await expect(verifyCatalogContents(options)).rejects.toThrow('regular files')
  })

  it('rejects unexpected schema files', async () => {
    const options = await catalogFixture()
    fs.writeFileSync(path.join(options.catalogDirectory, 'v2/extra.json'), '{}')
    await expect(verifyCatalogContents(options)).rejects.toThrow('Unexpected')
  })
})
