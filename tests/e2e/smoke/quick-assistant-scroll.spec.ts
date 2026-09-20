import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'

let server: ViteDevServer
let url: string
let cacheDir: string

test.beforeAll(async () => {
  const fixture = '/tests/e2e/fixtures/QuickAssistantScroll.tsx'
  const inputs = ['useMessageListRenderConfig', 'useMessagePlatformActions', 'useTopicStreamStatus']
  mkdirSync(resolve('node_modules/.cache'), { recursive: true })
  cacheDir = mkdtempSync(resolve('node_modules/.cache/quick-assistant-scroll-'))
  server = await createServer({
    configFile: false,
    cacheDir,
    plugins: [
      {
        name: 'quick-assistant-scroll-inputs',
        enforce: 'pre',
        resolveId(source, importer) {
          const input = inputs.find((name) => source.endsWith(`/${name}`))
          if (input) return `\0scroll-input:${input}`
          if (source === './Message' && importer?.endsWith('/quickAssistant/chat/components/Messages.tsx')) {
            return '\0scroll-input:MessageItem'
          }
          if (source === '@cherrystudio/ui') return '\0scroll-input:Scrollbar'
          return undefined
        },
        load(id) {
          if (!id.startsWith('\0scroll-input:')) return
          const name = id.split(':')[1]
          if (name === 'Scrollbar') {
            return `export { default as Scrollbar } from '${resolve('packages/ui/src/components/composites/scrollbar/index.tsx')}'`
          }
          return `export { ${name}${name === 'MessageItem' ? ' as default' : ''} } from '${fixture}'`
        }
      },
      tailwindcss(),
      react()
    ],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
        '@logger': resolve('src/renderer/services/LoggerService'),
        '@data': resolve('src/renderer/data'),
        '@cherrystudio/ui/styles': resolve('packages/ui/src/styles'),
        '@cherrystudio/ui/lib': resolve('packages/ui/src/lib'),
        '@cherrystudio/provider-registry': resolve('packages/provider-registry/src')
      }
    },
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: {
      entries: ['tests/e2e/fixtures/quick-assistant-scroll.html'],
      include: ['react', 'react-dom/client', 'react-i18next', 'i18next']
    }
  })
  await server.listen()
  url = `${server.resolvedUrls!.local[0]}tests/e2e/fixtures/quick-assistant-scroll.html`
})

test.afterAll(async () => {
  try {
    await server?.close()
  } finally {
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Quick Assistant preserves the paragraph being read when completion shrinks content during scrolling', async ({
  page
}) => {
  await page.goto(url)
  const paragraph = page.getByText('Paragraph 30', { exact: true })
  const viewport = page.locator('#messages')
  await expect(paragraph).toBeAttached()
  await expect.poll(() => viewport.evaluate((element) => element.clientHeight)).toBeGreaterThan(400)
  await viewport.hover()
  await page.mouse.wheel(0, -100)
  await paragraph.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expect(paragraph).toBeInViewport()
  // Native gestures require a top-origin viewport: reversed offsets change origin as content shrinks.
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  const beforeHeight = await viewport.evaluate((element) => element.scrollHeight)
  const positions: number[] = []
  for (let index = 0; index < 24; index += 1) {
    await page.mouse.wheel(0, 3)
    if (index === 12) {
      // Trigger completion without moving the pointer or taking focus from the scroller.
      await page
        .getByRole('button', { name: 'Complete response' })
        .evaluate((element: HTMLButtonElement) => element.click())
    }
    positions.push(
      await paragraph.evaluate(async (element) => {
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
        return element.getBoundingClientRect().top
      })
    )
  }

  expect(beforeHeight - (await viewport.evaluate((element) => element.scrollHeight))).toBe(44)
  const largestJump = Math.max(...positions.slice(1).map((position, index) => Math.abs(position - positions[index])))
  expect(largestJump).toBeLessThan(12)
  await expect(paragraph).toBeInViewport()
})
