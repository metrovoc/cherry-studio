import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import InputBar from '../InputBar'

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
})
