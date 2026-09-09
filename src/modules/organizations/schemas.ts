import { z } from 'zod'

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(120),
  admin_wa_number: z.string().min(1).max(32).optional(),
  // How many concurrent WhatsApp sessions (the org's own number plus,
  // optionally, one per employee who can delegate tasks) this org is
  // allowed to connect at once.
  max_sessions: z.number().int().min(1).max(20).optional(),
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(200),
  display_name: z.string().min(1).max(120)
})

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  admin_wa_number: z.string().min(1).max(32).nullable().optional(),
  max_sessions: z.number().int().min(1).max(20).optional(),
  is_active: z.boolean().optional()
})

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
