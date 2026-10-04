import type { RatesPayload } from '../worker/index'

export type Currency = 'CNY' | 'BRL'

export function parseBrazilianNumber(input: string): number | null {
  const value = input.trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '')
  if (!value || value === '-' || value === ',' || value === '.') return null
  const normalized = value.includes(',')
    ? value.replace(/\./g, '').replace(',', '.')
    : /^-?\d{1,3}(\.\d{3})+$/.test(value)
      ? value.replace(/\./g, '')
      : value
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export function convert(amount: number, from: Currency, sellRate: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(sellRate) || sellRate <= 0) return 0
  return from === 'CNY' ? amount * sellRate : amount / sellRate
}

export function formatCurrency(amount: number, currency: Currency): string {
  if (!Number.isFinite(amount)) amount = 0
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: currency === 'CNY' ? 'CNY' : 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount).replace('CN¥', '¥')
}

export function isRatesPayload(value: unknown): value is RatesPayload {
  if (typeof value !== 'object' || value === null) return false
  const rates = value as Partial<RatesPayload>
  const validQuote = (quote: unknown) => {
    if (typeof quote !== 'object' || quote === null) return false
    const item = quote as Partial<RatesPayload['latest']>
    return typeof item.buy === 'number' && Number.isFinite(item.buy) && item.buy > 0
      && typeof item.sell === 'number' && Number.isFinite(item.sell) && item.sell > 0
      && typeof item.date === 'string' && item.date.length > 0
      && typeof item.timestamp === 'string' && item.timestamp.length > 0
  }
  const changes = rates.changes
  return rates.currency === 'CNY' && rates.target === 'BRL'
    && validQuote(rates.latest)
    && typeof changes?.previous === 'number' && Number.isFinite(changes.previous)
    && typeof changes.sevenDays === 'number' && Number.isFinite(changes.sevenDays)
    && typeof changes.thirtyDays === 'number' && Number.isFinite(changes.thirtyDays)
    && Array.isArray(rates.history) && rates.history.every(validQuote)
}

export function selectRatesFallback(current: RatesPayload | null, stored: unknown): RatesPayload | null {
  return current ?? (isRatesPayload(stored) ? stored : null)
}

export function trend(value: number): 'up' | 'flat' | 'down' {
  if (value > 0.05) return 'up'
  if (value < -0.05) return 'down'
  return 'flat'
}
