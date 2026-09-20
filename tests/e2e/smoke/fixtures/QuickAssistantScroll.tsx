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
  return (
    <article style={{ width: '100%', flexShrink: 0 }}>
      {message.status === 'pending' && <div style={{ height: 44 }}>Processing</div>}
      {Array.from({ length: 80 }, (_, index) => (
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
  const message = { id: 'answer', role: 'assistant', status } as MessageListItem
  return (
    <>
      <button onClick={() => setStatus('success')}>Complete response</button>
      <div style={{ display: 'flex', flexDirection: 'column', width: 800, height: 560 }}>
        <ChatWindow assistant={null} route="chat" isOutputted messages={[message]} partsByMessageId={{ answer: [] }} />
      </div>
    </>
  )
}

void i18next.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false })
createRoot(document.getElementById('root')!).render(<Fixture />)
