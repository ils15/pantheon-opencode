/**
 * Frontend Metrics Dashboard Component by @aphrodite.
 * WCAG AA accessible, responsive grid, zero deprecated npm libraries.
 */

import { useEffect, useState } from 'react'

export function MetricsDashboard() {
  const [metrics, setMetrics] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch('/api/metrics')
      .then((res) => {
        if (!res.ok) throw new Error('Falha ao carregar métricas')
        return res.json()
      })
      .then((data) => {
        setMetrics(data.data || [])
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  const handleExportCsv = async () => {
    try {
      setExporting(true)
      const res = await fetch('/api/metrics/export')
      if (!res.ok) throw new Error('Erro ao exportar CSV')
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'metrics-report.csv'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      alert(`Falha no download: ${err.message}`)
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return (
      <div role="status" className="p-8 text-center text-slate-500 animate-pulse">
        Carregando painel de métricas...
      </div>
    )
  }

  if (error) {
    return (
      <div role="alert" className="p-4 bg-red-50 text-red-700 rounded-lg border border-red-200">
        <h3 className="font-semibold">Erro ao carregar dados</h3>
        <p>{error}</p>
      </div>
    )
  }

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6 font-sans">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            SaaS Performance Dashboard
          </h1>
          <p className="text-sm text-slate-500">Métricas operacionais consolidadas em tempo real</p>
        </div>
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={exporting}
          className="inline-flex items-center px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-md shadow-sm transition-colors focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          aria-label="Exportar relatório consolidado em formato CSV"
        >
          {exporting ? 'Exportando...' : 'Exportar CSV'}
        </button>
      </header>

      {/* Grid de Cards de Alto Impacto */}
      <section
        aria-label="Resumo de Métricas Principais"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        {metrics.map((m) => (
          <article
            key={m.id}
            className="p-5 bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow"
          >
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              {m.category}
            </span>
            <h2 className="text-sm font-medium text-slate-700 mt-1">{m.name}</h2>
            <div className="flex items-baseline gap-2 mt-3">
              <span className="text-2xl font-bold text-slate-900">
                {m.unit === 'USD'
                  ? `$${m.value.toLocaleString()}`
                  : `${m.value.toLocaleString()}${m.unit === 'percent' ? '%' : ''}`}
              </span>
              <span
                className={`text-xs font-semibold ${m.changePercent >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}
              >
                {m.changePercent >= 0 ? `+${m.changePercent}%` : `${m.changePercent}%`}
              </span>
            </div>
          </article>
        ))}
      </section>
    </main>
  )
}
