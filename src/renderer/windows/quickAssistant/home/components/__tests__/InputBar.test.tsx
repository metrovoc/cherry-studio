import type * as CherryStudioUi from '@cherrystudio/ui'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import InputBar from '../InputBar'

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof CherryStudioUi>())

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: () => <span data-testid="model-avatar" />
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistantsApi: () => ({
    assistants: [
      { id: 'assistant-1', name: 'Writer' },
      { id: 'assistant-2', name: 'Researcher' }
    ],
    isLoading: false
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.models.quick_assistant_selection': 'Select Assistant',
        'selector.assistant.search_placeholder': 'Search assistants',
        'common.no_results': 'No results',
        'common.loading': 'Loading'
      })[key] ?? key
  })
}))

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterAll(() => {
  if (originalScrollIntoView) {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})

describe('InputBar', () => {
  it('stays transparent in both light and dark themes', () => {
    render(<InputBar text="" placeholder="Ask a model" handleKeyDown={vi.fn()} handleChange={vi.fn()} />)

    expect(screen.getByPlaceholderText('Ask a model')).toHaveClass(
      'rounded-none',
      'bg-transparent',
      'dark:bg-transparent'
    )
  })

  it('does not refocus the input when its text changes', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    const props = { placeholder: 'Ask a model', handleKeyDown: vi.fn(), handleChange: vi.fn() }
    const { rerender } = render(<InputBar {...props} text="" />)
    focus.mockClear()

    rerender(<InputBar {...props} text="日" />)

    expect(focus).not.toHaveBeenCalled()
    focus.mockRestore()
  })

  it('lets the user change the active assistant from the prompt row', async () => {
    const user = userEvent.setup()
    const onAssistantChange = vi.fn()

    render(
      <InputBar
        text=""
        assistant={{ id: 'assistant-1', name: 'Writer' } as never}
        model={{ id: 'provider::model', name: 'Writer model' } as never}
        placeholder="Ask Writer"
        onAssistantChange={onAssistantChange}
        handleKeyDown={vi.fn()}
        handleChange={vi.fn()}
      />
    )

    const trigger = screen.getByRole('button', { name: 'Select Assistant: Writer' })
    expect(trigger).toHaveTextContent('')
    expect(trigger.querySelector('svg')).toBeNull()
    expect(screen.getByTestId('model-avatar')).toBeInTheDocument()

    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: 'Researcher' }))

    expect(onAssistantChange).toHaveBeenCalledWith('assistant-2')
    await waitFor(() => expect(screen.getByPlaceholderText('Ask Writer')).toHaveFocus())
  })

  it('opens the assistant switcher when Tab is pressed in the prompt', () => {
    const handleKeyDown = vi.fn()

    render(
      <InputBar
        text=""
        assistant={{ id: 'assistant-1', name: 'Writer' } as never}
        model={{ id: 'provider::model', name: 'Writer model' } as never}
        placeholder="Ask Writer"
        onAssistantChange={vi.fn()}
        handleKeyDown={handleKeyDown}
        handleChange={vi.fn()}
      />
    )

    fireEvent.keyDown(screen.getByPlaceholderText('Ask Writer'), { key: 'Tab', code: 'Tab' })

    expect(screen.getByRole('option', { name: 'Researcher' })).toBeInTheDocument()
    expect(handleKeyDown).not.toHaveBeenCalled()
  })
})
