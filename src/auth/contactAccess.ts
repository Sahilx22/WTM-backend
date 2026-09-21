import type { NextFunction, Request, Response } from 'express'
import { db } from '../db/index.js'
import type { Contact } from '../db/schema.js'

declare global {
  namespace Express {
    interface Request {
      // Set by requireContactAccess once it has verified the caller may see
      // this contact — downstream handlers read it instead of re-querying.
      chatContact?: Contact
    }
  }
}

// Gates every per-contact Chat route. Org-scoping alone (what every other
// module in this app relies on) is not enough here: a restricted user must
// additionally hold a contact_access_grants row for this exact contact.
// Admins skip that check — org-scoping is sufficient for them, per the
// confirmed requirement that admins can use Chat freely across their org.
export async function requireContactAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const organizationId = req.user?.organizationId
  const contactId = Number(req.params.contactId)

  if (!organizationId || !Number.isInteger(contactId)) {
    res.status(404).json({ error: 'Contact not found.' })
    return
  }

  // Scoped to this organization so a contact id from another org resolves
  // to "not found" rather than leaking its existence.
  const contact = await db
    .selectFrom('contacts')
    .selectAll()
    .where('id', '=', contactId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()

  if (!contact) {
    res.status(404).json({ error: 'Contact not found.' })
    return
  }

  if (req.user?.role === 'restricted') {
    const grant = await db
      .selectFrom('contact_access_grants')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', req.user.id)
      .where('contact_id', '=', contactId)
      .executeTakeFirst()

    if (!grant) {
      res.status(403).json({ error: 'You do not have access to this contact.' })
      return
    }
  }

  req.chatContact = contact
  next()
}
