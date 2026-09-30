const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { publishRegistryCatalog } = require('../publishRegistryCatalog')

function validateCatalogCommit({ pin, commit, branchHead }) {
  if (!/^[a-f0-9]{40}$/.test(pin?.commit || '')) throw new Error('A published catalog commit must be pinned')
  if (
    commit?.sha !== pin.commit ||
    branchHead !== pin.commit ||
    commit.author?.login !== 'metrovoc' ||
    commit.committer?.login !== 'metrovoc' ||
    commit.commit?.verification?.verified !== true ||
    commit.commit?.verification?.reason !== 'valid'
  ) {
    throw new Error('Catalog must be the current pinned, verified metrovoc commit')
  }
  const author = commit.commit.author
  const trailers =
    commit.commit.message
      ?.trim()
      .split(/\r?\n\r?\n/)
      .at(-1)
      .split(/\r?\n/) ?? []
  if (
    author?.name !== 'metrovoc' ||
    typeof author.email !== 'string' ||
    !author.email ||
    !trailers.includes(`Signed-off-by: metrovoc <${author.email}>`)
  ) {
    throw new Error('Catalog commit requires the verified author identity and matching DCO signoff')
  }
}

function catalogSnapshot(directory) {
  const files = {}
  for (const version of fs
    .readdirSync(directory)
    .filter((name) => /^v\d+$/.test(name))
    .sort()) {
    const versionPath = path.join(directory, version)
    if (!fs.lstatSync(versionPath).isDirectory()) throw new Error('Catalog schema paths must be directories')
    for (const name of fs.readdirSync(versionPath).sort()) {
      const filePath = path.join(versionPath, name)
      if (!fs.lstatSync(filePath).isFile()) throw new Error('Catalog entries must be regular files')
      if (!['manifest.json', 'models.json', 'providers.json', 'provider-models.json'].includes(name)) {
        throw new Error('Unexpected published catalog file')
      }
      files[`${version}/${name}`] = fs.readFileSync(filePath).toString('base64')
    }
  }
  return files
}

async function verifyCatalogContents({
  catalogDirectory,
  sourceDirectory,
  compatDirectory,
  currentVersion,
  minAppVersion,
  version
}) {
  const before = catalogSnapshot(catalogDirectory)
  for (const name of Object.keys(before)) {
    const schema = name.split('/')[0]
    if (
      Number(schema.slice(1)) > currentVersion ||
      !fs.existsSync(path.join(compatDirectory, `${schema}-validator.mjs`))
    ) {
      throw new Error('Published catalog has an unsupported schema')
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(catalogDirectory, `v${currentVersion}/manifest.json`), 'utf8'))
  if (
    manifest.schemaVersion !== currentVersion ||
    manifest.minAppVersion !== minAppVersion ||
    manifest.sourceAppVersion !== version ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision <= 0
  ) {
    throw new Error('Catalog manifest must match the released app and schema')
  }
  const { validateCatalogFile } = await import(
    pathToFileURL(path.join(compatDirectory, `v${currentVersion}-validator.mjs`)).href
  )
  for (const file of ['models.json', 'providers.json', 'provider-models.json']) {
    validateCatalogFile(file, JSON.parse(fs.readFileSync(path.join(sourceDirectory, file), 'utf8')))
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'downstream-catalog-'))
  try {
    for (const [name, contents] of Object.entries(before)) {
      fs.mkdirSync(path.dirname(path.join(temporary, name)), { recursive: true })
      fs.writeFileSync(path.join(temporary, name), Buffer.from(contents, 'base64'))
    }
    await publishRegistryCatalog({
      sourceDirectory,
      compatDirectory,
      destinationDirectory: temporary,
      currentVersion,
      minAppVersion,
      sourceAppVersion: version,
      revision: manifest.revision
    })
    if (JSON.stringify(catalogSnapshot(temporary)) !== JSON.stringify(before)) {
      throw new Error('Published catalog differs from the release bundle')
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

async function main() {
  const [catalogDirectory, commitFile] = process.argv.slice(2)
  const pin = require('./catalog-pin.json')
  validateCatalogCommit({
    pin,
    commit: JSON.parse(fs.readFileSync(commitFile, 'utf8')),
    branchHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: catalogDirectory, encoding: 'utf8' }).trim()
  })
  const root = path.resolve(__dirname, '../..')
  const loader = fs.readFileSync(path.join(root, 'packages/provider-registry/src/registry-loader.ts'), 'utf8')
  const currentVersion = Number(/REGISTRY_SCHEMA_VERSION = (\d+)/.exec(loader)?.[1])
  const minAppVersion = /REGISTRY_MIN_APP_VERSION = '([^']+)'/.exec(loader)?.[1]
  if (!Number.isSafeInteger(currentVersion) || !minAppVersion) throw new Error('Cannot resolve registry baseline')
  await verifyCatalogContents({
    catalogDirectory,
    sourceDirectory: path.join(root, 'packages/provider-registry/data'),
    compatDirectory: path.join(root, 'packages/provider-registry/compat'),
    currentVersion,
    minAppVersion,
    version: require('../../package.json').version
  })
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
module.exports = { validateCatalogCommit, verifyCatalogContents }
