import { describe, expect, it } from 'vitest'
import {
  buildCsvUrl,
  buildRatesPayload,
  findLatestCnyQuote,
  getSaoPauloDate,
  parseCnyClosingCsv,
  shiftDate
} from './index'

const cnyCsv = (date = '02/10/2026', buy = '0,7790', sell = '0,7791') =>
  `${date};795;A;CNY;${buy};${sell};6,7045;6,7046\r\n${date};796;A;CNH;0,7789;0,7790;6,7058;6,7059\r\n`

const bytes = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
}

const missing = { status: 404, bytes: new ArrayBuffer(0) }

describe('CSV diário de fechamento PTAX', () => {
  it('lê a linha CNY, código 795, e os valores de compra e venda', () => {
    expect(parseCnyClosingCsv(cnyCsv(), '20261002')).toEqual({
      buy: 0.779,
      sell: 0.7791,
      date: '02/10/2026',
      timestamp: '2026-10-02 13:00:00.000'
    })
  })

  it('converte decimais com vírgula antes de validar os números', () => {
    const quote = parseCnyClosingCsv(cnyCsv('02/10/2026', '1,2345', '1,2346'))
    expect(quote?.buy).toBe(1.2345)
    expect(quote?.sell).toBe(1.2346)
  })

  it('ignora CNH código 796 e exige CNY código 795 tipo A', () => {
    const cnhOnly = '02/10/2026;796;A;CNH;0,7789;0,7790;6,7058;6,7059'
    const wrongCode = '02/10/2026;796;A;CNY;0,7790;0,7791;6,7045;6,7046'
    expect(parseCnyClosingCsv(cnhOnly)).toBeNull()
    expect(parseCnyClosingCsv(wrongCode)).toBeNull()
    expect(parseCnyClosingCsv('02/10/2026;795;B;CNY;0,7790;0,7791;6,7;6,7')).toBeNull()
  })

  it('retorna nulo para CSV inválido, decimal inválido ou ausência de CNY', () => {
    expect(parseCnyClosingCsv('conteúdo que não é CSV')).toBeNull()
    expect(parseCnyClosingCsv(cnyCsv('02/10/2026', 'x,7790', '0,7791'))).toBeNull()
    expect(parseCnyClosingCsv('02/10/2026;795;A;CNY;0,7790;0,7791;paridade;6,7')).toBeNull()
    expect(parseCnyClosingCsv('02/10/2026;220;A;USD;5,22;5,23;1;1')).toBeNull()
  })

  it('monta a URL oficial com a data YYYYMMDD', () => {
    expect(buildCsvUrl('20261002').toString()).toBe('https://www4.bcb.gov.br/Download/fechamento/20261002.csv')
    expect(() => buildCsvUrl('02-10-2026')).toThrow('Data inválida')
  })
})

describe('data de Brasília e busca da última cotação', () => {
  it('usa a data America/Sao_Paulo perto da virada do dia UTC', () => {
    expect(getSaoPauloDate(new Date('2026-10-04T02:30:00.000Z'))).toBe('20261003')
    expect(getSaoPauloDate(new Date('2026-10-04T15:00:00.000Z'))).toBe('20261004')
  })

  it('recuo de sábado encontra o fechamento de sexta-feira', async () => {
    const requested: string[] = []
    const quote = await findLatestCnyQuote('20261003', async (date) => {
      requested.push(date)
      return date === '20261002' ? { status: 200, bytes: bytes(cnyCsv()) } : missing
    })
    expect(quote.date).toBe('02/10/2026')
    expect(requested).toEqual(['20261003', '20261002'])
  })

  it('recuo de domingo encontra o fechamento de sexta-feira', async () => {
    const requested: string[] = []
    const quote = await findLatestCnyQuote(getSaoPauloDate(new Date('2026-10-04T15:00:00.000Z')), async (date) => {
      requested.push(date)
      return date === '20261002' ? { status: 200, bytes: bytes(cnyCsv()) } : missing
    })
    expect(quote.date).toBe('02/10/2026')
    expect(requested).toEqual(['20261004', '20261003', '20261002'])
  })

  it('passa por um feriado simulado e usa o último arquivo válido', async () => {
    const requested: string[] = []
    const quote = await findLatestCnyQuote('20261005', async (date) => {
      requested.push(date)
      return date === '20261002' ? { status: 200, bytes: bytes(cnyCsv()) } : missing
    })
    expect(quote.date).toBe('02/10/2026')
    expect(requested).toEqual(['20261005', '20261004', '20261003', '20261002'])
  })

  it('continua após arquivo vazio, HTTP 404 ou CSV sem CNY, até no máximo dez dias', async () => {
    const requested: string[] = []
    const quote = await findLatestCnyQuote('20261003', async (date) => {
      requested.push(date)
      if (date === '20261003') return { status: 200, bytes: bytes('') }
      if (date === '20261002') return missing
      if (date === '20261001') return { status: 200, bytes: bytes('01/10/2026;220;A;USD;5,22;5,23;1;1') }
      if (date === '20260930') return { status: 200, bytes: bytes(cnyCsv('30/09/2026')) }
      return missing
    })
    expect(quote.date).toBe('30/09/2026')
    expect(requested).toHaveLength(4)

    const noCnyDates: string[] = []
    await expect(findLatestCnyQuote('20261003', async (date) => {
      noCnyDates.push(date)
      return missing
    })).rejects.toThrow('795')
    expect(noCnyDates).toHaveLength(10)
  })

  it('decodifica bytes Windows-1252 antes de localizar a linha CNY', async () => {
    const raw = `Cotação diária – moeda estrangeira\r\n${cnyCsv()}`
    const cp1252 = Uint8Array.from([...raw].map((character) => character === '–' ? 0x96 : character.charCodeAt(0)))
    const quote = await findLatestCnyQuote('20261002', async () => ({ status: 200, bytes: cp1252.buffer }))
    expect(quote.sell).toBe(0.7791)
  })

  it('ordena o histórico e calcula variações a partir das cotações válidas', () => {
    const result = buildRatesPayload([
      { buy: 0.80, sell: 0.82, date: '02/10/2026', timestamp: '2026-10-02 13:00:00.000' },
      { buy: 0.76, sell: 0.78, date: '01/10/2026', timestamp: '2026-10-01 13:00:00.000' },
      { buy: 0.74, sell: 0.76, date: '30/09/2026', timestamp: '2026-09-30 13:00:00.000' }
    ])
    expect(result.history.map((quote) => quote.date)).toEqual(['30/09/2026', '01/10/2026', '02/10/2026'])
    expect(result.latest.buy).toBe(0.8)
    expect(result.latest.sell).toBe(0.82)
    expect(result.changes.previous).toBeCloseTo(5.1282)
  })

  it('avança e recua datas de calendário sem pressupor dias úteis', () => {
    expect(shiftDate('20261004', -2)).toBe('20261002')
    expect(shiftDate('20261002', 3)).toBe('20261005')
  })
})
