import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { it } from 'vitest'

it.skipIf(process.platform !== 'darwin')(
  'reads exact macOS selection text and preserves unsupported-provider fallbacks',
  () => {
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
        path.join(import.meta.dirname, 'fixtures/macos-selection.mm'),
        path.join(source, 'core/engine.mm'),
        path.join(source, 'lib/utils.mm'),
        path.join(source, 'lib/clipboard.mm'),
        '-o',
        executable
      ])
      execFileSync(executable, { stdio: 'pipe' })
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  },
  30_000
)
