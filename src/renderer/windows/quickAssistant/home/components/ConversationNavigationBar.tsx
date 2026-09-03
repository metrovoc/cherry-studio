import { Button, Tooltip } from '@cherrystudio/ui'
import { isMac } from '@renderer/utils/platform'
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  title: string
  disabled: boolean
  canGoOlder: boolean
  canGoNewer: boolean
  canOpen: boolean
  onGoOlder: () => void
  onGoNewer: () => void
  onOpen: () => void
}

const ConversationNavigationBar: FC<Props> = ({
  title,
  disabled,
  canGoOlder,
  canGoNewer,
  canOpen,
  onGoOlder,
  onGoNewer,
  onOpen
}) => {
  const { t } = useTranslation()
  const mod = isMac ? '⌘' : 'Ctrl+'

  return (
    <div className="flex h-7 items-center gap-1 [-webkit-app-region:no-drag]">
      <span className="min-w-0 flex-1 truncate px-1 text-foreground-secondary text-xs">{title}</span>
      <Tooltip content={`${t('quickAssistant.history.older')} (${mod}[)`} delay={500}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t('quickAssistant.history.older')}
          disabled={disabled || !canGoOlder}
          onClick={onGoOlder}>
          <ChevronLeft size={14} />
        </Button>
      </Tooltip>
      <Tooltip content={`${t('quickAssistant.history.newer')} (${mod}])`} delay={500}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t('quickAssistant.history.newer')}
          disabled={disabled || !canGoNewer}
          onClick={onGoNewer}>
          <ChevronRight size={14} />
        </Button>
      </Tooltip>
      <Tooltip content={`${t('quickAssistant.history.open_in_main')} (${mod}J)`} delay={500}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t('quickAssistant.history.open_in_main')}
          disabled={disabled || !canOpen}
          onClick={onOpen}>
          <ExternalLink size={14} />
        </Button>
      </Tooltip>
    </div>
  )
}

export default ConversationNavigationBar
