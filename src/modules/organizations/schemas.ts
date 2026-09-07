import { z } from 'zod'

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(120),
  admin_wa_number: z.string().min(1).max(32).optional(),
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(200),
  display_name: z.string().min(1).max(120)
})

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  admin_wa_number: z.string().min(1).max(32).nullable().optional(),
  is_active: z.boolean().optional()
})

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
