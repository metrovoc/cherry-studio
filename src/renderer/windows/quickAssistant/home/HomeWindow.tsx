import { useChat } from '@ai-sdk/react'
import { Button, Separator } from '@cherrystudio/ui'
import { usePreference } from '@data/hooks/usePreference'
import { loggerService } from '@logger'
import { toMessageListItem } from '@renderer/components/chat/messages/utils/messageListItem'
import { useAssistant, useAssistants } from '@renderer/hooks/useAssistant'
import { useExecutionOverlay } from '@renderer/hooks/useExecutionOverlay'
import { useDefaultModel } from '@renderer/hooks/useModel'
import { useTemporaryTopic } from '@renderer/hooks/useTemporaryTopic'
import { useTheme } from '@renderer/hooks/useTheme'
import { useTopicMessages } from '@renderer/hooks/useTopicMessages'
import { useTopicStreamStatus } from '@renderer/hooks/useTopicStreamStatus'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import { ipcChatTransport, streamDispatchService } from '@renderer/services/aiTransport'
import { toast } from '@renderer/services/toast'
import { mergeMessagesById } from '@renderer/utils/message/mergeMessagesById'
import { getTextFromParts } from '@renderer/utils/message/partsHelpers'
import { isMac } from '@renderer/utils/platform'
import { cn } from '@renderer/utils/style'
import { ThemeMode } from '@shared/data/preference/preferenceTypes'
import type { CherryMessagePart, CherryUIMessage } from '@shared/data/types/message'
import { type CherryReasoningMeta, readCherryMeta, withCherryMeta } from '@shared/data/types/uiParts'
import { isEmpty } from 'es-toolkit/compat'
import type { FC } from 'react'
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import ClipboardPreview from './components/ClipboardPreview'
import ConversationNavigationBar from './components/ConversationNavigationBar'
import Footer from './components/Footer'
import InputBar from './components/InputBar'
import { useQuickAssistantHistory } from './hooks/useQuickAssistantHistory'

// The chat branch carries the heavy message rendering chain (ChatMarkdown,
// CodeMirror, katex, mermaid), so keep it out of the initial home render.
const ChatWindow = React.lazy(() => import('../chat/ChatWindow'))

// Size-stable fallback: the shell (input bar / footer) renders synchronously
// around it, so the brief local-chunk load must not collapse the layout.
const LazyBranchFallback = () => <div className="flex-1" />

const logger = loggerService.withContext('HomeWindow')

type MiniRoute = 'home' | 'chat'

/**
 * Finalize a list of live assistant messages: turn any still-streaming text
 * or reasoning part into `state: 'done'`, deriving `thinkingMs` for reasoning
 * from `startedAt` if the upstream hasn't set it yet. Called when the
 * execution transitions from active to inactive.
 */
export const finalizeLiveMessages = (messages: CherryUIMessage[]): CherryUIMessage[] => {
  return messages.map((msg) => {
    if (!msg.parts) return msg
    let changed = false
    const newParts = msg.parts.map((part) => {
      if ((part.type !== 'text' && part.type !== 'reasoning') || part.state !== 'streaming') return part

      changed = true
      if (part.type === 'text') return { ...part, state: 'done' as const }

      const cherry = readCherryMeta(part)
      const startedAt = cherry?.startedAt
      const thinkingMs = cherry?.thinkingMs

      let patch: Partial<CherryReasoningMeta> = {}
      if (typeof startedAt === 'number' && Number.isFinite(startedAt) && typeof thinkingMs !== 'number') {
        patch = { thinkingMs: Math.round(Math.max(0, Date.now() - startedAt)) }
      }

      return withCherryMeta({ ...part, state: 'done' }, patch)
    })
    return changed ? { ...msg, parts: newParts } : msg
  })
}

const HomeWindow: FC<{ draggable?: boolean }> = ({ draggable = true }) => {
  const [readClipboardAtStartup] = usePreference('feature.quick_assistant.read_clipboard_at_startup')
  const [quickAssistantId, setQuickAssistantId] = usePreference('feature.quick_assistant.assistant_id')
  const [saveConversations, setSaveConversations] = usePreference('feature.quick_assistant.save_conversations')
  const [windowStyle] = usePreference('ui.window_style')
  const { theme } = useTheme()
  const { t } = useTranslation()

  const [route, setRoute] = useState<MiniRoute>('home')
  const [isFirstMessage, setIsFirstMessage] = useState(true)
  const [userInputText, setUserInputText] = useState('')
  const [clipboardText, setClipboardText] = useState('')
  const [isPinned, setIsPinnedState] = useState(false)
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null)
  const [hasRetainedScratch, setHasRetainedScratch] = useState(true)
  const [pendingOlderTopicId, setPendingOlderTopicId] = useState<string | null>(null)

  // Wraps setState with an eager IPC call so main's pin flag is updated
  // synchronously inside the click handler — a useEffect-based sync would
  // defer IPC by at least one render, opening a race where blur fires with
  // the main flag still stale.
  const setIsPinned = useCallback((next: boolean) => {
    void ipcApi.request('quick_assistant.set_pin', { isPinned: next })
    setIsPinnedState(next)
  }, [])

  const lastClipboardTextRef = useRef<string | null>(null)
  const latestRequestTextRef = useRef('')
  const initialRequestTextRef = useRef('')
  const persistingTopicIdRef = useRef<string | null>(null)
  const persistedTopicIdRef = useRef<string | null>(null)
  const inputBarRef = useRef<HTMLDivElement>(null)
  const scratchInputRef = useRef('')
  const scratchRouteRef = useRef<MiniRoute>('home')
  const scratchIsFirstMessageRef = useRef(true)

  const { quickModel: quickApiModel } = useDefaultModel()
  const { assistants, hasLoaded: haveAssistantsLoaded } = useAssistants()
  const selectedAssistant = assistants.find((assistant) => assistant.id === quickAssistantId)
  const firstAssistantId = assistants[0]?.id
  const configuredAssistantId = !haveAssistantsLoaded || selectedAssistant ? (quickAssistantId ?? '') : ''
  const effectiveAssistantId = saveConversations
    ? haveAssistantsLoaded
      ? (selectedAssistant?.id ?? firstAssistantId ?? '')
      : configuredAssistantId
    : configuredAssistantId
  const isResolvingSavedAssistant = saveConversations && !effectiveAssistantId
  const { assistant: chosenAssistant, model: chosenApiModel } = useAssistant(effectiveAssistantId)
  const isAssistantMode = Boolean(effectiveAssistantId)
  const chosenAssistantId = chosenAssistant?.id
  const currentAssistant = chosenAssistant
  const currentModel = isResolvingSavedAssistant ? undefined : isAssistantMode ? chosenApiModel : quickApiModel

  useEffect(() => {
    if (!haveAssistantsLoaded || selectedAssistant) return
    if (saveConversations && firstAssistantId) {
      void setQuickAssistantId(firstAssistantId)
    } else if (saveConversations) {
      void setSaveConversations(false)
    } else if (quickAssistantId) {
      void setQuickAssistantId('')
    }
  }, [
    firstAssistantId,
    haveAssistantsLoaded,
    quickAssistantId,
    saveConversations,
    selectedAssistant,
    setQuickAssistantId,
    setSaveConversations
  ])

  // Lease a temporary topic for the quick-assistant conversation.
  // Lifecycle is tied to this component; resetting the conversation drops and leases a new one.
  const {
    topicId: temporaryTopicId,
    ready: isTopicReady,
    reset: resetTemporaryTopic,
    persist: persistTemporaryTopic
  } = useTemporaryTopic({ enabled: !isAssistantMode || !!chosenAssistantId, assistantId: chosenAssistantId })

  const historyEnabled = saveConversations && isAssistantMode && Boolean(chosenAssistantId)
  const history = useQuickAssistantHistory(chosenAssistantId, historyEnabled)
  const activeTopicId = selectedTopicId ?? temporaryTopicId
  const selectedTopic = history.topics.find((topic) => topic.id === selectedTopicId)
  const {
    uiMessages: persistedMessages,
    activeNodeId,
    isLoading: isLoadingPersistedMessages
  } = useTopicMessages(selectedTopicId ?? '', { enabled: Boolean(selectedTopicId) })

  const requestText = useMemo(() => {
    const trimmedUserInput = userInputText.trim()
    if (!isFirstMessage || !clipboardText) return trimmedUserInput
    if (!trimmedUserInput || clipboardText === trimmedUserInput) return clipboardText
    return `${clipboardText}\n\n${trimmedUserInput}`
  }, [clipboardText, isFirstMessage, userInputText])

  const [isPreparing, setIsPreparing] = useState(false)
  const [isPersisting, setIsPersisting] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [failedPersistenceTopicId, setFailedPersistenceTopicId] = useState<string | null>(null)

  const {
    messages: chatMessages,
    sendMessage,
    stop: stopChat,
    setMessages
  } = useChat<CherryUIMessage>({
    id: activeTopicId ?? 'pending-topic',
    transport: ipcChatTransport,
    experimental_throttle: 50,
    onError: (err) => {
      setIsPreparing(false)
      setFlowError(err.message)
    }
  })

  useEffect(
    () =>
      streamDispatchService.subscribe(activeTopicId ?? 'pending-topic', (result) => {
        if (!result.ok || result.ack.mode === 'blocked') return
        const acknowledgedUser = result.ack.reservedMessages?.find((message) => message.role === 'user')
        if (!acknowledgedUser) return

        setMessages((current) => {
          const optimisticIndex = current.findLastIndex((message) => message.role === 'user')
          if (optimisticIndex < 0 || current[optimisticIndex].id === acknowledgedUser.id) return current
          const next = [...current]
          next[optimisticIndex] = acknowledgedUser
          return next
        })
      }),
    [activeTopicId, setMessages]
  )

  // Chunks are routed to the per-execution collector (Main tags every
  // chunk with its modelId). Primary `useChat.state.messages`
  // (chatMessages) only receives user messages pushed by `sendMessage` —
  // no assistant content. We accumulate assistant turns across completed
  // streams in `completedAssistants` so the multi-turn conversation
  // renders properly. Cleared on `clear()` together with `setMessages([])`.
  const { status: streamStatus, activeExecutions, isPending } = useTopicStreamStatus(activeTopicId ?? 'pending-topic')
  const {
    liveAssistants,
    reset: resetExecutionMessages,
    clear: clearExecutionMessages
  } = useExecutionOverlay(activeTopicId ?? 'pending-topic', activeExecutions, persistedMessages)
  const [completedAssistants, setCompletedAssistants] = useState<CherryUIMessage[]>([])

  const prevActiveCountRef = useRef(activeExecutions.length)
  useEffect(() => {
    const wasActive = prevActiveCountRef.current > 0
    prevActiveCountRef.current = activeExecutions.length
    if (activeExecutions.length === 0 && wasActive) {
      // Snapshots are retained after a reader tears down, so the final
      // frames are still in `liveAssistants` at this →0 transition.
      if (liveAssistants.length) {
        setCompletedAssistants((done) => [...done, ...finalizeLiveMessages(liveAssistants)])
        resetExecutionMessages()
      }
    }
  }, [activeExecutions, liveAssistants, resetExecutionMessages])

  const persistConversation = useCallback(async () => {
    const topicId = temporaryTopicId
    if (
      !historyEnabled ||
      !topicId ||
      persistingTopicIdRef.current === topicId ||
      persistedTopicIdRef.current === topicId
    ) {
      return
    }

    persistingTopicIdRef.current = topicId
    setIsPersisting(true)
    try {
      await persistTemporaryTopic(initialRequestTextRef.current)
      persistedTopicIdRef.current = topicId
      setSelectedTopicId(topicId)
      setHasRetainedScratch(false)
      setFailedPersistenceTopicId((failedId) => (failedId === topicId ? null : failedId))
    } catch (persistError) {
      setFailedPersistenceTopicId(topicId)
      logger.error('Failed to save quick assistant conversation', persistError as Error)
    } finally {
      if (persistingTopicIdRef.current === topicId) {
        persistingTopicIdRef.current = null
        setIsPersisting(false)
      }
    }
  }, [historyEnabled, persistTemporaryTopic, temporaryTopicId])

  useEffect(() => {
    if (!historyEnabled) setFailedPersistenceTopicId(null)
  }, [historyEnabled])

  useEffect(() => {
    if (!historyEnabled || selectedTopicId || streamStatus !== 'done') return
    if (!initialRequestTextRef.current) initialRequestTextRef.current = latestRequestTextRef.current
    void persistConversation()
  }, [historyEnabled, persistConversation, selectedTopicId, streamStatus])

  useEffect(() => {
    if (isPending) setIsPreparing(false)
  }, [isPending])

  const allAssistants = useMemo<CherryUIMessage[]>(
    () => [...completedAssistants, ...liveAssistants],
    [completedAssistants, liveAssistants]
  )

  // Interleave user messages (from state.messages) with assistant turns
  // (accumulated completed + live). The assumption: users and assistants
  // alternate strictly — user[i] precedes assistant[i]. Temporary topics
  // are always a clean linear chat, no branches.
  const temporaryDisplayMessages = useMemo<CherryUIMessage[]>(() => {
    const users = chatMessages.filter((m) => m.role === 'user')
    const latestAssistantId = liveAssistants[liveAssistants.length - 1]?.id
    const out: CherryUIMessage[] = []
    const turns = Math.max(users.length, allAssistants.length)
    for (let i = 0; i < turns; i++) {
      const u = users[i]
      if (u) {
        out.push(u)
      }
      const a = allAssistants[i]
      if (a) {
        out.push({
          ...a,
          metadata: {
            ...a.metadata,
            status: a.id === latestAssistantId && isPending ? 'pending' : 'success'
          }
        })
      }
    }
    return out
  }, [chatMessages, allAssistants, liveAssistants, isPending])

  const displayMessages = useMemo(
    () =>
      selectedTopicId
        ? mergeMessagesById(persistedMessages, temporaryDisplayMessages, liveAssistants)
        : temporaryDisplayMessages,
    [liveAssistants, persistedMessages, selectedTopicId, temporaryDisplayMessages]
  )

  const partsByMessageId = useMemo<Record<string, CherryMessagePart[]>>(() => {
    const next: Record<string, CherryMessagePart[]> = {}
    for (const message of displayMessages) {
      next[message.id] = (message.parts ?? []) as CherryMessagePart[]
    }
    return next
  }, [displayMessages])

  const messageItems = useMemo(
    () =>
      displayMessages.map((message) =>
        toMessageListItem(message, {
          assistantId: currentAssistant?.id,
          topicId: activeTopicId ?? ''
        })
      ),
    [activeTopicId, currentAssistant?.id, displayMessages]
  )

  const latestAssistantUIMsg = useMemo(
    () => displayMessages.findLast((message) => message.role === 'assistant'),
    [displayMessages]
  )

  const content = useMemo(
    () => (latestAssistantUIMsg ? getTextFromParts(latestAssistantUIMsg.parts as CherryMessagePart[]) : ''),
    [latestAssistantUIMsg]
  )

  const isStreaming = isPending

  const clear = useCallback(() => {
    void stopChat()
    setMessages([])
    setCompletedAssistants([])
    clearExecutionMessages()
    setFlowError(null)
    setFailedPersistenceTopicId(null)
    setIsPreparing(false)
  }, [stopChat, setMessages, clearExecutionMessages])

  const isLoading = isPreparing || isStreaming || isPersisting || isLoadingPersistedMessages
  const isOutputted = messageItems.some((message) => message.role === 'assistant')

  useEffect(() => {
    if (route === 'home') {
      setIsFirstMessage(true)
      setFlowError(null)
      clear()
    }
  }, [route, clear])

  const focusInput = useCallback(() => {
    if (!inputBarRef.current) return
    const input = inputBarRef.current.querySelector('input')
    input?.focus()
  }, [])

  const readClipboard = useCallback(async () => {
    if (!readClipboardAtStartup || !document.hasFocus()) return

    try {
      const text = await navigator.clipboard.readText()
      if (text && text !== lastClipboardTextRef.current) {
        lastClipboardTextRef.current = text
        setClipboardText(text.trim())
      }
    } catch (clipboardError) {
      logger.warn('Failed to read clipboard:', clipboardError as Error)
    }
  }, [readClipboardAtStartup])

  const clearClipboard = useCallback(async () => {
    setClipboardText('')
    lastClipboardTextRef.current = null
    focusInput()
  }, [focusInput])

  const onWindowShow = useCallback(async () => {
    await readClipboard()
    focusInput()
  }, [readClipboard, focusInput])

  useIpcOn('quick_assistant.shown', onWindowShow)

  useEffect(() => {
    void readClipboard()
  }, [readClipboard])

  const handleCloseWindow = useCallback(() => ipcApi.request('quick_assistant.hide'), [])

  const handleSendMessage = useCallback(
    async (prompt?: string) => {
      if (isEmpty(requestText)) return
      if (!activeTopicId || (!selectedTopicId && !isTopicReady)) return

      try {
        setFlowError(null)
        latestRequestTextRef.current = requestText
        setIsFirstMessage(false)
        setUserInputText('')
        setIsPreparing(true)
        const parentAnchorId = selectedTopicId ? (activeNodeId ?? latestAssistantUIMsg?.id) : latestAssistantUIMsg?.id
        // Temporary topics are linear, while persisted topics need the current branch tip.
        // Main ignores the anchor until this topic is promoted to persistent history.
        void sendMessage(
          { text: [prompt, requestText].filter(Boolean).join('\n\n') },
          {
            body: {
              ...(parentAnchorId && { parentAnchorId }),
              ...(!isAssistantMode && currentModel && { mentionedModels: [currentModel.id] })
            }
          }
        )
      } catch (streamError) {
        const resolvedError = streamError instanceof Error ? streamError : new Error('An error occurred')
        setFlowError(resolvedError.message)
        logger.error('Error fetching result:', resolvedError)
      }
    },
    [
      activeNodeId,
      activeTopicId,
      currentModel,
      isAssistantMode,
      isTopicReady,
      latestAssistantUIMsg,
      requestText,
      selectedTopicId,
      sendMessage
    ]
  )

  const handlePause = useCallback(() => {
    void stopChat()
  }, [stopChat])

  const resetConversation = useCallback(() => {
    // Drop the current temporary topic and let useTemporaryTopic lease a fresh one.
    latestRequestTextRef.current = ''
    initialRequestTextRef.current = ''
    resetTemporaryTopic()
    clear()
    setSelectedTopicId(null)
    setHasRetainedScratch(true)
    setPendingOlderTopicId(null)
  }, [clear, resetTemporaryTopic])

  useEffect(() => {
    if (!saveConversations && selectedTopicId) {
      resetConversation()
      setRoute('home')
      setUserInputText('')
    }
  }, [resetConversation, saveConversations, selectedTopicId])

  const selectHistoryTopic = useCallback(
    (topicId: string | null) => {
      void stopChat()
      setMessages([])
      setCompletedAssistants([])
      clearExecutionMessages()
      setFlowError(null)
      setFailedPersistenceTopicId(null)
      setIsPreparing(false)

      if (selectedTopicId === null && topicId) {
        scratchInputRef.current = userInputText
        scratchRouteRef.current = route
        scratchIsFirstMessageRef.current = isFirstMessage
      }
      setSelectedTopicId(topicId)
      if (topicId) {
        setUserInputText('')
        setIsFirstMessage(false)
        setRoute('chat')
      } else {
        setUserInputText(scratchInputRef.current)
        setIsFirstMessage(scratchIsFirstMessageRef.current)
        setRoute(scratchRouteRef.current)
      }
      requestAnimationFrame(focusInput)
    },
    [clearExecutionMessages, focusInput, isFirstMessage, route, selectedTopicId, setMessages, stopChat, userInputText]
  )

  const goToOlderConversation = useCallback(() => {
    if (!historyEnabled || isLoading || failedPersistenceTopicId === temporaryTopicId) return
    if (!selectedTopicId) {
      const latest = history.topics[0]
      if (latest) selectHistoryTopic(latest.id)
      return
    }

    const index = history.topics.findIndex((topic) => topic.id === selectedTopicId)
    const older = history.topics[index + 1]
    if (older) {
      selectHistoryTopic(older.id)
    } else if (index >= 0 && history.hasNext) {
      setPendingOlderTopicId(selectedTopicId)
      history.loadNext()
    }
  }, [
    failedPersistenceTopicId,
    history,
    historyEnabled,
    isLoading,
    selectHistoryTopic,
    selectedTopicId,
    temporaryTopicId
  ])

  useEffect(() => {
    if (!pendingOlderTopicId) return
    const index = history.topics.findIndex((topic) => topic.id === pendingOlderTopicId)
    const older = history.topics[index + 1]
    if (older) {
      setPendingOlderTopicId(null)
      selectHistoryTopic(older.id)
    } else if (!history.hasNext && !history.isRefreshing) {
      setPendingOlderTopicId(null)
    }
  }, [history.hasNext, history.isRefreshing, history.topics, pendingOlderTopicId, selectHistoryTopic])

  const goToNewerConversation = useCallback(() => {
    if (!historyEnabled || isLoading || !selectedTopicId || failedPersistenceTopicId === temporaryTopicId) return
    const index = history.topics.findIndex((topic) => topic.id === selectedTopicId)
    if (index > 0) {
      selectHistoryTopic(history.topics[index - 1].id)
    } else if (index === 0 && hasRetainedScratch) {
      selectHistoryTopic(null)
    }
  }, [
    failedPersistenceTopicId,
    hasRetainedScratch,
    history.topics,
    historyEnabled,
    isLoading,
    selectHistoryTopic,
    selectedTopicId,
    temporaryTopicId
  ])

  const openCurrentConversation = useCallback(() => {
    if (!selectedTopicId || isLoading) return
    void ipcApi.request('navigation.focus_or_open_conversation', {
      target: { conversationType: 'assistant', conversationId: selectedTopicId },
      title: selectedTopic?.name ?? initialRequestTextRef.current
    })
  }, [isLoading, selectedTopic?.name, selectedTopicId])

  useEffect(() => {
    if (!draggable || !historyEnabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return
      if (event.code === 'BracketLeft') {
        event.preventDefault()
        goToOlderConversation()
      } else if (event.code === 'BracketRight') {
        event.preventDefault()
        goToNewerConversation()
      } else if (event.code === 'KeyJ') {
        event.preventDefault()
        openCurrentConversation()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draggable, goToNewerConversation, goToOlderConversation, historyEnabled, openCurrentConversation])

  const handleEsc = useCallback(() => {
    if (isLoading) {
      handlePause()
      return
    }

    if (route === 'home') {
      void handleCloseWindow()
      return
    }

    resetConversation()
    setFlowError(null)
    setRoute('home')
    setUserInputText('')
  }, [handleCloseWindow, handlePause, isLoading, resetConversation, route])

  useEffect(() => {
    if (!draggable || !isMac) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        event.repeat ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return

      event.preventDefault()
      event.stopImmediatePropagation()
      void stopChat().then(() => {
        resetConversation()
        setFlowError(null)
        setRoute('home')
        setUserInputText('')
      })
      void handleCloseWindow()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [draggable, handleCloseWindow, resetConversation, stopChat])

  const handleCopy = useCallback(() => {
    if (!content) return
    void navigator.clipboard.writeText(content)
    toast.success(t('message.copy.success'))
  }, [content, t])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.key === 'Process') {
      return
    }

    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
        if (isLoading || isResolvingSavedAssistant) return
        e.preventDefault()
        if (requestText) {
          setRoute('chat')
          void handleSendMessage()
          focusInput()
        }
        break
      case 'Backspace':
        if (userInputText.length === 0) {
          void clearClipboard()
        }
        break
      case 'Escape':
        if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) handleEsc()
        break
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUserInputText(e.target.value)
  }

  const handleAssistantChange = useCallback(
    (assistantId: string) => {
      if (assistantId === quickAssistantId) return
      if (route !== 'home') {
        resetConversation()
        setRoute('home')
        setUserInputText('')
      }
      void setQuickAssistantId(assistantId)
      requestAnimationFrame(focusInput)
    },
    [focusInput, quickAssistantId, resetConversation, route, setQuickAssistantId]
  )

  const backgroundColor = useMemo(() => {
    if (isMac && windowStyle === 'transparent' && theme === ThemeMode.light) {
      return 'transparent'
    }
    return 'var(--background)'
  }, [windowStyle, theme])

  const inputPlaceholder = useMemo(() => {
    if (clipboardText && route === 'home') {
      return t('quickAssistant.input.placeholder.title')
    }
    return t('quickAssistant.input.placeholder.empty', {
      model: isAssistantMode ? (currentAssistant?.name ?? '') : (currentModel?.name ?? '')
    })
  }, [clipboardText, route, t, isAssistantMode, currentAssistant, currentModel])

  const handleSwitchAssistant = useCallback(() => {
    inputBarRef.current?.querySelector<HTMLButtonElement>('[data-assistant-switcher-trigger]')?.click()
  }, [])

  const baseFooterProps = useMemo(
    () => ({
      route,
      loading: isLoading,
      onEsc: handleEsc,
      canSwitchAssistant: Boolean(currentAssistant) && !isLoading,
      onSwitchAssistant: handleSwitchAssistant,
      setIsPinned,
      isPinned
    }),
    [route, isLoading, handleEsc, currentAssistant, handleSwitchAssistant, setIsPinned, isPinned]
  )

  const currentHistoryIndex = selectedTopicId ? history.topics.findIndex((topic) => topic.id === selectedTopicId) : -1
  const hasFailedScratchSave = failedPersistenceTopicId === temporaryTopicId
  const conversationNavigation = historyEnabled ? (
    <ConversationNavigationBar
      title={selectedTopic?.name ?? t('quickAssistant.history.new_conversation')}
      disabled={
        isLoading || history.isLoading || history.isRefreshing || Boolean(pendingOlderTopicId) || hasFailedScratchSave
      }
      canGoOlder={
        selectedTopicId
          ? currentHistoryIndex >= 0 && (currentHistoryIndex < history.topics.length - 1 || history.hasNext)
          : history.topics.length > 0
      }
      canGoNewer={Boolean(
        selectedTopicId && (currentHistoryIndex > 0 || (currentHistoryIndex === 0 && hasRetainedScratch))
      )}
      canOpen={Boolean(selectedTopicId)}
      onGoOlder={goToOlderConversation}
      onGoNewer={goToNewerConversation}
      onOpen={openCurrentConversation}
    />
  ) : null

  switch (route) {
    case 'chat':
      return (
        <div data-ui="quick-assistant.view" className={containerClassName(draggable)} style={{ backgroundColor }}>
          {(currentAssistant || currentModel) && (
            <>
              <InputBar
                text={userInputText}
                model={currentModel}
                assistant={currentAssistant}
                placeholder={inputPlaceholder}
                onAssistantChange={handleAssistantChange}
                assistantSelectionDisabled={isLoading}
                actions={conversationNavigation}
                handleKeyDown={handleKeyDown}
                handleChange={handleChange}
                ref={inputBarRef}
              />
              <Separator className="my-2.5" />
            </>
          )}
          <Suspense fallback={<LazyBranchFallback />}>
            <ChatWindow
              route={route}
              assistant={currentAssistant ?? null}
              isOutputted={isOutputted}
              messages={messageItems}
              partsByMessageId={partsByMessageId}
            />
          </Suspense>
          {flowError && (
            <div className="mb-3 break-all rounded border border-error-border bg-error-subtle px-3 py-2 text-[13px] text-error-subtle-foreground">
              {flowError}
            </div>
          )}
          {historyEnabled && failedPersistenceTopicId === temporaryTopicId && (
            <div className="mb-3 flex items-center gap-2 rounded border border-error-border bg-error-subtle px-3 py-2 text-[13px] text-error-subtle-foreground">
              <span className="min-w-0 flex-1">{t('quickAssistant.errors.save_conversation_failed')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0"
                loading={isPersisting}
                disabled={isPreparing || isStreaming}
                onClick={() => void persistConversation()}>
                {t('common.retry')}
              </Button>
            </div>
          )}

          <Separator className="my-2.5" />
          <Footer key="footer" {...baseFooterProps} onCopy={handleCopy} />
        </div>
      )

    default:
      return (
        <div data-ui="quick-assistant.view" className={containerClassName(draggable)} style={{ backgroundColor }}>
          {(currentAssistant || currentModel) && (
            <InputBar
              text={userInputText}
              model={currentModel}
              assistant={currentAssistant}
              placeholder={inputPlaceholder}
              onAssistantChange={handleAssistantChange}
              assistantSelectionDisabled={isLoading}
              actions={conversationNavigation}
              handleKeyDown={handleKeyDown}
              handleChange={handleChange}
              ref={inputBarRef}
            />
          )}
          <Separator className="my-2.5" />
          <ClipboardPreview clipboardText={clipboardText} clearClipboard={clearClipboard} t={t} />
          <main className="flex-1" />
          <Separator className="my-2.5" />
          <Footer
            key="footer"
            {...baseFooterProps}
            canUseBackspace={userInputText.length > 0 || clipboardText.length === 0}
            clearClipboard={clearClipboard}
          />
        </div>
      )
  }
}

const containerClassName = (draggable: boolean) =>
  cn(
    'flex h-full w-full flex-1 flex-col px-2.5 py-2',
    draggable ? '[-webkit-app-region:drag]' : '[-webkit-app-region:no-drag]'
  )

export default HomeWindow
