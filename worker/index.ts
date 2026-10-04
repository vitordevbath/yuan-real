interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

interface WorkerCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

interface CacheStorageWithDefault extends CacheStorage {
  default?: WorkerCache
}

interface DailyCsvCache {
  get(date: string): Promise<{ status: number; bytes: ArrayBuffer } | null>
  put(date: string, status: number, bytes: ArrayBuffer, ttlSeconds: number): Promise<void>
}

export interface Quote {
  buy: number
  sell: number
  date: string
  timestamp: string
}

export interface RatesPayload {
  currency: 'CNY'
  target: 'BRL'
  latest: Quote
  changes: { previous: number; sevenDays: number; thirtyDays: number }
  history: Quote[]
}

const CSV_BASE_URL = 'https://www4.bcb.gov.br/Download/fechamento/'
const SAO_PAULO_TIME_ZONE = 'America/Sao_Paulo'
const MAX_LOOKBACK_DAYS = 10
const HISTORY_CALENDAR_DAYS = 45
const HISTORY_TARGET_CLOSINGS = 30
const HISTORY_BATCH_SIZE = 6
const REQUEST_TIMEOUT_MS = 6000
const CURRENT_CSV_TTL_SECONDS = 180
const HISTORICAL_CSV_TTL_SECONDS = 60 * 60 * 24 * 30
const RATE_RESPONSE_TTL_SECONDS = 180
const DAY_MS = 24 * 60 * 60 * 1000

function datePartsInSaoPaulo(now: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAO_PAULO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now)
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return { year: value('year'), month: value('month'), day: value('day') }
}

export function getSaoPauloDate(now: Date): string {
  const { year, month, day } = datePartsInSaoPaulo(now)
  return `${year}${month}${day}`
}

export function shiftDate(date: string, days: number): string {
  if (!/^\d{8}$/.test(date)) throw new Error('Data inválida para consulta PTAX.')
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(4, 6))
  const day = Number(date.slice(6, 8))
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}${String(shifted.getUTCDate()).padStart(2, '0')}`
}

export function buildCsvUrl(date: string): URL {
  if (!/^\d{8}$/.test(date)) throw new Error('Data inválida para consulta PTAX.')
  return new URL(`${date}.csv`, CSV_BASE_URL)
}

function parsePositiveDecimal(value: string | undefined): number | null {
  if (!value) return null
  const decimal = value.trim()
  if (!/^\d+(?:,\d+)?$/.test(decimal)) return null
  const number = Number(decimal.replace(',', '.'))
  return Number.isFinite(number) && number > 0 ? number : null
}

function parseDate(value: string | undefined): { compact: string; formatted: string } | null {
  if (!value) return null
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim())
  if (!match) return null
  const [, day, month, year] = match
  if (!day || !month || !year) return null
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null
  return { compact: `${year}${month}${day}`, formatted: `${day}/${month}/${year}` }
}

export function parseCnyClosingCsv(csv: string, expectedDate?: string): Quote | null {
  for (const line of csv.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const columns = line.split(';').map((column) => column.trim())
    const date = parseDate(columns[0])
    if (!date || (expectedDate && date.compact !== expectedDate)) continue
    if (columns[1] !== '795' || columns[2] !== 'A' || columns[3]?.toUpperCase() !== 'CNY') continue
    const buy = parsePositiveDecimal(columns[4])
    const sell = parsePositiveDecimal(columns[5])
    const parityBuy = parsePositiveDecimal(columns[6])
    const paritySell = parsePositiveDecimal(columns[7])
    if (buy === null || sell === null || parityBuy === null || paritySell === null) return null
    return {
      buy,
      sell,
      date: date.formatted,
      timestamp: `${date.compact.slice(0, 4)}-${date.compact.slice(4, 6)}-${date.compact.slice(6, 8)} 13:00:00.000`
    }
  }
  return null
}

function quoteDate(quote: Quote): Date {
  const [day, month, year] = quote.date.split('/').map(Number)
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1))
}

function percentChange(current: number, earlier: number): number {
  return earlier > 0 ? Number((((current - earlier) / earlier) * 100).toFixed(4)) : 0
}

function calculateChanges(history: Quote[]): RatesPayload['changes'] {
  const latest = history.at(-1)
  if (!latest) return { previous: 0, sevenDays: 0, thirtyDays: 0 }
  const previous = history.at(-2)
  const findAtOrBefore = (days: number) => {
    const target = quoteDate(latest).getTime() - days * DAY_MS
    return [...history].reverse().find((quote) => quoteDate(quote).getTime() <= target)
  }
  return {
    previous: previous ? percentChange(latest.sell, previous.sell) : 0,
    sevenDays: percentChange(latest.sell, findAtOrBefore(7)?.sell ?? 0),
    thirtyDays: percentChange(latest.sell, findAtOrBefore(30)?.sell ?? 0)
  }
}

export function buildRatesPayload(quotes: Quote[]): RatesPayload {
  const ordered = [...quotes].sort((a, b) => quoteDate(a).getTime() - quoteDate(b).getTime())
  const unique = new Map<string, Quote>()
  for (const quote of ordered) unique.set(quote.date, quote)
  const history = [...unique.values()]
  const latest = history.at(-1)
  if (!latest) throw new Error('Nenhuma cotação de fechamento encontrada.')
  return { currency: 'CNY', target: 'BRL', latest, changes: calculateChanges(history), history }
}

function decodeCsv(bytes: ArrayBuffer): string {
  return new TextDecoder('windows-1252').decode(bytes)
}

function cacheRequest(origin: string, key: string): Request {
  return new Request(new URL(`/__yuan-real-cache/${key}`, origin), { method: 'GET' })
}

function createEdgeCsvCache(origin: string, cache?: WorkerCache): DailyCsvCache | undefined {
  if (!cache) return undefined
  return {
    async get(date) {
      try {
        const response = await cache.match(cacheRequest(origin, `csv/${date}`))
        if (!response) return null
        const status = Number(response.headers.get('x-source-status'))
        return { status: Number.isFinite(status) ? status : 200, bytes: await response.arrayBuffer() }
      } catch {
        return null
      }
    },
    async put(date, status, bytes, ttlSeconds) {
      const response = new Response(bytes, {
        headers: {
          'cache-control': `public, max-age=${ttlSeconds}`,
          'content-type': 'text/csv; charset=windows-1252',
          'x-source-status': String(status)
        }
      })
      try {
        await cache.put(cacheRequest(origin, `csv/${date}`), response)
      } catch {
        // Cache is an optimization; PTAX data remains available without it.
      }
    }
  }
}

function makeCsvLoader(fetcher: typeof fetch, cache?: DailyCsvCache, nowDate?: string) {
  const inRequest = new Map<string, Promise<{ status: number; bytes: ArrayBuffer }>>()
  return (date: string) => {
    const existing = inRequest.get(date)
    if (existing) return existing
    const loading = (async () => {
      const cached = await cache?.get(date)
      if (cached) return cached
      const response = await fetcher(buildCsvUrl(date), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'text/csv,*/*;q=0.8' }
      })
      const bytes = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0)
      if (response.ok || response.status === 404) {
        const ttl = date === nowDate ? CURRENT_CSV_TTL_SECONDS : HISTORICAL_CSV_TTL_SECONDS
        await cache?.put(date, response.status, bytes, ttl)
      }
      return { status: response.status, bytes }
    })()
    inRequest.set(date, loading)
    return loading
  }
}

export async function findLatestCnyQuote(startDate: string, loadCsv: (date: string) => Promise<{ status: number; bytes: ArrayBuffer }>): Promise<Quote> {
  for (let offset = 0; offset < MAX_LOOKBACK_DAYS; offset += 1) {
    const date = shiftDate(startDate, -offset)
    const file = await loadCsv(date)
    if (file.status < 200 || file.status >= 300 || file.bytes.byteLength === 0) continue
    const quote = parseCnyClosingCsv(decodeCsv(file.bytes), date)
    if (quote) return quote
  }
  throw new Error(`Não foi encontrada cotação CNY (código BCB 795) nos últimos ${MAX_LOOKBACK_DAYS} dias.`)
}

async function loadHistory(latest: Quote, loadCsv: (date: string) => Promise<{ status: number; bytes: ArrayBuffer }>): Promise<Quote[]> {
  const latestCompact = latest.timestamp.slice(0, 10).replaceAll('-', '')
  const quotes = new Map<string, Quote>([[latest.date, latest]])
  for (let offset = 1; offset < HISTORY_CALENDAR_DAYS && quotes.size < HISTORY_TARGET_CLOSINGS; offset += HISTORY_BATCH_SIZE) {
    const dates = Array.from({ length: Math.min(HISTORY_BATCH_SIZE, HISTORY_CALENDAR_DAYS - offset) }, (_, index) => shiftDate(latestCompact, -(offset + index)))
    const files = await Promise.allSettled(dates.map((date) => loadCsv(date)))
    files.forEach((result, index) => {
      if (result.status === 'rejected') return
      const file = result.value
      const date = dates[index]
      if (!date || file.status < 200 || file.status >= 300 || file.bytes.byteLength === 0) return
      const quote = parseCnyClosingCsv(decodeCsv(file.bytes), date)
      if (quote) quotes.set(quote.date, quote)
    })
  }
  return [...quotes.values()].sort((a, b) => quoteDate(a).getTime() - quoteDate(b).getTime())
}

export async function getRates(now = new Date(), fetcher: typeof fetch = fetch, csvCache?: DailyCsvCache): Promise<RatesPayload> {
  const today = getSaoPauloDate(now)
  const loadCsv = makeCsvLoader(fetcher, csvCache, today)
  const latest = await findLatestCnyQuote(today, loadCsv)
  const history = await loadHistory(latest, loadCsv)
  return buildRatesPayload(history)
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}

async function cachedRatesResponse(request: Request, cache: WorkerCache | undefined): Promise<Response | null> {
  if (!cache) return null
  try {
    const cached = await cache.match(cacheRequest(new URL(request.url).origin, 'api/rates'))
    if (!cached) return null
    return new Response(cached.body, {
      status: cached.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    })
  } catch {
    return null
  }
}

async function cacheRatesResponse(request: Request, response: Response, cache: WorkerCache | undefined): Promise<void> {
  if (!cache || !response.ok) return
  const cachedResponse = new Response(response.clone().body, {
    status: response.status,
    headers: { 'cache-control': `public, max-age=${RATE_RESPONSE_TTL_SECONDS}`, 'content-type': 'application/json; charset=utf-8' }
  })
  try {
    await cache.put(cacheRequest(new URL(request.url).origin, 'api/rates'), cachedResponse)
  } catch {
    // Cache is an optimization; PTAX data remains available without it.
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/api/rates' || request.method !== 'GET') return json({ error: 'Rota não encontrada.' }, 404)
      const workerCache = (globalThis.caches as CacheStorageWithDefault | undefined)?.default
      const cached = await cachedRatesResponse(request, workerCache)
      if (cached) return cached
      try {
        const rates = await getRates(new Date(), fetch, createEdgeCsvCache(url.origin, workerCache))
        const response = json(rates)
        await cacheRatesResponse(request, response, workerCache)
        return response
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Não foi possível consultar o Banco Central.'
        return json({ error: message }, 502)
      }
    }
    return env.ASSETS.fetch(request)
  }
}
