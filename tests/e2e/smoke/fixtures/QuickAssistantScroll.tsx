import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'
import i18next from 'i18next'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initReactI18next } from 'react-i18next'

import type { MessageListItem } from '@renderer/components/chat/messages/types'
import ChatWindow from '@renderer/windows/quickAssistant/chat/ChatWindow'

// Keep the production viewport and controller; replace only unrelated content and data inputs.
export function MessageItem({ message }: { message: MessageListItem }) {
  if (message.role === 'user') return <p>{message.id}: Original question</p>
  return (
    <article style={{ width: '100%', flexShrink: 0 }}>
      {message.status === 'pending' && <div style={{ height: 44 }}>Processing</div>}
      {Array.from({ length: message.id === 'short-answer' ? 3 : 80 }, (_, index) => (
        <p key={index} style={{ height: 48, margin: 0 }}>
          Paragraph {index}
        </p>
      ))}
    </article>
  )
}

export const useMessageListRenderConfig = () => ({ renderConfig: {} })
export const useMessagePlatformActions = () => ({})
const topicStatus = { status: undefined, activeExecutions: [], awaitingApprovalAnchors: [] }
export const useTopicStreamStatus = () => topicStatus

function Fixture() {
  const [status, setStatus] = useState<MessageListItem['status']>('pending')
  const [conversation, setConversation] = useState('live')
  const [loadingMessages, setLoadingMessages] = useState<MessageListItem[] | null>(null)
  const messages = [
    { id: `${conversation}-question`, role: 'user', status: 'success' },
    { id: `${conversation}-answer`, role: 'assistant', status }
  ] as MessageListItem[]
  return (
    <>
      <button onClick={() => setStatus('success')}>Complete response</button>
      <button onClick={() => setConversation('history')}>Open history</button>
      <button onClick={() => setConversation('short')}>Open short conversation</button>
      <button
        onClick={() => {
          setLoadingMessages(messages)
          setConversation('history')
        }}>
        Reopen history with loading
      </button>
      <button onClick={() => setLoadingMessages(null)}>Finish loading</button>
      <div style={{ display: 'flex', flexDirection: 'column', width: 800, height: 560 }}>
        <ChatWindow
          conversationKey={conversation}
          initialPosition={conversation === 'live' ? 'end' : 'start'}
          route="chat"
          isOutputted
          messages={loadingMessages ?? messages}
          isLoadingMessages={loadingMessages !== null}
          partsByMessageId={{}}
        />
      </div>
    </>
  )
}

void i18next.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false })
createRoot(document.getElementById('root')!).render(<Fixture />)
