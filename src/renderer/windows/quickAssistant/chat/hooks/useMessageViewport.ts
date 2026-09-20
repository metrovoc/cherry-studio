import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react'

import { getDistanceToBottom, getRealBottom } from '@renderer/components/chat/messages/list/scrollGeometry'
import {
  clampForwardedWheelDelta,
  findVerticalWheelConsumer
} from '@renderer/components/chat/messages/list/ScrollOwnershipContext'
import { useAutoStickToBottom } from '@renderer/components/chat/messages/list/useAutoStickToBottom'
import { useViewportFollowState } from '@renderer/components/chat/messages/list/useViewportFollowState'

const BOTTOM_TOLERANCE_PX = 1
const KEYBOARD_INPUT_SELECTOR =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="listbox"],[role="slider"],[role="spinbutton"]'

interface MessageViewportOptions {
  scrollerRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  conversationKey: string
}

interface MessageViewportController {
  requestReadingControl(): void
  scrollToElement(element: HTMLElement, align?: 'start' | 'center'): void
  notifyWheelIntent(deltaY: number): void
  scrollByWheel(deltaY: number): boolean
}

/** Owns live-edge following; normal-flow browser anchoring preserves the reading viewport. */
export function useMessageViewport({
  scrollerRef,
  contentRef,
  conversationKey
}: MessageViewportOptions): MessageViewportController {
  const follow = useViewportFollowState()
  const inputDirectionRef = useRef(0)
  const stickToBottom = useCallback(() => {
    const scroller = scrollerRef.current
    if (scroller && Math.abs(getDistanceToBottom(scroller)) > BOTTOM_TOLERANCE_PX) {
      scroller.scrollTop = getRealBottom(scroller)
    }
  }, [scrollerRef])
  const autoStick = useAutoStickToBottom({ isFollowing: follow.isFollowing, stickToBottom })
  const requestReadingControl = useCallback(() => {
    inputDirectionRef.current = 0
    follow.enterReading('disclosure')
  }, [follow])
  const scrollToElement = useCallback(
    (element: HTMLElement, align: 'start' | 'center' = 'start') => {
      const scroller = scrollerRef.current
      if (!scroller) return
      inputDirectionRef.current = 0
      follow.enterReading('navigation')
      const elementRect = element.getBoundingClientRect()
      const offset = align === 'center' ? (scroller.clientHeight - elementRect.height) / 2 : 0
      scroller.scrollTop += elementRect.top - scroller.getBoundingClientRect().top - offset
    },
    [follow, scrollerRef]
  )
  const notifyWheelIntent = useCallback(
    (deltaY: number) => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const direction = Math.sign(deltaY)
      inputDirectionRef.current = direction
      if (direction < 0) follow.enterReading('user-scrolled-up')
      else if (direction > 0 && getDistanceToBottom(scroller) <= BOTTOM_TOLERANCE_PX) {
        follow.enterFollowing('user-reached-bottom')
      }
    },
    [follow, scrollerRef]
  )
  const scrollByWheel = useCallback(
    (deltaY: number) => {
      const scroller = scrollerRef.current
      if (!scroller) return false
      const delta = clampForwardedWheelDelta(deltaY)
      notifyWheelIntent(delta)
      scroller.scrollBy({ top: delta })
      return true
    },
    [notifyWheelIntent, scrollerRef]
  )

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) return

    follow.enterFollowing('restored-bottom')
    stickToBottom()
    let previousScrollTop = scroller.scrollTop
    inputDirectionRef.current = 0
    let draggingScrollbar = false

    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return
      const target = event.target instanceof Element ? event.target : null
      if (findVerticalWheelConsumer(target, event.deltaY, scroller)) return
      notifyWheelIntent(event.deltaY)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(KEYBOARD_INPUT_SELECTOR)) return
      let direction = 0
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) direction = -1
      else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) direction = 1
      else if (event.key === ' ' && !target?.closest('button,a[href],summary,[role="button"]')) {
        direction = event.shiftKey ? -1 : 1
      }
      if (direction === 0 || findVerticalWheelConsumer(target, direction, scroller)) return
      notifyWheelIntent(direction)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target !== scroller || event.button !== 0) return
      draggingScrollbar = true
      follow.enterReading('user-scrolled-up')
    }
    const onPointerUp = () => {
      draggingScrollbar = false
      inputDirectionRef.current = 0
    }
    const onScroll = () => {
      const delta = scroller.scrollTop - previousScrollTop
      previousScrollTop = scroller.scrollTop
      if (draggingScrollbar && delta < 0) follow.enterReading('user-scrolled-up')
      if (
        delta > 0 &&
        (inputDirectionRef.current > 0 || draggingScrollbar) &&
        getDistanceToBottom(scroller) <= BOTTOM_TOLERANCE_PX
      ) {
        follow.enterFollowing('user-reached-bottom')
      }
    }
    const onScrollEnd = () => {
      inputDirectionRef.current = 0
    }

    // Content changes never write scrollTop in reading mode, including during trackpad momentum.
    const observer = new ResizeObserver(autoStick.onContentSizeChange)
    observer.observe(content)
    observer.observe(scroller)
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('keydown', onKeyDown)
    scroller.addEventListener('pointerdown', onPointerDown, { passive: true })
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('scrollend', onScrollEnd, { passive: true })
    const ownerDocument = scroller.ownerDocument
    ownerDocument.addEventListener('pointerup', onPointerUp, { passive: true })
    ownerDocument.addEventListener('pointercancel', onPointerUp, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('keydown', onKeyDown)
      scroller.removeEventListener('pointerdown', onPointerDown)
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('scrollend', onScrollEnd)
      ownerDocument.removeEventListener('pointerup', onPointerUp)
      ownerDocument.removeEventListener('pointercancel', onPointerUp)
    }
  }, [autoStick, contentRef, conversationKey, follow, notifyWheelIntent, scrollerRef, stickToBottom])

  return { requestReadingControl, scrollToElement, notifyWheelIntent, scrollByWheel }
}
