export function normalizePhoneDigits(input: string): string {
  return input.replace(/[^0-9]/g, '')
}

export function isValidPhoneDigits(digits: string): boolean {
  return /^[1-9]\d{7,14}$/.test(digits)
}

export function phoneToJid(digits: string): string {
  return `${digits}@s.whatsapp.net`
}
