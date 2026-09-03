import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import SelectionToolbarView from '../SelectionToolbarView'

vi.mock('@renderer/assets/images/logo.png', () => ({ default: 'logo.png' }))

describe('SelectionToolbarView surface', () => {
  it('uses an opaque card as the default toolbar background', () => {
    const { container } = render(
      <SelectionToolbarView
        actionItems={[]}
        isCompact={false}
        handleAction={vi.fn()}
        copyIconStatus="normal"
        copyIconAnimation="none"
        showLogo
      />
    )

    expect(container.firstElementChild?.className).toContain('bg-card')
    expect(container.firstElementChild?.className).not.toContain('rgb(245_245_245_/_0.95)')
    expect(container.firstElementChild?.className).not.toContain('rgb(20_20_20_/_0.95)')
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
