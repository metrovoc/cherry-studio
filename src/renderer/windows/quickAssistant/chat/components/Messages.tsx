import { Loader2 } from 'lucide-react'
import { type FC, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Scrollbar } from '@cherrystudio/ui'
import { useMessageListRenderConfig } from '@renderer/components/chat/messages/hooks/useMessageListRenderConfig'
import { useMessagePlatformActions } from '@renderer/components/chat/messages/hooks/useMessagePlatformActions'
import { ScrollOwnershipProvider } from '@renderer/components/chat/messages/list/ScrollOwnershipContext'
import { MessageContentProvider } from '@renderer/components/chat/messages/MessageContentProvider'
import type { MessageListItem } from '@renderer/components/chat/messages/types'
import type { Assistant } from '@renderer/types/assistant'
import type { CherryMessagePart } from '@shared/data/types/message'

import { useMessageViewport } from '../hooks/useMessageViewport'
import MessageItem from './Message'

interface Props {
  assistant: Assistant | null
  route: string
  isOutputted: boolean
  messages: MessageListItem[]
  partsByMessageId: Record<string, CherryMessagePart[]>
}

const Messages: FC<Props> = ({ assistant, route, isOutputted, messages, partsByMessageId }) => {
  const { t } = useTranslation()
  const { renderConfig } = useMessageListRenderConfig()
  const platformActions = useMessagePlatformActions()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const viewport = useMessageViewport({
    scrollerRef,
    contentRef,
    conversationKey: `${assistant?.id ?? 'runtime-default'}:${messages[0]?.id ?? ''}`
  })

  return (
    <MessageContentProvider
      messages={messages}
      partsByMessageId={partsByMessageId}
      renderConfig={renderConfig}
      actions={platformActions}>
      <Scrollbar
        id="messages"
        ref={scrollerRef}
        tabIndex={0}
        role="region"
        aria-label={t('globalSearch.groups.message')}
        className="min-h-0 w-full flex-1 overflow-x-hidden bg-transparent!">
        <ScrollOwnershipProvider scrollContainerRef={scrollerRef} {...viewport}>
          <div ref={contentRef} className="flex w-full flex-col items-center pb-5">
            {messages.map((message, index) => (
              <MessageItem
                key={message.id}
                message={message}
                index={messages.length - index - 1}
                total={messages.length}
                route={route}
              />
            ))}
            {!isOutputted && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </div>
        </ScrollOwnershipProvider>
      </Scrollbar>
    </MessageContentProvider>
  )
}

export default Messages
