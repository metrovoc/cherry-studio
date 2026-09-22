import { defineCreator } from './types'

export default defineCreator({
  id: 'vercel',
  name: 'Vercel',
  modelsDevProviders: ['vercel'],
  idPrefixes: ['v0'],
  reasoningFamilies: [
    { pattern: '^arrow-2(?:-telos)?$' },
    { pattern: '^muse-spark' },
    { pattern: '^interfaze' },
    { pattern: '^laguna-s' },
    { pattern: '^fugu-(?:max|ultra-v2)', effort: ['high', 'xhigh', 'max'] }
  ]
})
