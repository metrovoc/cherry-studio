import '@testing-library/jest-dom/vitest'

import type { CherryMessagePart, CherryUIMessage } from '@shared/data/types/message'
import { readCherryMeta } from '@shared/data/types/uiParts'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TestModel = {
  id: `${string}::${string}`
  modelId: string
  name: string
  providerId: string
  group: string
}

const state = vi.hoisted(() => ({
  quickAssistantId: '',
  saveConversations: false,
  assistants: [{ id: 'assistant-1', name: 'Assistant' }],
  haveAssistantsLoaded: true,
  streamStatus: undefined as 'done' | 'error' | 'streaming' | undefined,
  defaultModel: {
    id: 'cherryai::qwen',
    modelId: 'qwen',
    name: 'Qwen',
    providerId: 'cherryai',
    group: 'CherryAI'
  },
  quickModel: {
    id: 'anthropic::claude-sonnet',
    modelId: 'claude-sonnet',
    name: 'Claude Sonnet',
    providerId: 'anthropic',
    group: 'Anthropic'
  } as TestModel | undefined,
  messages: [] as CherryUIMessage[],
  activeExecutions: [] as never[],
  liveAssistants: [] as never[],
  sendMessage: vi.fn(),
  stopChat: vi.fn(),
  setMessages: vi.fn(),
  resetExecutionMessages: vi.fn(),
  clearExecutionMessages: vi.fn(),
  resetTemporaryTopic: vi.fn(),
  persistTemporaryTopic: vi.fn(),
  setQuickAssistantId: vi.fn(),
  setSaveConversations: vi.fn(),
  ipcRequest: vi.fn(),
  historyTopics: [] as Array<{ id: string; name: string }>,
  dispatchListener: undefined as
    | ((
        result:
          | { ok: true; topicId: string; ack: { mode: 'started'; reservedMessages?: CherryUIMessage[] } }
          | { ok: false; topicId: string; error: Error }
      ) => void)
    | undefined
}))

import HomeWindow, { finalizeLiveMessages } from '../HomeWindow'

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: state.ipcRequest, on: vi.fn(() => () => {}) },
  useIpcOn: vi.fn()
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: state.messages,
    sendMessage: state.sendMessage,
    stop: state.stopChat,
    setMessages: state.setMessages
  })
}))

vi.mock('@renderer/services/aiTransport', () => ({
  ipcChatTransport: {},
  streamDispatchService: {
    subscribe: vi.fn((_topicId: string, listener: typeof state.dispatchListener) => {
      state.dispatchListener = listener
      return () => {
        if (state.dispatchListener === listener) state.dispatchListener = undefined
      }
    })
  }
}))

vi.mock('@data/hooks/usePreference', () => ({
  usePreference: (key: string) => {
    const values: Record<string, unknown> = {
      'feature.quick_assistant.read_clipboard_at_startup': false,
      'feature.quick_assistant.assistant_id': state.quickAssistantId,
      'feature.quick_assistant.save_conversations': state.saveConversations,
      'app.language': 'en-US',
      'ui.window_style': 'default'
    }
    const setters: Record<string, unknown> = {
      'feature.quick_assistant.assistant_id': state.setQuickAssistantId,
      'feature.quick_assistant.save_conversations': state.setSaveConversations
    }
    return [values[key], setters[key] ?? vi.fn()]
  }
}))

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light' })
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: (assistantId: string) => ({
    assistant: assistantId ? { id: assistantId, name: 'Assistant' } : undefined,
    model: undefined
  }),
  useAssistants: () => ({ assistants: state.assistants, hasLoaded: state.haveAssistantsLoaded })
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useDefaultModel: () => ({ defaultModel: state.defaultModel, quickModel: state.quickModel })
}))

vi.mock('@renderer/hooks/useTemporaryTopic', () => ({
  useTemporaryTopic: () => ({
    topicId: 'temp-topic',
    ready: true,
    reset: state.resetTemporaryTopic,
    persist: state.persistTemporaryTopic
  })
}))

vi.mock('@renderer/hooks/useTopicStreamStatus', () => ({
  useTopicStreamStatus: () => ({
    status: state.streamStatus,
    activeExecutions: state.activeExecutions,
    isPending: state.streamStatus === 'streaming'
  })
}))

vi.mock('@renderer/hooks/useExecutionOverlay', () => ({
  useExecutionOverlay: () => ({
    liveAssistants: state.liveAssistants,
    reset: state.resetExecutionMessages,
    clear: state.clearExecutionMessages
  })
}))

vi.mock('@renderer/hooks/useTopicMessages', () => ({
  useTopicMessages: () => ({ uiMessages: [], activeNodeId: null, isLoading: false })
}))

vi.mock('../hooks/useQuickAssistantHistory', () => ({
  useQuickAssistantHistory: () => ({
    topics: state.historyTopics,
    isLoading: false,
    isRefreshing: false,
    hasNext: false,
    loadNext: vi.fn()
  })
}))

vi.mock('@renderer/i18n/resolver', () => ({
  default: { changeLanguage: vi.fn() }
}))

// Stub the message-list projection helper so this lightweight window (which only projects
// messages) doesn't pull the whole message-rendering package into the test.
vi.mock('@renderer/components/chat/messages/utils/messageListItem', () => ({
  toMessageListItem: (message: unknown) => message
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      key === 'quickAssistant.input.placeholder.empty' ? `Ask ${options?.model ?? ''}` : key
  })
}))

vi.mock('../components/InputBar', () => ({
  default: ({
    text,
    placeholder,
    assistant,
    onAssistantChange,
    handleChange,
    handleKeyDown,
    ref
  }: {
    text: string
    placeholder: string
    assistant?: { id: string; name: string }
    onAssistantChange?: (assistantId: string) => void
    handleChange: (event: React.ChangeEvent<HTMLInputElement>) => void
    handleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
    ref?: React.RefObject<HTMLDivElement | null>
  }) => (
    <div ref={ref}>
      {assistant && onAssistantChange && (
        <button type="button" onClick={() => onAssistantChange('assistant-2')}>
          Change assistant
        </button>
      )}
      <input
        data-testid="quick-input"
        value={text}
        placeholder={placeholder}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
    </div>
  )
}))

vi.mock('../components/Footer', () => ({
  default: () => <div data-testid="footer" />
}))

vi.mock('../components/ClipboardPreview', () => ({
  default: ({ clipboardText }: { clipboardText: string }) =>
    clipboardText ? <div data-testid="clipboard-preview">{clipboardText}</div> : null
}))

vi.mock('../../chat/ChatWindow', () => ({
  default: () => <div data-testid="chat-window" />
}))

describe('finalizeLiveMessages', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('finalizes streaming content parts without replacing unchanged messages', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1500)
    const liveMessage = {
      id: 'live-message',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'answer', state: 'streaming' },
        {
          type: 'reasoning',
          text: 'thinking',
          state: 'streaming',
          providerMetadata: { cherry: { startedAt: 1000 } }
        }
      ]
    } as CherryUIMessage
    const unchangedMessage = {
      id: 'done-message',
      role: 'assistant',
      parts: [{ type: 'text', text: 'done', state: 'done' }]
    } as CherryUIMessage

    const result = finalizeLiveMessages([liveMessage, unchangedMessage])

    expect(result[0].parts[0]).toMatchObject({ type: 'text', state: 'done' })
    expect(result[0].parts[1]).toMatchObject({ type: 'reasoning', state: 'done' })
    expect(readCherryMeta(result[0].parts[1] as CherryMessagePart)).toMatchObject({
      startedAt: 1000,
      thinkingMs: 500
    })
    expect(result[1]).toBe(unchangedMessage)
  })
})

describe('HomeWindow', () => {
  beforeEach(() => {
    state.quickAssistantId = ''
    state.quickModel = {
      id: 'anthropic::claude-sonnet',
      modelId: 'claude-sonnet',
      name: 'Claude Sonnet',
      providerId: 'anthropic',
      group: 'Anthropic'
    }
    state.saveConversations = false
    state.assistants = [{ id: 'assistant-1', name: 'Assistant' }]
    state.haveAssistantsLoaded = true
    state.streamStatus = undefined
    state.messages = []
    state.activeExecutions = []
    state.liveAssistants = []
    state.sendMessage.mockClear()
    state.stopChat.mockClear()
    state.setMessages.mockClear()
    state.setMessages.mockImplementation((next) => {
      state.messages = typeof next === 'function' ? next(state.messages) : next
    })
    state.resetExecutionMessages.mockClear()
    state.clearExecutionMessages.mockClear()
    state.resetTemporaryTopic.mockClear()
    state.persistTemporaryTopic.mockReset().mockResolvedValue(undefined)
    state.setQuickAssistantId.mockClear()
    state.setSaveConversations.mockClear()
    state.ipcRequest.mockClear()
    state.historyTopics = []
    state.dispatchListener = undefined
  })

  it('persists an assistant selected from the quick assistant home view', async () => {
    const user = userEvent.setup()
    state.quickAssistantId = 'assistant-1'

    render(<HomeWindow draggable={false} />)
    await user.click(screen.getByRole('button', { name: 'Change assistant' }))

    expect(state.setQuickAssistantId).toHaveBeenCalledWith('assistant-2')
    await waitFor(() => expect(screen.getByTestId('quick-input')).toHaveFocus())
  })

  it('starts a fresh home conversation when the assistant changes after a response', async () => {
    const user = userEvent.setup()
    state.quickAssistantId = 'assistant-1'

    render(<HomeWindow draggable={false} />)
    await user.type(screen.getByTestId('quick-input'), 'hello')
    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('chat-window')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Change assistant' }))

    expect(screen.getByTestId('quick-input')).toBeInTheDocument()
    expect(state.resetTemporaryTopic).toHaveBeenCalledOnce()
    expect(state.setQuickAssistantId).toHaveBeenCalledWith('assistant-2')
    await waitFor(() => expect(screen.getByTestId('quick-input')).toHaveFocus())
  })

  it('uses the configured quick model in model-only mode', () => {
    const quickModelId = state.quickModel!.id
    render(<HomeWindow draggable={false} />)

    const input = screen.getByTestId('quick-input')
    expect(input).toHaveAttribute('placeholder', 'Ask Claude Sonnet')

    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { code: 'Enter', key: 'Enter' })

    expect(state.sendMessage).toHaveBeenCalledWith({ text: 'hello' }, { body: { mentionedModels: [quickModelId] } })
  })

  it('does not fall back to the default model while the quick model is unresolved', () => {
    state.quickModel = undefined

    render(<HomeWindow draggable={false} />)

    expect(screen.queryByTestId('quick-input')).not.toBeInTheDocument()
    expect(state.sendMessage).not.toHaveBeenCalled()
  })

  it('continues from the latest assistant after the topic is saved', async () => {
    const user = userEvent.setup()
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true
    const { rerender } = render(<HomeWindow draggable={false} />)

    await user.type(screen.getByTestId('quick-input'), 'My dog is Jack')
    await user.keyboard('{Enter}')
    state.streamStatus = 'streaming'
    state.activeExecutions = [{}] as never[]
    rerender(<HomeWindow draggable={false} />)
    state.streamStatus = 'done'
    state.activeExecutions = []
    state.liveAssistants = [{ id: 'assistant-turn-1', role: 'assistant', parts: [] }] as never[]
    rerender(<HomeWindow draggable={false} />)
    await waitFor(() => expect(state.persistTemporaryTopic).toHaveBeenCalledWith('My dog is Jack'))
    await waitFor(() => expect(screen.getByTestId('quick-input')).not.toBeDisabled())

    await user.type(screen.getByTestId('quick-input'), 'What is my dog called?')
    await user.keyboard('{Enter}')

    expect(state.sendMessage).toHaveBeenLastCalledWith(
      { text: 'What is my dog called?' },
      { body: { parentAnchorId: 'assistant-turn-1' } }
    )
  })

  it('keeps typed input out of the clipboard preview', () => {
    render(<HomeWindow draggable={false} />)

    fireEvent.change(screen.getByTestId('quick-input'), { target: { value: 'hello' } })

    expect(screen.getByTestId('quick-input')).toHaveValue('hello')
    expect(screen.queryByTestId('clipboard-preview')).not.toBeInTheDocument()
  })

  it('names a saved conversation from the first successful request', async () => {
    const user = userEvent.setup()
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true
    const { rerender } = render(<HomeWindow draggable={false} />)

    await user.type(screen.getByTestId('quick-input'), 'Failed question')
    await user.keyboard('{Enter}')

    state.streamStatus = 'streaming'
    rerender(<HomeWindow draggable={false} />)
    state.streamStatus = 'error'
    rerender(<HomeWindow draggable={false} />)
    expect(state.persistTemporaryTopic).not.toHaveBeenCalled()

    await user.type(screen.getByTestId('quick-input'), 'Successful question')
    await user.keyboard('{Enter}')

    state.streamStatus = 'done'
    rerender(<HomeWindow draggable={false} />)

    await waitFor(() => {
      expect(state.persistTemporaryTopic).toHaveBeenCalledWith('Successful question')
    })
  })

  it('keeps a failed conversation save visible and retryable', async () => {
    const user = userEvent.setup()
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true
    state.persistTemporaryTopic.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined)
    const { rerender } = render(<HomeWindow draggable={false} />)

    await user.type(screen.getByTestId('quick-input'), 'Important question')
    await user.keyboard('{Enter}')
    state.streamStatus = 'streaming'
    rerender(<HomeWindow draggable={false} />)
    state.streamStatus = 'done'
    rerender(<HomeWindow draggable={false} />)

    expect(await screen.findByText('quickAssistant.errors.save_conversation_failed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'common.retry' }))

    await waitFor(() => {
      expect(screen.queryByText('quickAssistant.errors.save_conversation_failed')).not.toBeInTheDocument()
    })
    expect(state.persistTemporaryTopic).toHaveBeenCalledTimes(2)
  })

  it('prevents retrying a conversation save while a response is streaming', async () => {
    const user = userEvent.setup()
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true
    state.persistTemporaryTopic.mockRejectedValueOnce(new Error('disk full'))
    const { rerender } = render(<HomeWindow draggable={false} />)

    await user.type(screen.getByTestId('quick-input'), 'Important question')
    await user.keyboard('{Enter}')
    state.streamStatus = 'streaming'
    rerender(<HomeWindow draggable={false} />)
    state.streamStatus = 'done'
    rerender(<HomeWindow draggable={false} />)

    const retry = await screen.findByRole('button', { name: 'common.retry' })

    await user.type(screen.getByTestId('quick-input'), 'Retry question')
    await user.keyboard('{Enter}')
    expect(retry).toBeDisabled()

    state.streamStatus = 'streaming'
    rerender(<HomeWindow draggable={false} />)

    expect(retry).toBeDisabled()
    await user.click(retry)
    expect(state.persistTemporaryTopic).toHaveBeenCalledTimes(1)
  })

  it('selects the first assistant before allowing a first-run Saved send', () => {
    state.saveConversations = true
    state.quickAssistantId = ''

    render(<HomeWindow draggable={false} />)

    expect(state.setQuickAssistantId).toHaveBeenCalledWith('assistant-1')
    expect(screen.getByTestId('quick-input')).toHaveAttribute('placeholder', 'Ask Assistant')
    fireEvent.change(screen.getByTestId('quick-input'), { target: { value: 'Saved question' } })
    fireEvent.keyDown(screen.getByTestId('quick-input'), { code: 'Enter', key: 'Enter' })
    expect(state.sendMessage).toHaveBeenCalledWith({ text: 'Saved question' }, { body: {} })
  })

  it('falls back to Temporary model mode when Saved has no assistant', () => {
    state.saveConversations = true
    state.quickAssistantId = ''
    state.assistants = []
    const { rerender } = render(<HomeWindow draggable={false} />)

    expect(state.setSaveConversations).toHaveBeenCalledWith(false)
    expect(screen.queryByTestId('quick-input')).not.toBeInTheDocument()

    state.saveConversations = false
    rerender(<HomeWindow draggable={false} />)
    expect(screen.getByTestId('quick-input')).toHaveAttribute('placeholder', 'Ask Claude Sonnet')
  })

  it('navigates saved assistant history and opens the exact topic in the main app', async () => {
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true
    state.historyTopics = [{ id: 'saved-topic', name: 'Saved topic' }]

    render(<HomeWindow />)
    fireEvent.keyDown(window, { code: 'BracketLeft', metaKey: true })

    expect(await screen.findByText('Saved topic')).toBeInTheDocument()
    fireEvent.keyDown(window, { code: 'KeyJ', metaKey: true })

    expect(state.ipcRequest).toHaveBeenCalledWith('navigation.focus_or_open_conversation', {
      target: { conversationType: 'assistant', conversationId: 'saved-topic' },
      title: 'Saved topic'
    })
  })

  it('does not expose conversation navigation in Temporary mode', () => {
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = false
    state.historyTopics = [{ id: 'saved-topic', name: 'Saved topic' }]

    render(<HomeWindow draggable={false} />)
    fireEvent.keyDown(window, { code: 'BracketLeft', metaKey: true })

    expect(screen.queryByRole('button', { name: 'quickAssistant.history.older' })).not.toBeInTheDocument()
    expect(screen.queryByText('Saved topic')).not.toBeInTheDocument()
  })

  it('does not register history shortcuts in the settings preview', () => {
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true
    state.historyTopics = [{ id: 'saved-topic', name: 'Saved topic' }]

    render(<HomeWindow draggable={false} />)
    fireEvent.keyDown(window, { code: 'BracketLeft', metaKey: true })

    expect(screen.queryByText('Saved topic')).not.toBeInTheDocument()
  })

  it('reconciles each optimistic user id with its authoritative reserved id', () => {
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true

    render(<HomeWindow />)
    state.messages = [{ id: 'optimistic-first', role: 'user', parts: [{ type: 'text', text: 'same' }] }]
    state.dispatchListener?.({
      ok: true,
      topicId: 'temp-topic',
      ack: {
        mode: 'started',
        reservedMessages: [
          { id: 'authoritative-first', role: 'user', parts: [{ type: 'text', text: 'same' }] } as CherryUIMessage
        ]
      }
    })
    state.messages = [
      ...state.messages,
      { id: 'optimistic-second', role: 'user', parts: [{ type: 'text', text: 'same' }] } as CherryUIMessage
    ]
    state.dispatchListener?.({
      ok: true,
      topicId: 'temp-topic',
      ack: {
        mode: 'started',
        reservedMessages: [
          { id: 'authoritative-second', role: 'user', parts: [{ type: 'text', text: 'same' }] } as CherryUIMessage
        ]
      }
    })

    expect(state.messages.map((message) => message.id)).toEqual(['authoritative-first', 'authoritative-second'])
  })

  it('resets a selected saved topic when Saved mode is turned off', async () => {
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true
    state.historyTopics = [{ id: 'saved-topic', name: 'Saved topic' }]
    const { rerender } = render(<HomeWindow />)
    fireEvent.keyDown(window, { code: 'BracketLeft', metaKey: true })
    expect(screen.getByText('Saved topic')).toBeInTheDocument()

    state.saveConversations = false
    rerender(<HomeWindow />)

    await waitFor(() => expect(state.resetTemporaryTopic).toHaveBeenCalledOnce())
    expect(screen.queryByText('Saved topic')).not.toBeInTheDocument()
  })

  it('blocks history navigation while the current scratch save has failed', async () => {
    const user = userEvent.setup()
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true
    state.historyTopics = [{ id: 'saved-topic', name: 'Saved topic' }]
    state.persistTemporaryTopic.mockRejectedValueOnce(new Error('disk full'))
    const { rerender } = render(<HomeWindow />)

    await user.type(screen.getByTestId('quick-input'), 'Important question')
    await user.keyboard('{Enter}')
    state.streamStatus = 'done'
    rerender(<HomeWindow />)
    await screen.findByText('quickAssistant.errors.save_conversation_failed')
    fireEvent.keyDown(window, { code: 'BracketLeft', metaKey: true })

    expect(screen.queryByText('Saved topic')).not.toBeInTheDocument()
  })

  it('clears a failed-save retry without discarding the conversation when switching to Temporary', async () => {
    const user = userEvent.setup()
    state.quickAssistantId = 'assistant-1'
    state.saveConversations = true
    state.persistTemporaryTopic.mockRejectedValueOnce(new Error('disk full'))
    const { rerender } = render(<HomeWindow />)

    await user.type(screen.getByTestId('quick-input'), 'Keep this conversation')
    await user.keyboard('{Enter}')
    state.streamStatus = 'done'
    rerender(<HomeWindow />)
    await screen.findByText('quickAssistant.errors.save_conversation_failed')

    state.saveConversations = false
    rerender(<HomeWindow />)

    await waitFor(() => {
      expect(screen.queryByText('quickAssistant.errors.save_conversation_failed')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('chat-window')).toBeInTheDocument()
    expect(state.resetTemporaryTopic).not.toHaveBeenCalled()
    expect(state.persistTemporaryTopic).toHaveBeenCalledTimes(1)
  })
})
