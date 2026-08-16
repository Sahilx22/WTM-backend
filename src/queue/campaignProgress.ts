import { EventEmitter } from 'node:events'
import { db } from '../db/index.js'

export const campaignEvents = new EventEmitter()

export async function bumpCampaignCounters(campaignId: number, success: boolean): Promise<void> {
  await db
    .updateTable('campaigns')
    .set((eb) => ({
      processed_count: eb('processed_count', '+', 1),
      success_count: success ? eb('success_count', '+', 1) : eb('success_count', '+', 0),
      failed_count: success ? eb('failed_count', '+', 0) : eb('failed_count', '+', 1),
      updated_at: new Date()
    }))
    .where('id', '=', campaignId)
    .execute()

  const campaign = await db
    .selectFrom('campaigns')
    .select(['id', 'processed_count', 'total_recipients', 'status'])
    .where('id', '=', campaignId)
    .executeTakeFirst()

  if (campaign && campaign.processed_count >= campaign.total_recipients && campaign.status === 'sending') {
    await db
      .updateTable('campaigns')
      .set({ status: 'completed', completed_at: new Date(), updated_at: new Date() })
      .where('id', '=', campaignId)
      .execute()
  }

  campaignEvents.emit('update', campaignId)
}
