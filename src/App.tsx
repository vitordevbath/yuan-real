import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Currency } from './domain'
import { convert, formatCurrency, isRatesPayload, parseBrazilianNumber, selectRatesFallback, trend } from './domain'
import type { RatesPayload } from '../worker/index'

const STORAGE_KEY = 'yuan-real:last-rates:v1'

function readSavedRates(): RatesPayload | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    return isRatesPayload(value) ? value : null
  } catch {
    return null
  }
}

function RateChart({ history }: { history: RatesPayload['history'] }) {
  const points = history.slice(-30)
  if (points.length < 2) {
    return <div className="chart-empty">O histórico ainda não tem pontos suficientes para desenhar o gráfico.</div>
  }
  const width = 720
  const height = 196
  const pad = { left: 4, right: 4, top: 12, bottom: 12 }
  const values = points.map((point) => point.sell)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || max * 0.02 || 1
  const coords = points.map((point, index) => {
    const x = pad.left + (index / (points.length - 1)) * (width - pad.left - pad.right)
    const y = pad.top + ((max - point.sell) / range) * (height - pad.top - pad.bottom)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const first = points[0]
  const last = points.at(-1)
  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Histórico da cotação PTAX de venda do CNY nos últimos 30 registros disponíveis">
        <line className="chart-grid" x1="0" x2={width} y1={height / 2} y2={height / 2} />
        <polyline className="chart-line" points={coords.join(' ')} />
        <circle className="chart-dot" cx={coords.at(-1)?.split(',')[0]} cy={coords.at(-1)?.split(',')[1]} r="4" />
      </svg>
      <div className="chart-labels">
        <span>{first?.date}</span>
        <span>{last?.date}</span>
      </div>
    </div>
  )
}

function Change({ label, value }: { label: string; value: number }) {
  const direction = trend(value)
  return (
    <div className="change-item">
      <span>{label}</span>
      <strong className={`change-value ${direction}`}>{value > 0 ? '+' : ''}{value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</strong>
    </div>
  )
}

export default function App() {
  const [rates, setRates] = useState<RatesPayload | null>(() => readSavedRates())
  const [stale, setStale] = useState(() => readSavedRates() !== null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [source, setSource] = useState<Currency>('CNY')
  const [amount, setAmount] = useState('1')
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    const onlineHandler = () => setOnline(true)
    const offlineHandler = () => setOnline(false)
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)
    return () => {
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/rates', { headers: { accept: 'application/json' } })
      if (!response.ok) {
        let serverMessage = ''
        try {
          const body: unknown = await response.json()
          if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') serverMessage = body.error
        } catch {
          // Use a generic status message if the error response is not JSON.
        }
        throw new Error(serverMessage || (response.status === 502 ? 'O Banco Central está indisponível no momento.' : 'Não foi possível atualizar a cotação.'))
      }
      const value: unknown = await response.json()
      if (!isRatesPayload(value)) throw new Error('O Banco Central retornou dados em formato inválido.')
      setRates(value)
      setStale(false)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch {
        // A calculadora continua funcionando mesmo quando o navegador não permite armazenamento local.
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha de conexão ao atualizar a cotação.')
      const fallback = selectRatesFallback(rates, readSavedRates())
      if (fallback) {
        setRates(fallback)
        setStale(true)
      }
    } finally {
      setLoading(false)
    }
  }, [rates])

  useEffect(() => {
    void refresh()
  }, []) // initial refresh only

  const parsedAmount = parseBrazilianNumber(amount)
  const convertedAmount = useMemo(() => {
    if (parsedAmount === null || !rates) return null
    return convert(parsedAmount, source, rates.latest.sell)
  }, [parsedAmount, rates, source])
  const target: Currency = source === 'CNY' ? 'BRL' : 'CNY'
  const trendText = rates ? ({ up: 'Subindo', flat: 'Estável', down: 'Caindo' } as const)[trend(rates.changes.sevenDays)] : ''

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Yuan Real início">
          <img src="/yuan-real.svg" alt="" width="27" height="27" />
          <span>yuan <b>real</b></span>
        </a>
        <span className="topbar-note">CNY <i /> BRL</span>
      </header>

      <section className="main-content" aria-label="Conversor de moedas">
        <div className="intro">
          <p className="eyebrow">CONVERSOR DE MOEDAS</p>
          <h1>Yuan para Real,<br /><span>sem complicação.</span></h1>
        </div>

        <section className="converter" aria-label="Calculadora">
          <label className="money-field">
            <span className="field-label">{source === 'CNY' ? 'Yuan Chinês' : 'Real Brasileiro'}</span>
            <span className="input-row">
              <span className="currency-symbol">{source === 'CNY' ? '¥' : 'R$'}</span>
              <input
                aria-label={source === 'CNY' ? 'Valor em Yuan Chinês' : 'Valor em Real Brasileiro'}
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <span className="currency-code">{source}</span>
            </span>
          </label>

          <div className="swap-row">
            <span className="swap-rule" />
            <button className="swap-button" type="button" aria-label="Inverter CNY e BRL" onClick={() => setSource((current) => current === 'CNY' ? 'BRL' : 'CNY')}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h11m0 0-3-3m3 3-3 3M16 14H5m0 0 3 3m-3-3 3-3" /></svg>
            </button>
            <span className="swap-rule" />
          </div>

          <div className="money-field result-field" aria-live="polite">
            <span className="field-label">{target === 'BRL' ? 'Real Brasileiro' : 'Yuan Chinês'}</span>
            <div className="input-row result-row">
              <span className="currency-symbol">{target === 'CNY' ? '¥' : 'R$'}</span>
              <output className="result-number">{convertedAmount === null ? '—' : convertedAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</output>
              <span className="currency-code">{target}</span>
            </div>
          </div>

          <div className="rate-summary">
            {rates ? <><strong>1 CNY = {formatCurrency(rates.latest.sell, 'BRL', 4)}</strong><span>PTAX de venda</span></> : <strong>{loading ? 'Buscando cotação…' : 'Cotação indisponível'}</strong>}
          </div>
          {rates && <p className="rate-time">Fechamento de {rates.latest.date}</p>}
          {(stale || error || !online) && (
            <div className="notice" role="status">
              <span className="notice-dot" />
              {rates && stale ? 'Cotação armazenada - pode estar desatualizada' : !online ? 'Sem conexão com a internet' : error}
            </div>
          )}
          <div className="converter-actions">
            <span className="source-line">Fonte: Banco Central do Brasil — PTAX</span>
            <button className="refresh-button" type="button" onClick={() => void refresh()} disabled={loading || !online}>
              <svg className={loading ? 'spinning' : ''} viewBox="0 0 18 18" aria-hidden="true"><path d="M14.8 6.5A6.1 6.1 0 0 0 3.3 6M3.2 3.4v3.2h3.2M3.2 11.5A6.1 6.1 0 0 0 14.7 12m.1 3V12h-3.2" /></svg>
              {loading ? 'Atualizando' : 'Atualizar cotação'}
            </button>
          </div>
        </section>

        {rates && <>
          <section className="history-section" aria-labelledby="history-title">
            <div className="section-heading">
              <div><p className="eyebrow">NOS ÚLTIMOS 30 DIAS</p><h2 id="history-title">Histórico da cotação</h2></div>
              <div className={`trend-pill ${trend(rates.changes.sevenDays)}`}><span />{trendText}</div>
            </div>
            <div className="chart-frame"><RateChart history={rates.history} /></div>
            <div className="changes-grid">
              <Change label="Anterior" value={rates.changes.previous} />
              <Change label="7 dias" value={rates.changes.sevenDays} />
              <Change label="30 dias" value={rates.changes.thirtyDays} />
            </div>
          </section>

          <section className="details-section">
            <button className="details-toggle" type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
              Detalhes da cotação <span>{detailsOpen ? '−' : '+'}</span>
            </button>
            {detailsOpen && <div className="details-content">
              <p><span>PTAX de venda</span><strong>{formatCurrency(rates.latest.sell, 'BRL', 4)}</strong></p>
              <p><span>PTAX de compra</span><strong>{formatCurrency(rates.latest.buy, 'BRL', 4)}</strong></p>
              <p className="disclaimer">A PTAX é uma referência e não garante o preço de uma operação financeira.</p>
            </div>}
          </section>
        </>}
        {!rates && error && <p className="error-help" role="alert">{error} Verifique sua conexão e tente atualizar novamente.</p>}
        <p className="footer-note">A cotação é uma referência PTAX e pode diferir das taxas praticadas por instituições financeiras.</p>
      </section>
      <footer className="page-footer"><span>Feito para conversões do dia a dia.</span><span>Dados oficiais do Banco Central do Brasil</span></footer>
    </main>
  )
}
