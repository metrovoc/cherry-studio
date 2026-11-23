import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { it } from 'vitest'

function runNativeFixture(fixture: string, extraSources: string[]): void {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'selection-hook-test-'))
  try {
    const source = path.join(path.dirname(createRequire(import.meta.url).resolve('selection-hook')), 'src/mac')
    const executable = path.join(temporaryDirectory, 'selection-hook-test')
    execFileSync('clang++', [
      '-std=c++17',
      '-I',
      source,
      '-framework',
      'Cocoa',
      '-framework',
      'ApplicationServices',
      '-framework',
      'Carbon',
      path.join(import.meta.dirname, 'fixtures', fixture),
      ...extraSources.map((relativePath) => path.join(source, relativePath)),
      '-o',
      executable
    ])
    execFileSync(executable, { stdio: 'pipe' })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

it.skipIf(process.platform !== 'darwin')(
  'reads exact macOS selection text and preserves unsupported-provider fallbacks',
  () => {
    runNativeFixture('macos-selection.mm', ['core/engine.mm', 'lib/utils.mm', 'lib/clipboard.mm'])
  },
  30_000
)

it.skipIf(process.platform !== 'darwin')(
  'recovers confirmed rich macOS selections via source copy without clobbering clipboard state',
  () => {
    runNativeFixture('macos-selection-clipboard.mm', ['core/engine.mm'])
  },
  30_000
)
