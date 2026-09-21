import { getMediaSignedUrl } from '../../lib/mediaUpload.js'
import type { ChatMessage, Message } from '../../db/schema.js'
import type { NormalizedChatMessage } from '../../whatsapp/chatEvents.js'

export type { NormalizedChatMessage } from '../../whatsapp/chatEvents.js'

// `messages` (outbound, queued through this app) and `chat_messages`
// (inbound, plus the rare message sent manually from the linked phone) are
// two independent auto-increment sequences — prefixing their ids keeps the
// merged thread free of collisions without needing a shared id space.
export async function normalizeOutboundRow(row: Message): Promise<NormalizedChatMessage> {
  return {
    id: `msg-${row.id}`,
    direction: 'outbound',
    messageType: row.message_type,
    text: row.message_text,
    mediaUrl: row.media_path ? await getMediaSignedUrl(row.media_path) : null,
    mediaMimetype: row.media_mimetype,
    status: row.status,
    waMessageId: row.wa_message_id,
    createdAt: row.created_at.toISOString()
  }
}

export async function normalizeInboundRow(row: ChatMessage): Promise<NormalizedChatMessage> {
  return {
    id: `chat-${row.id}`,
    direction: row.direction,
    messageType: row.message_type,
    text: row.message_text,
    mediaUrl: row.media_path ? await getMediaSignedUrl(row.media_path) : null,
    mediaMimetype: row.media_mimetype,
    status: null,
    waMessageId: row.wa_message_id,
    createdAt: row.created_at.toISOString()
  }
}
