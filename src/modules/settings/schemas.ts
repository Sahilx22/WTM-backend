import { z } from 'zod'

export const rateLimitConfigSchema = z
  .object({
    max_per_minute: z.coerce.number().int().min(1).max(1000),
    max_per_hour: z.coerce.number().int().min(1).max(20000),
    min_delay_ms: z.coerce.number().int().min(500).max(600000),
    max_delay_ms: z.coerce.number().int().min(500).max(600000),
    concurrency: z.coerce.number().int().min(1).max(5),
    pause_after_consecutive_failures: z.coerce.number().int().min(1).max(100)
  })
  .refine((d) => d.max_delay_ms >= d.min_delay_ms, {
    message: 'Max delay must be greater than or equal to min delay.',
    path: ['max_delay_ms']
  })

export type RateLimitConfigInput = z.infer<typeof rateLimitConfigSchema>

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const timeField = z.string().regex(TIME_RE, 'Use 24-hour HH:MM format')
const checkboxField = z
  .string()
  .optional()
  .transform((v) => v === 'true')

export const taskSettingsSchema = z.object({
  reminder_hourly_minutes: z.coerce.number().int().min(1).max(10080),
  reminder_daily_minutes: z.coerce.number().int().min(1).max(10080),
  reminder_weekly_minutes: z.coerce.number().int().min(1).max(43200),
  auto_report_daily_enabled: checkboxField,
  auto_report_daily_time: timeField,
  auto_report_weekly_enabled: checkboxField,
  auto_report_weekly_day: z.enum([
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday'
  ]),
  auto_report_weekly_time: timeField,
  auto_report_monthly_enabled: checkboxField,
  auto_report_monthly_day: z.coerce.number().int().min(1).max(28),
  auto_report_monthly_time: timeField,
  reminder_daily_time: timeField,
  daily_overview_enabled: checkboxField,
  daily_overview_time: timeField,
  weekly_report_enabled: checkboxField,
  weekly_report_day: z.enum([
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday'
  ]),
  weekly_report_time: timeField,
  review_digest_enabled: checkboxField,
  review_digest_time: timeField
})

export type TaskSettingsInput = z.infer<typeof taskSettingsSchema>
