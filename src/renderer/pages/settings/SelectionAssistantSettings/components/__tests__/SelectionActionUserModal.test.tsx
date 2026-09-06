import type { SelectionActionItem } from '@shared/data/preference/preferenceTypes'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import SelectionActionUserModal from '../SelectionActionUserModal'

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: () => null
}))

vi.mock('@renderer/components/CopyButton', () => ({
  default: () => null
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistants: () => ({ assistants: [] })
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useDefaultModel: () => ({ defaultModel: undefined })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('SelectionActionUserModal', () => {
  it('preserves a long prompt when confirming the action', () => {
    const longPrompt = 'Keep the prompt inside the dialog.\n'.repeat(200)
    const onOk = vi.fn()
    const editingAction: SelectionActionItem = {
      id: 'user-long-prompt',
      name: 'Long prompt',
      enabled: true,
      isBuiltIn: false,
      prompt: longPrompt
    }

    render(<SelectionActionUserModal isModalOpen editingAction={editingAction} onOk={onOk} onCancel={vi.fn()} />)

    const prompt = screen.getByPlaceholderText('selection.settings.user_modal.prompt.placeholder')
    expect(prompt).toHaveValue(longPrompt)
    const confirmButton = screen.getByRole('button', { name: 'common.confirm' })
    expect(confirmButton).toBeVisible()

    fireEvent.click(confirmButton)

    expect(onOk).toHaveBeenCalledWith(editingAction)
  })
})
