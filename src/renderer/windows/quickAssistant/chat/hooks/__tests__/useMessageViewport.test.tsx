// @vitest-environment jsdom
import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useScrollAnchor } from '@renderer/components/chat/messages/blocks/useScrollAnchor'
import { ScrollOwnershipProvider } from '@renderer/components/chat/messages/list/ScrollOwnershipContext'

import { useMessageViewport } from '../useMessageViewport'

let resizeCallbacks: Set<() => void>

beforeEach(() => {
  MockCacheUtils.resetMocks()
  resizeCallbacks = new Set()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private notify: () => void

      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this)
        resizeCallbacks.add(this.notify)
      }

      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.notify)
      }
    }
  )
})

afterEach(() => vi.unstubAllGlobals())

function setupViewport() {
  const scroller = document.createElement('div')
  const content = document.createElement('div')
  scroller.append(content)
  scroller.style.overflowY = 'auto'
  const geometry = { scrollHeight: 1000, clientHeight: 200 }
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => geometry.scrollHeight },
    clientHeight: { get: () => geometry.clientHeight }
  })
  const scrollerRef = { current: scroller }
  const contentRef = { current: content }
  const { result, rerender, unmount } = renderHook(
    ({
      conversationKey,
      ready = true,
      initialPosition = 'end'
    }: {
      conversationKey: string
      ready?: boolean
      initialPosition?: 'start' | 'end'
    }) => useMessageViewport({ scrollerRef, contentRef, conversationKey, ready, initialPosition }),
    { initialProps: { conversationKey: 'conversation-a', ready: true, initialPosition: 'end' } }
  )

  return {
    scroller,
    content,
    controller: result,
    rerender,
    unmount,
    resize(scrollHeight: number, clientHeight = geometry.clientHeight) {
      geometry.scrollHeight = scrollHeight
      geometry.clientHeight = clientHeight
      act(() => resizeCallbacks.forEach((callback) => callback()))
    },
    scroll(top: number) {
      scroller.scrollTop = top
      fireEvent.scroll(scroller)
    },
    wheel(deltaY: number, target = scroller) {
      fireEvent.wheel(target, { deltaY })
    },
    scrollEnd() {
      fireEvent(scroller, new Event('scrollend'))
    }
  }
}

describe('Quick Assistant message viewport', () => {
  it('starts at the latest answer and follows content and viewport size changes', () => {
    const view = setupViewport()
    expect(view.scroller.scrollTop).toBe(800)

    view.resize(1400)
    expect(view.scroller.scrollTop).toBe(1200)
    view.resize(1400, 300)
    expect(view.scroller.scrollTop).toBe(1100)
  })

  it('yields before the first upward scroll and preserves ongoing downward momentum through completion', () => {
    const view = setupViewport()
    view.wheel(-20)
    view.resize(1500)
    expect(view.scroller.scrollTop).toBe(800)

    view.scroll(700)
    view.wheel(20)
    view.scroll(730)
    view.resize(1456)
    expect(view.scroller.scrollTop).toBe(730)

    view.scrollEnd()
    view.resize(1600)
    expect(view.scroller.scrollTop).toBe(730)
  })

  it('does not resume following when content collapse passively reaches the bottom during a downward gesture', () => {
    const view = setupViewport()
    view.wheel(-20)
    view.scroll(600)
    view.wheel(20)
    view.scroll(620)

    view.resize(760)
    view.scroll(560)
    view.wheel(10)
    view.wheel(5)
    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(560)

    view.scrollEnd()
    view.scroll(1000)
    view.wheel(20)
    view.resize(1300)
    expect(view.scroller.scrollTop).toBe(1100)
  })

  it('resumes following when the user scrolls back to the live bottom', () => {
    const view = setupViewport()
    view.wheel(-20)
    view.scroll(400)
    view.scrollEnd()
    view.wheel(400)
    view.scroll(800)
    view.scrollEnd()

    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(1000)
  })

  it('keeps reading after a passive scroll reaches the bottom, until a deliberate downward input', () => {
    const view = setupViewport()
    view.wheel(-20)
    view.scroll(400)
    view.scrollEnd()
    view.scroll(800)
    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(800)

    view.scroll(1000)
    view.wheel(20)
    view.resize(1300)
    expect(view.scroller.scrollTop).toBe(1100)
  })

  it('leaves nested scrolling local and detaches when wheel input chains out of the nested boundary', () => {
    const view = setupViewport()
    const nested = document.createElement('div')
    nested.style.overflowY = 'auto'
    Object.defineProperties(nested, { scrollHeight: { value: 600 }, clientHeight: { value: 200 } })
    nested.scrollTop = 50
    view.content.append(nested)

    view.wheel(-20, nested)
    view.resize(1100)
    expect(view.scroller.scrollTop).toBe(900)

    nested.scrollTop = 0
    view.wheel(-20, nested)
    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(900)
  })

  it('supports keyboard reading and returning to the bottom without treating editor arrows as scroll intent', () => {
    const view = setupViewport()
    const input = document.createElement('input')
    view.content.append(input)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    view.resize(1100)
    expect(view.scroller.scrollTop).toBe(900)

    fireEvent.keyDown(view.scroller, { key: 'PageUp' })
    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(900)
    view.scroll(600)
    fireEvent.keyDown(view.scroller, { key: 'End' })
    view.scroll(1000)
    view.resize(1300)
    expect(view.scroller.scrollTop).toBe(1100)
  })

  it('lets native scrollbar dragging detach and return to following', () => {
    const view = setupViewport()
    fireEvent(view.scroller, new MouseEvent('pointerdown', { button: 0 }))
    view.scroll(500)
    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(500)

    view.scroll(1000)
    fireEvent(document, new MouseEvent('pointerup', { button: 0 }))
    view.resize(1300)
    expect(view.scroller.scrollTop).toBe(1100)
  })

  it('opens unseen history at the beginning and restores each conversation through loading', () => {
    const view = setupViewport()
    view.wheel(-20)
    view.scroll(400)
    view.rerender({ conversationKey: 'conversation-a' })
    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(400)

    // React can replace the old content before layout-effect cleanup, clamping the DOM offset.
    view.scroller.scrollTop = 0
    view.rerender({ conversationKey: 'conversation-b', ready: false, initialPosition: 'start' })
    view.resize(200)
    view.rerender({ conversationKey: 'conversation-b', initialPosition: 'start' })
    view.resize(1600)
    expect(view.scroller.scrollTop).toBe(0)
    view.scroll(250)

    view.rerender({ conversationKey: 'conversation-a', ready: false })
    view.resize(200)
    view.resize(1200)
    view.rerender({ conversationKey: 'conversation-a' })
    expect(view.scroller.scrollTop).toBe(400)
    view.resize(1600)
    expect(view.scroller.scrollTop).toBe(400)

    view.rerender({ conversationKey: 'conversation-b', initialPosition: 'start' })
    expect(view.scroller.scrollTop).toBe(250)
  })

  it('retains reading position across remounts and resumes following only for a saved following conversation', () => {
    const view = setupViewport()
    view.wheel(-20)
    view.scroll(400)
    view.unmount()

    const restored = setupViewport()
    expect(restored.scroller.scrollTop).toBe(400)
    restored.wheel(400)
    restored.scroll(800)
    restored.rerender({ conversationKey: 'conversation-b', initialPosition: 'start' })
    restored.resize(1400)
    expect(restored.scroller.scrollTop).toBe(0)
    restored.rerender({ conversationKey: 'conversation-a' })
    expect(restored.scroller.scrollTop).toBe(1200)
    restored.resize(1600)
    expect(restored.scroller.scrollTop).toBe(1400)
  })

  it('lets a disclosure retain reading control when its expansion creates the first overflow', () => {
    const scroller = document.createElement('div')
    const content = document.createElement('div')
    const disclosure = document.createElement('button')
    scroller.append(content)
    content.append(disclosure)
    let height = 200
    Object.defineProperties(scroller, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 200 }
    })
    const scrollerRef = { current: scroller }
    const contentRef = { current: content }
    const { result } = renderHook(
      () => ({
        viewport: useMessageViewport({ scrollerRef, contentRef, conversationKey: 'disclosure' }),
        anchor: useScrollAnchor<HTMLButtonElement>()
      }),
      {
        wrapper: ({ children }) => (
          <ScrollOwnershipProvider
            scrollContainerRef={scrollerRef}
            requestReadingControl={() => result.current.viewport.requestReadingControl()}>
            {children}
          </ScrollOwnershipProvider>
        )
      }
    )
    result.current.anchor.anchorRef.current = disclosure
    act(() => {
      result.current.anchor.withScrollAnchor(() => (height = 1000), { enterReadingMode: true })
      resizeCallbacks.forEach((callback) => callback())
    })
    expect(scroller.scrollTop).toBe(0)
  })

  it('keeps explicit element navigation in reading mode as later content arrives', () => {
    const view = setupViewport()
    const target = document.createElement('p')
    view.content.append(target)
    target.getBoundingClientRect = () => ({ top: -400, height: 40 }) as DOMRect
    act(() => view.controller.current.scrollToElement(target))
    expect(view.scroller.scrollTop).toBe(400)
    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(400)
  })

  it('routes wheel input from an embedded document into this viewport and yields following', () => {
    const view = setupViewport()
    Object.defineProperty(view.scroller, 'scrollBy', {
      value: (options: ScrollToOptions) => view.scroll(view.scroller.scrollTop + (options.top ?? 0))
    })
    act(() => {
      view.controller.current.scrollByWheel(-50)
    })
    expect(view.scroller.scrollTop).toBe(750)
    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(750)
  })

  it('stops writing to the viewport after disposal', () => {
    const view = setupViewport()
    view.unmount()
    view.resize(1200)
    expect(view.scroller.scrollTop).toBe(800)
  })
})
