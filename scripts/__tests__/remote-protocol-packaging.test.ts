import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const { PnpmNodeModulesCollector } = builderRequire(
  'app-builder-lib/out/node-module-collector/pnpmNodeModulesCollector'
)
const { TmpDir } = builderRequire('temp-file')

type CollectedModule = { name: string; dir: string; dependencies?: CollectedModule[] }

it('loads every packaged remote protocol export and validates failures without development dependencies', async () => {
  const collectorDirectory = new TmpDir()
  const staging = mkdtempSync(path.join(tmpdir(), 'cherry-protocol-packaging-'))
  try {
    const { nodeModules }: { nodeModules: CollectedModule[] } = await new PnpmNodeModulesCollector(
      projectRoot,
      collectorDirectory
    ).getNodeModules({ packageName: 'CherryStudio' })
    const copied = new Set<string>()
    const copyModule = (node: CollectedModule, parent: string) => {
      const destination = path.join(parent, 'node_modules', node.name)
      if (copied.has(destination)) return
      copied.add(destination)
      mkdirSync(path.dirname(destination), { recursive: true })
      cpSync(node.dir, destination, {
        recursive: true,
        filter: (source) => source !== path.join(node.dir, 'node_modules')
      })
      for (const dependency of node.dependencies ?? []) copyModule(dependency, destination)
      const manifest = JSON.parse(readFileSync(path.join(node.dir, 'package.json'), 'utf8'))
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
        const dependency = nodeModules.find((candidate) => candidate.name === name)
        if (dependency) copyModule(dependency, staging)
      }
    }
    const protocol = nodeModules.find((node) => node.name === '@cherrystudio/remote-protocol')
    expect(protocol).toBeDefined()
    copyModule(protocol!, staging)
    const manifest = JSON.parse(readFileSync(path.join(protocol!.dir, 'package.json'), 'utf8'))
    const exports = Object.keys(manifest.exports).map((key) => `${manifest.name}${key === '.' ? '' : key.slice(1)}`)
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import assert from 'node:assert/strict';
          for (const name of ${JSON.stringify(exports)}) await import(name);
          const { executionFailureSchema } = await import('@cherrystudio/remote-protocol/failure');
          const failure = {
            message: 'Request timed out', retryable: true,
            failure: { version: 1, reasonCode: 'timeout', source: { layer: 'provider' } }
          };
          assert.deepEqual(executionFailureSchema.parse(failure), failure);
          assert.equal(executionFailureSchema.safeParse({ ...failure, retryable: 'yes' }).success, false);
          process.stdout.write('validated');
        `
      ],
      { cwd: staging, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } }
    )
    expect(output).toBe('validated')
  } finally {
    rmSync(staging, { recursive: true, force: true })
    await collectorDirectory.cleanup()
  }
}, 60_000)
