import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { selectionHookFilters } from '../before-pack'

const projectRoot = path.join(import.meta.dirname, '..', '..')

describe('selection-hook packaging', () => {
  it.each(['darwin', 'linux', 'win32'])('ships the correct selection-hook binary on %s', (platform) => {
    const config = parse(readFileSync(path.join(projectRoot, 'electron-builder.yml'), 'utf8')) as {
      files?: string[]
    }

    const selectionHookPatterns = [...(config.files ?? []), ...selectionHookFilters(platform)].filter((entry) =>
      entry.includes('node_modules/selection-hook/')
    )

    if (platform === 'darwin') {
      expect(selectionHookPatterns).toContain('!node_modules/selection-hook/prebuilds/**')
      expect(selectionHookPatterns.some((entry) => entry.includes('/build/'))).toBe(false)
    } else {
      expect(selectionHookPatterns).toContain('!node_modules/selection-hook/build/**')
      expect(selectionHookPatterns.some((entry) => entry.includes('/prebuilds/'))).toBe(false)
    }
  })
})
