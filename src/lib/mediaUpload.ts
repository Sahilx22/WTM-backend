import crypto from 'node:crypto'
import path from 'node:path'
import multer from 'multer'
import { uploadObject, deleteObject, copyObject, getSignedViewUrl } from './s3.js'

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 // overall cap; tighter per-type caps enforced after upload

export const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } })

export type MediaMessageType = 'image' | 'video' | 'audio' | 'document'

interface MediaTypeRule {
  mimePrefixes: string[]
  maxBytes: number
  label: string
}

// document has no mimetype allowlist — WhatsApp documents can be almost any file type.
export const MEDIA_RULES: Record<MediaMessageType, MediaTypeRule> = {
  image: { mimePrefixes: ['image/'], maxBytes: 16 * 1024 * 1024, label: 'Image' },
  video: { mimePrefixes: ['video/'], maxBytes: 64 * 1024 * 1024, label: 'Video' },
  audio: { mimePrefixes: ['audio/'], maxBytes: 16 * 1024 * 1024, label: 'Audio' },
  document: { mimePrefixes: [], maxBytes: 100 * 1024 * 1024, label: 'Document' }
}

export function validateMediaFile(messageType: string, file: Express.Multer.File): string | null {
  const rule = MEDIA_RULES[messageType as MediaMessageType]
  if (!rule) return 'Unsupported message type.'

  if (file.size > rule.maxBytes) {
    return `${rule.label} files must be under ${Math.round(rule.maxBytes / 1024 / 1024)}MB.`
  }

  if (rule.mimePrefixes.length > 0 && !rule.mimePrefixes.some((p) => file.mimetype.startsWith(p))) {
    return `That file doesn't look like a ${rule.label.toLowerCase()} (detected type: ${file.mimetype}).`
  }

  return null
}

function generateKey(originalname: string): string {
  const rawExt = path.extname(originalname).toLowerCase()
  const ext = /^\.[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : ''
  return `${crypto.randomUUID()}${ext}`
}

// Uploads a freshly-validated file to object storage and returns its key.
// Only ever called after validateMediaFile has passed, so nothing invalid
// ever reaches storage.
export async function uploadMediaToS3(file: Express.Multer.File): Promise<string> {
  const key = generateKey(file.originalname)
  await uploadObject(key, file.buffer, file.mimetype)
  return key
}

export function deleteUploadedFile(key: string | null | undefined): void {
  if (!key) return
  void deleteObject(key)
}

// Duplicates an existing object under a new key so the copy's lifecycle (e.g.
// a queued message) is independent from the original's (e.g. a template that
// might get edited or deleted later).
export async function copyUploadedFile(existingKey: string): Promise<string> {
  const newKey = generateKey(existingKey)
  await copyObject(existingKey, newKey)
  return newKey
}

export async function getMediaSignedUrl(key: string): Promise<string> {
  return getSignedViewUrl(key)
}
