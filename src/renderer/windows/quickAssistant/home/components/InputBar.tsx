import { Check, Copy, CornerDownLeft, Loader2, LoaderCircle, Mic, RotateCcw, Square, Trash2, X } from 'lucide-react'
import React, { useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@cherrystudio/ui'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { useAssistantsApi } from '@renderer/hooks/useAssistant'
import { useTimer } from '@renderer/hooks/useTimer'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { toast } from '@renderer/services/toast'
import { dictationService, voiceTargetManager } from '@renderer/services/voice'
import type { DictationErrorCategory, DictationPhase } from '@renderer/services/voice'
import type { Assistant } from '@renderer/types/assistant'
import type { Model } from '@shared/data/types/model'

const errorTranslationKeys: Partial<Record<DictationErrorCategory, string>> = {
  model_required: 'settings.voice.status.unconfigured',
  voice_unavailable: 'settings.voice.status.voice_unavailable',
  unsupported: 'settings.voice.status.unsupported',
  asset_required: 'settings.voice.status.asset_required',
  microphone_permission: 'settings.voice.microphone.denied',
  operation_failed: 'settings.voice.status.operation_failed',
  recording_failed: 'settings.voice.status.recording_failed',
  microphone_unavailable: 'settings.voice.status.microphone_unavailable',
  microphone_unreadable: 'settings.voice.status.microphone_unreadable',
  transcription_failed: 'settings.voice.status.operation_failed',
  clipboard_failed: 'settings.voice.status.operation_failed'
}

const settingsRecoveryErrors = new Set<DictationErrorCategory>([
  'model_required',
  'voice_unavailable',
  'unsupported',
  'asset_required',
  'microphone_permission',
  'microphone_unavailable',
  'microphone_unreadable'
])

const phaseTranslationKeys: Record<Exclude<DictationPhase, 'idle'>, string> = {
  starting: 'settings.voice.dictation.phase.starting',
  recording: 'settings.voice.dictation.phase.recording',
  recorded: 'settings.voice.dictation.phase.recorded',
  stopping: 'settings.voice.dictation.phase.stopping',
  transcribing: 'settings.voice.dictation.phase.transcribing',
  failed: 'settings.voice.dictation.phase.failed',
  recovery: 'settings.voice.dictation.phase.recovery'
}

interface InputBarProps {
  text: string
  model?: Model
  assistant?: Assistant
  placeholder: string
  loading: boolean
  inputRef?: React.RefObject<HTMLInputElement | null>
  dictationTargetId?: string
  onAssistantChange?: (assistantId: string) => void
  assistantSelectionDisabled?: boolean
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

const InputBar = ({
  ref,
  text,
  model,
  assistant,
  placeholder,
  loading,
  onAssistantChange,
  assistantSelectionDisabled,
  inputRef,
  dictationTargetId,
  handleKeyDown,
  handleChange
}: InputBarProps & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  const [assistantSwitcherOpen, setAssistantSwitcherOpen] = React.useState(false)
  const localInputRef = useRef<HTMLInputElement>(null)
  const resolvedInputRef = inputRef ?? localInputRef
  const { t } = useTranslation()
  const { setTimeoutTimer } = useTimer()
  const dictation = useSyncExternalStore(dictationService.subscribe, dictationService.getSnapshot)
  useEffect(() => {
    if (loading) return undefined
    return setTimeoutTimer('focus', () => resolvedInputRef.current?.focus(), 0)
  }, [loading, resolvedInputRef, setTimeoutTimer])

  const startDictation = () => {
    if (!dictationTargetId || !voiceTargetManager.markCurrent(dictationTargetId)) return
    void dictationService.startScoped().result
  }

  const markDictationTarget = () => {
    if (dictationTargetId) voiceTargetManager.markCurrent(dictationTargetId)
  }

  const insertRecovery = () => {
    if (
      !dictationTargetId ||
      !voiceTargetManager.markCurrent(dictationTargetId) ||
      dictationService.insertRecovery() === 'unavailable'
    ) {
      toast.error(t('settings.voice.status.operation_failed'))
    }
  }

  const dictationStatus =
    dictation.phase === 'recording'
      ? `${t('settings.voice.dictation.phase.recording')} ${t('settings.voice.dictation.elapsed', {
          seconds: Math.floor(dictation.elapsedMs / 1_000)
        })}`
      : dictation.phase === 'idle'
        ? undefined
        : t(phaseTranslationKeys[dictation.phase])
  const dictationError = dictation.error
    ? t(errorTranslationKeys[dictation.error] ?? 'settings.voice.status.failed')
    : ''

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab' && !event.shiftKey && assistant && onAssistantChange && !assistantSelectionDisabled) {
      event.preventDefault()
      setAssistantSwitcherOpen(true)
      return
    }
    handleKeyDown(event)
  }

  return (
    <div ref={ref} className="mt-2.5 flex items-center gap-2 [-webkit-app-region:no-drag]">
      {assistant && onAssistantChange ? (
        <AssistantSwitcher
          assistant={assistant}
          model={model}
          disabled={assistantSelectionDisabled}
          open={assistantSwitcherOpen}
          onOpenChange={setAssistantSwitcherOpen}
          onCloseAutoFocus={() => resolvedInputRef.current?.focus()}
          onAssistantChange={onAssistantChange}
        />
      ) : (
        model && <ModelAvatar model={model} size={30} />
      )}
      <Input
        ref={resolvedInputRef}
        value={text}
        placeholder={placeholder}
        autoFocus
        onFocus={markDictationTarget}
        onPointerDown={markDictationTarget}
        onKeyDown={onKeyDown}
        onChange={handleChange}
        className="h-auto rounded-none border-0 bg-transparent px-0 py-0 text-lg shadow-none [-webkit-app-region:no-drag] placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
      />
      {dictationStatus && (
        <span role="status" className="text-xs text-muted-foreground">
          {dictationStatus}
          {dictationError && `: ${dictationError}`}
        </span>
      )}
      {dictation.phase === 'idle' && dictationTargetId && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('chat.input.dictation.title')}
          disabled={loading}
          onClick={startDictation}>
          <Mic className="size-4" />
        </Button>
      )}
      {dictation.phase === 'recording' && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('settings.voice.action.stop_recording')}
            onClick={() => void dictationService.stop()}>
            <Square className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('chat.input.dictation.action.cancel')}
            onClick={() => void dictationService.cancel()}>
            <X className="size-4" />
          </Button>
        </>
      )}
      {['starting', 'stopping', 'transcribing'].includes(dictation.phase) && (
        <>
          <LoaderCircle aria-hidden className="size-4 animate-spin text-muted-foreground" />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('chat.input.dictation.action.cancel')}
            onClick={() => void dictationService.cancel()}>
            <X className="size-4" />
          </Button>
        </>
      )}
      {(dictation.phase === 'failed' || dictation.phase === 'recorded') && (
        <>
          {dictation.phase === 'recorded' && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void dictationService.transcribeRecording()}>
              {t('settings.voice.action.transcribe')}
            </Button>
          )}
          {dictation.retryAvailable && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('settings.voice.action.retry')}
              onClick={() => void dictationService.retry()}>
              <RotateCcw className="size-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('settings.voice.action.discard')}
            onClick={() => void dictationService.discard()}>
            <Trash2 className="size-4" />
          </Button>
          {dictation.error && settingsRecoveryErrors.has(dictation.error) && (
            <Button type="button" variant="ghost" size="sm" onClick={() => openSettingsTab('/settings/voice')}>
              {t('settings.voice.action.open_settings')}
            </Button>
          )}
        </>
      )}
      {dictation.phase === 'recovery' && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('settings.voice.action.insert_recovery')}
            onClick={insertRecovery}>
            <CornerDownLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('chat.input.dictation.action.copy_recovery')}
            onClick={() => void dictationService.copyRecovery()}>
            <Copy className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('settings.voice.action.discard')}
            onClick={() => void dictationService.discard()}>
            <Trash2 className="size-4" />
          </Button>
        </>
      )}
    </div>
  )
}

const AssistantSwitcher = ({
  assistant,
  model,
  disabled,
  open,
  onOpenChange,
  onCloseAutoFocus,
  onAssistantChange
}: {
  assistant: Assistant
  model?: Model
  disabled?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus: () => void
  onAssistantChange: (assistantId: string) => void
}) => {
  const { t } = useTranslation()
  const { assistants, isLoading } = useAssistantsApi({ enabled: open })

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="nodrag h-8 w-8 shrink-0 p-0"
          disabled={disabled}
          data-assistant-switcher-trigger
          aria-label={`${t('settings.models.quick_assistant_selection')}: ${assistant.name}`}>
          <ModelAvatar model={model} size={30} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-70 p-0"
        align="start"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseAutoFocus()
        }}>
        <Command>
          <CommandInput placeholder={t('selector.assistant.search_placeholder')} />
          <CommandList>
            {isLoading ? (
              <div className="flex h-20 items-center justify-center text-muted-foreground">
                <Loader2 size={16} className="animate-spin" aria-label={t('common.loading')} />
              </div>
            ) : (
              <>
                <CommandEmpty>{t('common.no_results')}</CommandEmpty>
                <CommandGroup>
                  {assistants.map((option) => (
                    <CommandItem
                      key={option.id}
                      value={`${option.name} ${option.id}`}
                      keywords={[option.name, option.id]}
                      onSelect={() => {
                        onAssistantChange(option.id)
                        onOpenChange(false)
                      }}>
                      <ModelAvatar
                        model={
                          option.modelId ? { id: option.modelId, name: option.modelName ?? option.modelId } : undefined
                        }
                        size={20}
                      />
                      <span className="min-w-0 flex-1 truncate">{option.name}</span>
                      {option.id === assistant.id && <Check size={14} className="shrink-0 text-primary" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
InputBar.displayName = 'InputBar'

export default InputBar
