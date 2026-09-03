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
import type { Assistant } from '@renderer/types/assistant'
import type { Model } from '@shared/data/types/model'
import { Check, Loader2 } from 'lucide-react'
import React, { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface InputBarProps {
  text: string
  model?: Model
  assistant?: Assistant
  placeholder: string
  onAssistantChange?: (assistantId: string) => void
  assistantSelectionDisabled?: boolean
  actions?: ReactNode
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

const InputBar = ({
  ref,
  text,
  model,
  assistant,
  placeholder,
  onAssistantChange,
  assistantSelectionDisabled,
  actions,
  handleKeyDown,
  handleChange
}: InputBarProps & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  const [assistantSwitcherOpen, setAssistantSwitcherOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab' && !event.shiftKey && assistant && onAssistantChange && !assistantSelectionDisabled) {
      event.preventDefault()
      setAssistantSwitcherOpen(true)
      return
    }
    handleKeyDown(event)
  }

  return (
    <div ref={ref} className="mt-2.5 flex items-center gap-2">
      {assistant && onAssistantChange ? (
        <AssistantSwitcher
          assistant={assistant}
          model={model}
          disabled={assistantSelectionDisabled}
          open={assistantSwitcherOpen}
          onOpenChange={setAssistantSwitcherOpen}
          onCloseAutoFocus={() => inputRef.current?.focus()}
          onAssistantChange={onAssistantChange}
        />
      ) : (
        model && <ModelAvatar model={model} size={30} />
      )}
      <Input
        ref={inputRef}
        value={text}
        placeholder={placeholder}
        autoFocus
        onKeyDown={onKeyDown}
        onChange={handleChange}
        className="h-auto rounded-none border-0 bg-transparent px-0 py-0 text-lg shadow-none [-webkit-app-region:no-drag] placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
      />
      {actions}
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
