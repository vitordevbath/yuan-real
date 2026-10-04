import { describe, expect, it } from 'vitest'
import { convert, formatCurrency, isRatesPayload, parseBrazilianNumber, selectRatesFallback } from './domain'
import { buildRatesPayload } from '../worker/index'

const quote = (date: string, sell: number, buy = sell - 0.02) => ({ buy, sell, date, timestamp: `${date.split('/').reverse().join('-')} 13:00:00.000` })

describe('conversão e valores em pt-BR', () => {
  it('converte CNY para BRL usando a taxa de venda', () => {
    expect(convert(10, 'CNY', 0.78)).toBeCloseTo(7.8)
  })

  it('converte BRL para CNY usando a taxa inversa', () => {
    expect(convert(78, 'BRL', 0.78)).toBeCloseTo(100)
  })

  it('mantém valores decimais e formata as moedas', () => {
    expect(convert(10.5, 'CNY', 0.78)).toBeCloseTo(8.19)
    expect(formatCurrency(1234.56, 'BRL')).toBe('R$ 1.234,56')
    expect(formatCurrency(1234.56, 'CNY')).toBe('¥ 1.234,56')
  })

  it.each([
    ['1', 1], ['10', 10], ['10,50', 10.5], ['1.000,50', 1000.5], ['1.000', 1000], ['1.5', 1.5]
  ])('interpreta %s no padrão esperado', (input, expected) => {
    expect(parseBrazilianNumber(input)).toBe(expected)
  })
})

describe('fallback local de cotação', () => {
  it('usa a cotação armazenada como fallback se a consulta falhar', () => {
    const stored = buildRatesPayload([quote('02/10/2026', 0.79)])
    expect(isRatesPayload(stored)).toBe(true)
    expect(isRatesPayload({ ...stored, history: [{ sell: Number.NaN }] })).toBe(false)
    expect(selectRatesFallback(null, stored)).toEqual(stored)
    expect(selectRatesFallback(null, { latest: { sell: 'inválida' } })).toBeNull()
    expect(selectRatesFallback(stored, null)).toEqual(stored)
  })
})
