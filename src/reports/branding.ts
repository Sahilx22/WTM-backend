import { db } from '../db/index.js'

export interface ReportBranding {
  companyName: string
  logoBuffer: Buffer | null
  adminWaNumber: string | null
}

const FALLBACK_NAME = 'WhatsApp Task Report'
const LOGO_FETCH_TIMEOUT_MS = 5000

// pdfkit only embeds PNG/JPEG — sniff the actual bytes rather than trusting
// a possibly-generic Content-Type header from wherever the org hosted it.
function isSupportedImage(buf: Buffer): boolean {
  if (buf.length < 4) return false
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true // JPEG
  return false
}

async function fetchLogoBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return isSupportedImage(buf) ? buf : null
  } catch {
    // Unreachable/slow/invalid logo URL should never block report generation.
    return null
  }
}

// Reports are branded for whichever organization the caller already knows
// it's generating for — every caller has this now (a WhatsApp session
// always belongs to exactly one organization; a logged-in org user's own
// token carries it too). Falls back to the first organization on record
// (used for the super admin's unscoped cross-org views), then to a generic
// label if there's none at all.
export async function loadReportBranding(organizationId?: number): Promise<ReportBranding> {
  const org =
    organizationId !== undefined
      ? await db.selectFrom('organizations').select(['name', 'logo_url', 'admin_wa_number']).where('id', '=', organizationId).executeTakeFirst()
      : await db.selectFrom('organizations').select(['name', 'logo_url', 'admin_wa_number']).orderBy('id', 'asc').executeTakeFirst()

  if (!org) return { companyName: FALLBACK_NAME, logoBuffer: null, adminWaNumber: null }

  // Missing logo/number for this org just render blank in the PDF — never
  // borrowed from another organization's row.
  const logoBuffer = org.logo_url ? await fetchLogoBuffer(org.logo_url) : null
  return { companyName: org.name, logoBuffer, adminWaNumber: org.admin_wa_number }
}
