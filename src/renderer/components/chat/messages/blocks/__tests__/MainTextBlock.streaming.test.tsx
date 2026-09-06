import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { MessageContentProvider } from '../../MessageContentProvider'
import MainTextBlock from '../MainTextBlock'

vi.unmock('@cherrystudio/ui')

afterEach(() => {
  vi.restoreAllMocks()
})

it('keeps the displayed emphasis intact until the completed response finishes playing out', async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrameId = 0
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++nextFrameId
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })

  const response = (content: string, isStreaming: boolean) => (
    <MessageContentProvider messages={[]} partsByMessageId={{}}>
      <MainTextBlock id="answer" role="assistant" content={content} isStreaming={isStreaming} />
    </MessageContentProvider>
  )
  const view = render(response('Read **this', true))
  const paragraph = await screen.findByRole('paragraph')
  expect(paragraph).toHaveTextContent('Read this')

  await act(async () => {
    view.rerender(response('Read **this passage**.', false))
  })

  expect(screen.getByRole('paragraph')).toHaveTextContent('Read this')

  for (let frame = 0; frame < 10; frame++) {
    now += 16
    const pendingFrames = [...frames.values()]
    frames.clear()
    await act(async () => {
      for (const callback of pendingFrames) callback(now)
    })
  }

  expect(screen.getByRole('paragraph')).toHaveTextContent('Read this passage.')
})
