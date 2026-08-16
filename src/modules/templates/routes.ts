import { Router } from 'express'
import { db } from '../../db/index.js'
import { templateInputSchema } from './schemas.js'
import { mediaUpload, validateMediaFile, deleteUploadedFile, uploadMediaToS3, getMediaSignedUrl } from '../../lib/mediaUpload.js'
import { recordAuditLog } from '../../lib/auditLog.js'

export const templatesRouter = Router()

async function withMediaUrl<T extends { media_path: string | null }>(template: T): Promise<T & { mediaUrl: string | null }> {
  const mediaUrl = template.media_path ? await getMediaSignedUrl(template.media_path) : null
  return { ...template, mediaUrl }
}

templatesRouter.get('/templates', async (_req, res) => {
  const rows = await db.selectFrom('message_templates').selectAll().orderBy('created_at', 'desc').execute()
  const templates = await Promise.all(rows.map(withMediaUrl))
  res.json({ templates })
})

templatesRouter.get('/templates/:id', async (req, res) => {
  const id = Number(req.params.id)
  const row = await db.selectFrom('message_templates').selectAll().where('id', '=', id).executeTakeFirst()
  if (!row) {
    res.status(404).json({ error: 'Template not found.' })
    return
  }
  res.json({ template: await withMediaUrl(row) })
})

templatesRouter.post('/templates', mediaUpload.single('file'), async (req, res) => {
  const parsed = templateInputSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const { name, message_type, body_text } = parsed.data

  let mediaPath: string | null = null
  let mediaMimetype: string | null = null

  if (message_type === 'text') {
    if (!body_text) {
      res.status(400).json({ error: 'Enter the message text for a text template.' })
      return
    }
    // Any file accidentally attached to a text template is simply ignored —
    // with memory-storage multer, nothing was uploaded to storage yet, so
    // there's nothing to clean up.
  } else {
    if (!req.file) {
      res.status(400).json({ error: `Attach a ${message_type} file for this template.` })
      return
    }
    const mediaError = validateMediaFile(message_type, req.file)
    if (mediaError) {
      res.status(400).json({ error: mediaError })
      return
    }
    mediaPath = await uploadMediaToS3(req.file)
    mediaMimetype = req.file.mimetype
  }

  const created = await db
    .insertInto('message_templates')
    .values({
      name,
      message_type,
      body_text,
      media_path: mediaPath,
      media_mimetype: mediaMimetype,
      created_by: req.user?.id ?? null
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'template_created',
    entityType: 'message_template',
    entityId: created.id,
    ipAddress: req.ip
  })

  res.status(201).json({ id: created.id })
})

templatesRouter.put('/templates/:id', mediaUpload.single('file'), async (req, res) => {
  const id = Number(req.params.id)
  const existing = await db.selectFrom('message_templates').selectAll().where('id', '=', id).executeTakeFirst()
  if (!existing) {
    res.status(404).json({ error: 'Template not found.' })
    return
  }

  const parsed = templateInputSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const { name, message_type, body_text, remove_media } = parsed.data

  let mediaPath = existing.media_path
  let mediaMimetype = existing.media_mimetype

  if (message_type === 'text') {
    if (!body_text) {
      res.status(400).json({ error: 'Enter the message text for a text template.' })
      return
    }
    if (existing.media_path) deleteUploadedFile(existing.media_path)
    mediaPath = null
    mediaMimetype = null
  } else if (req.file) {
    const mediaError = validateMediaFile(message_type, req.file)
    if (mediaError) {
      res.status(400).json({ error: mediaError })
      return
    }
    const newKey = await uploadMediaToS3(req.file)
    if (existing.media_path) deleteUploadedFile(existing.media_path)
    mediaPath = newKey
    mediaMimetype = req.file.mimetype
  } else if (remove_media === 'true') {
    if (existing.media_path) deleteUploadedFile(existing.media_path)
    mediaPath = null
    mediaMimetype = null
  }

  if (message_type !== 'text' && !mediaPath) {
    res.status(400).json({ error: `Attach a ${message_type} file for this template.` })
    return
  }

  await db
    .updateTable('message_templates')
    .set({
      name,
      message_type,
      body_text,
      media_path: mediaPath,
      media_mimetype: mediaMimetype,
      updated_at: new Date()
    })
    .where('id', '=', id)
    .execute()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'template_updated',
    entityType: 'message_template',
    entityId: id,
    ipAddress: req.ip
  })

  res.status(204).end()
})

templatesRouter.delete('/templates/:id', async (req, res) => {
  const id = Number(req.params.id)
  const existing = await db
    .selectFrom('message_templates')
    .select(['media_path'])
    .where('id', '=', id)
    .executeTakeFirst()

  await db.deleteFrom('message_templates').where('id', '=', id).execute()
  if (existing?.media_path) deleteUploadedFile(existing.media_path)

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'template_deleted',
    entityType: 'message_template',
    entityId: id,
    ipAddress: req.ip
  })

  res.status(204).end()
})
