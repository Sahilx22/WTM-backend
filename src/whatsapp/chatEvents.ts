import { EventEmitter } from 'node:events'

export interface NormalizedChatMessage {
  id: string
  direction: 'inbound' | 'outbound'
  messageType: 'text' | 'image' | 'video' | 'audio' | 'document'
  text: string | null
  mediaUrl: string | null
  mediaMimetype: string | null
  status: string | null
  waMessageId: string | null
  createdAt: string
}

export interface ChatMessageEvent {
  organizationId: number
  contactId: number
  message: NormalizedChatMessage
}

// Kept separate from connectionManager.ts's own connectionEvents/
// messageAckEvents so both connectionManager.ts (persists inbound chat
// messages) and queue/outgoingWorker.ts (persists outbound send status) can
// import this without a circular import back through connectionManager.ts.
export const chatMessageEvents = new EventEmitter()
