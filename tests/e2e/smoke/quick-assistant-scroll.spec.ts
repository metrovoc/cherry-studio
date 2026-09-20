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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'api', {
      value: { cache: { onSync: () => () => {}, getAllShared: async () => ({}) } }
    })
  })
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

test('Quick Assistant opens history at the question and restores reading across shorter conversations and loading', async ({
  page
}) => {
  await page.goto(url)
  const viewport = page.locator('#messages')
  await page.getByRole('button', { name: 'Open history', exact: true }).click()
  await expect(page.getByText('history-question: Original question', { exact: true })).toBeInViewport()
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0)

  const paragraph = page.getByText('Paragraph 30', { exact: true })
  await paragraph.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expect(paragraph).toBeInViewport()
  const readingTop = await paragraph.evaluate((element) => element.getBoundingClientRect().top)
  await page.getByRole('button', { name: 'Open short conversation', exact: true }).click()
  await expect(page.getByText('short-question: Original question', { exact: true })).toBeInViewport()
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0)

  await page.getByRole('button', { name: 'Reopen history with loading', exact: true }).click()
  await expect(page.getByText('short-question: Original question', { exact: true })).toBeInViewport()
  await expect(paragraph).not.toBeAttached()
  await page.getByRole('button', { name: 'Finish loading', exact: true }).click()
  await expect(paragraph).toBeInViewport()
  await expect.poll(() => paragraph.evaluate((element) => element.getBoundingClientRect().top)).toBe(readingTop)

  await page.getByRole('button', { name: 'Complete response', exact: true }).click()
  await expect.poll(() => paragraph.evaluate((element) => element.getBoundingClientRect().top)).toBe(readingTop)
})

test('Quick Assistant keeps the latest reading position while the same conversation is saved and history loads', async ({
  page
}) => {
  await page.goto(url)
  const viewport = page.locator('#messages')
  const paragraph = page.getByText('Paragraph 30', { exact: true })
  await expect(paragraph).toBeAttached()
  await viewport.hover()
  await page.mouse.wheel(0, -100)
  await paragraph.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expect(paragraph).toBeInViewport()

  await page
    .getByRole('button', { name: 'Save current conversation', exact: true })
    .evaluate((element: HTMLButtonElement) => element.click())
  const finishLoading = page.getByRole('button', { name: 'Finish loading', exact: true })
  await expect(finishLoading).toBeEnabled()
  const beforeWheel = await viewport.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, 120)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(beforeWheel + 120)
  const readingTop = await paragraph.evaluate((element) => element.getBoundingClientRect().top)

  await finishLoading.evaluate((element: HTMLButtonElement) => element.click())
  await expect(finishLoading).toBeDisabled()
  await expect.poll(() => paragraph.evaluate((element) => element.getBoundingClientRect().top)).toBe(readingTop)
  await expect(paragraph).toBeInViewport()

  await page
    .getByRole('button', { name: 'Complete response', exact: true })
    .evaluate((element: HTMLButtonElement) => element.click())
  await expect.poll(() => paragraph.evaluate((element) => element.getBoundingClientRect().top)).toBe(readingTop)
})

test('Quick Assistant keeps reading control when content collapses to bottom during one continuous scroll gesture', async ({
  page
}) => {
  await page.goto(url)
  const viewport = page.locator('#messages')
  await expect(page.getByText('Paragraph 79', { exact: true })).toBeAttached()
  await viewport.hover()
  await page.mouse.wheel(0, -100)
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeGreaterThan(50)
  const probe = await viewport.evaluateHandle((element) => {
    const article = element.querySelector('article')!
    const originalPadding = article.style.paddingBottom
    const snapshot = () => ({ top: element.scrollTop, bottom: element.scrollHeight - element.clientHeight })
    // Trailing layout changes model collapse and late content without replacing messages or disabling anchoring.
    article.style.paddingBottom = '44px'
    element.scrollTop = element.scrollHeight - element.clientHeight - 30
    const state = {
      trusted: true,
      before: snapshot(),
      collapseRequested: false,
      clampedAt: null as number | null,
      wheelWhileClamped: false,
      collapsed: null as ReturnType<typeof snapshot> | null,
      growth: null as ReturnType<typeof snapshot> | null,
      positions: [] as number[]
    }
    const onWheel = (event: Event) => {
      state.trusted &&= event.isTrusted
      if (!state.collapseRequested && element.scrollTop >= state.before.top + 4) {
        state.collapseRequested = true
        article.style.paddingBottom = '0px'
      }
      if (state.collapseRequested && state.clampedAt === null && snapshot().bottom === element.scrollTop) {
        state.clampedAt = event.timeStamp
        state.collapsed = snapshot()
      }
      if (state.clampedAt !== null && event.timeStamp > state.clampedAt) state.wheelWhileClamped = true
      if (state.clampedAt !== null && !state.growth && event.timeStamp - state.clampedAt > 300) {
        state.growth = snapshot()
        article.style.paddingBottom = '300px'
      }
    }
    const onScroll = () => {
      if (state.growth) state.positions.push(element.scrollTop)
    }
    element.addEventListener('wheel', onWheel, { passive: true })
    element.addEventListener('scroll', onScroll, { passive: true })
    return {
      state,
      dispose() {
        element.removeEventListener('wheel', onWheel)
        element.removeEventListener('scroll', onScroll)
        article.style.paddingBottom = originalPadding
      }
    }
  })
  const session = await page.context().newCDPSession(page)
  try {
    const bounds = (await viewport.boundingBox())!
    await session.send('Input.synthesizeScrollGesture', {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
      yDistance: -60,
      speed: 40,
      gestureSourceType: 'mouse',
      preventFling: false
    })
    const result = await probe.evaluate(({ state }) => state)
    expect(result.trusted).toBe(true)
    expect(result.wheelWhileClamped).toBe(true)
    expect(result.collapsed).not.toBeNull()
    expect(result.growth).not.toBeNull()
    expect(result.before.bottom - result.collapsed!.bottom).toBe(44)
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(result.growth!.top)
    const positions = [result.growth!.top, ...result.positions]
    const largestJump = Math.max(...positions.slice(1).map((position, index) => position - positions[index]))
    // Even coalesced input cannot move farther than the entire 60px gesture.
    expect(largestJump).toBeLessThanOrEqual(61)
    expect(
      await viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
    ).toBeGreaterThan(200)
  } finally {
    await probe.evaluate(({ dispose }) => dispose())
    await probe.dispose()
    await session.detach()
  }
})
