import path from 'node:path'
import type { AnyMessageContent } from '@whiskeysockets/baileys'
import { getMediaSignedUrl } from '../lib/mediaUpload.js'
import type { MessageType } from '../db/schema.js'

export interface SendableMessage {
  message_type: MessageType
  message_text: string | null
  media_path: string | null
  media_mimetype?: string | null
}

export async function buildMessageContent(message: SendableMessage): Promise<AnyMessageContent> {
  const caption = message.message_text ?? undefined

  switch (message.message_type) {
    case 'text':
      return { text: message.message_text ?? '' }

    case 'image':
      if (!message.media_path) throw new Error('Image message is missing its media file.')
      return { image: { url: await getMediaSignedUrl(message.media_path) }, caption }

    case 'video':
      if (!message.media_path) throw new Error('Video message is missing its media file.')
      return { video: { url: await getMediaSignedUrl(message.media_path) }, caption }

    case 'audio':
      if (!message.media_path) throw new Error('Audio message is missing its media file.')
      return {
        audio: { url: await getMediaSignedUrl(message.media_path) },
        mimetype: message.media_mimetype ?? 'audio/mpeg'
      }

    case 'document':
      if (!message.media_path) throw new Error('Document message is missing its media file.')
      return {
        document: { url: await getMediaSignedUrl(message.media_path) },
        mimetype: message.media_mimetype ?? 'application/octet-stream',
        fileName: path.basename(message.media_path),
        caption
      }

    default:
      throw new Error(`Unsupported message type: ${message.message_type satisfies never}`)
  }
}
