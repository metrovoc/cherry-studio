import type { FC } from 'react'

import type { MessageListItem } from '@renderer/components/chat/messages/types'
import type { CherryMessagePart } from '@shared/data/types/message'

import Messages from './components/Messages'

interface Props {
  route: string
  conversationKey: string
  initialPosition: 'start' | 'end'
  isLoadingMessages: boolean
  isOutputted: boolean
  messages: MessageListItem[]
  partsByMessageId: Record<string, CherryMessagePart[]>
}

const ChatWindow: FC<Props> = ({
  route,
  conversationKey,
  initialPosition,
  isLoadingMessages,
  isOutputted,
  messages,
  partsByMessageId
}) => {
  return (
    <div className="bubble mb-auto flex min-h-0 w-full flex-1 overflow-hidden bg-transparent! [-webkit-app-region:no-drag]">
      <Messages
        conversationKey={conversationKey}
        initialPosition={initialPosition}
        isLoadingMessages={isLoadingMessages}
        route={route}
        isOutputted={isOutputted}
        messages={messages}
        partsByMessageId={partsByMessageId}
      />
    </div>
  )
}

export default ChatWindow
