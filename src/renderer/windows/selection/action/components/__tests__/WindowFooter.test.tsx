import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import WindowFooter from '../WindowFooter'

const { ipcRequest, listeners } = vi.hoisted(() => ({
  ipcRequest: vi.fn(),
  listeners: new Map<string, () => Promise<void>>()
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal())
vi.mock('@renderer/utils/platform', () => ({ isMac: true }))
vi.mock('@renderer/ipc', async () => {
  const { useEffect } = await import('react')
  return {
    ipcApi: { request: ipcRequest },
    useIpcOn: (event: string, handler: () => Promise<void>) => {
      useEffect(() => {
        listeners.set(event, handler)
        return () => {
          listeners.delete(event)
        }
      }, [event, handler])
    }
  }
})
vi.mock('react-i18next', async () => {
  const { default: en } = await import('@renderer/i18n/locales/en-us.json')
  return { useTranslation: () => ({ t: (key: string) => en[key as keyof typeof en] ?? key }) }
})

describe('WindowFooter', () => {
  beforeEach(() => {
    ipcRequest.mockReset()
    listeners.clear()
  })

  it('keeps Esc as stop/current-close and Command-Esc as close-all, including inside text fields', async () => {
    const user = userEvent.setup()
    const onPause = vi.fn()
    const { rerender } = render(<WindowFooter loading onPause={onPause} />)
    await user.keyboard('{Escape}')
    expect(onPause).toHaveBeenCalledOnce()
    expect(ipcRequest).not.toHaveBeenCalled()

    rerender(
      <>
        <input aria-label="Draft" />
        <WindowFooter />
      </>
    )
    await user.keyboard('{Escape}')
    expect(ipcRequest).toHaveBeenCalledWith('window.close')
    ipcRequest.mockClear()
    await user.click(screen.getByRole('textbox', { name: 'Draft' }))
    await user.keyboard('{Meta>}{Escape}{/Meta}')
    expect(ipcRequest.mock.calls).toEqual([['selection.close_action_windows']])
  })

  it('offers a named close-all button and waits for cancellation before closing a streaming window', async () => {
    const user = userEvent.setup()
    let finishStop!: () => void
    const stopped = new Promise<void>((resolve) => {
      finishStop = resolve
    })
    render(<WindowFooter loading onPause={() => stopped} />)
    await user.click(screen.getByRole('button', { name: 'Close all selection windows' }))
    expect(ipcRequest).toHaveBeenCalledWith('selection.close_action_windows')
    ipcRequest.mockClear()

    const closing = listeners.get('selection.close_action_window')!()
    expect(ipcRequest).not.toHaveBeenCalled()
    await act(async () => {
      finishStop()
      await closing
    })
    expect(ipcRequest.mock.calls).toEqual([['window.close']])
  })

  it('reveals full captions on keyboard focus and disables copying during generation', async () => {
    const user = userEvent.setup()
    render(<WindowFooter loading content="partial" onRegenerate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'C: Copy' })).toBeDisabled()
    await user.tab()
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Esc: Stop'))
    await user.tab()
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('R: Regenerate'))
    await user.tab()
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Close all selection windows'))
    fireEvent.blur(window)
  })
})
