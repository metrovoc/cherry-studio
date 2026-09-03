import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { SelectionAction } from '@shared/types/selection'

import SelectionToolbarView from '../SelectionToolbarView'

vi.mock('@renderer/assets/images/logo.png', () => ({ default: 'logo.png' }))

describe('SelectionToolbarView unavailable actions', () => {
  const ACTIONS: SelectionAction[] = [
    { id: 'ask-agent', name: 'Ask Agent', enabled: true, isBuiltIn: true },
    { id: 'summary', name: 'Summary', enabled: true, isBuiltIn: true }
  ]

  it.each([false, true])('ignores clicks and exposes the reason (compact: %s)', (isCompact) => {
    const handleAction = vi.fn()
    render(
      <SelectionToolbarView
        actionItems={ACTIONS}
        isCompact={isCompact}
        handleAction={handleAction}
        copyIconStatus="normal"
        copyIconAnimation="none"
        unavailableReasons={{ 'ask-agent': 'No model set' }}
        showLogo
      />
    )

    const askAgent = screen.getByRole('button', { name: 'Ask Agent' })
    expect(askAgent).toHaveAttribute('aria-disabled', 'true')
    expect(askAgent).toHaveAttribute('aria-description', 'No model set')
    fireEvent.click(askAgent)
    expect(handleAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }))
    expect(handleAction).toHaveBeenCalledWith(ACTIONS[1])
  })

  it('gives the action surface complete rounded corners when the logo is hidden', () => {
    const { container } = render(
      <SelectionToolbarView
        actionItems={[{ id: 'copy', name: 'selection.action.builtin.copy', enabled: true, isBuiltIn: true }]}
        isCompact
        handleAction={vi.fn()}
        copyIconStatus="normal"
        copyIconAnimation="none"
        showLogo={false}
      />
    )

    expect(container.querySelector('img')).not.toBeInTheDocument()
    const actionSurface = container.firstElementChild?.firstElementChild
    // These classes are the frameless-window corner and border contract.
    expect(actionSurface).toHaveClass('rounded-[10px]', '[border-width:0.5px]')
    expect(actionSurface?.className).toContain('[&>button:first-child]:rounded-l-[10px]')
  })
})
