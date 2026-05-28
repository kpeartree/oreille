'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_RECORD_SECONDS, fromFile, recordFromMic, type Capture } from './lib/audio'
import { ensureWorkers, identify, type LoadStatus, type Prediction } from './lib/inference'
import { getGeolocation } from './lib/geolocate'

type Phase = 'idle' | 'loading-models' | 'recording' | 'thinking' | 'result' | 'error'

type Narration = {
  paragraph: string
  highlights: { label: string; note: string }[]
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [remaining, setRemaining] = useState(MAX_RECORD_SECONDS)
  const [preds, setPreds] = useState<Prediction[]>([])
  const [narration, setNarration] = useState<Narration | null>(null)
  const [errMsg, setErrMsg] = useState('')
  const [modelStatus, setModelStatus] = useState<LoadStatus>({})
  const fileRef = useRef<HTMLInputElement>(null)

  // Kick off the (large) model downloads lazily on first user interaction
  // rather than on page load, so the landing screen stays snappy.
  const ensureModelsReady = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'error') return
    setPhase('loading-models')
    await ensureWorkers(setModelStatus)
  }, [phase])

  const runPipeline = useCallback(async (capture: Capture) => {
    setPhase('thinking')
    const geo = await getGeolocation()
    const predictions = await identify(capture, geo, setModelStatus)
    setPreds(predictions)

    const res = await fetch('/api/narrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ predictions, geo, month: new Date().getMonth() + 1 }),
    })
    if (!res.ok) {
      setErrMsg('La narration a échoué. Réessaie dans un instant.')
      setPhase('error')
      return
    }
    setNarration(await res.json())
    setPhase('result')
  }, [])

  const onPrimaryButton = useCallback(async () => {
    if (phase === 'recording' || phase === 'thinking' || phase === 'loading-models') return
    if (phase === 'result') {
      setPhase('idle')
      setNarration(null)
      setPreds([])
      return
    }
    try {
      setErrMsg('')
      await ensureModelsReady()
      setPhase('recording')
      const capture = await recordFromMic(MAX_RECORD_SECONDS, setRemaining)
      await runPipeline(capture)
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Erreur inconnue')
      setPhase('error')
    }
  }, [phase, runPipeline, ensureModelsReady])

  const onFile = useCallback(async (file: File) => {
    try {
      setErrMsg('')
      await ensureModelsReady()
      setPhase('thinking')
      const capture = await fromFile(file)
      await runPipeline(capture)
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Fichier audio illisible')
      setPhase('error')
    }
  }, [runPipeline, ensureModelsReady])

  return (
    <main className="min-h-screen flex flex-col items-center justify-between px-6 py-10">
      <header className="w-full max-w-md flex items-center justify-between">
        <div className="flex items-center gap-2">
          <LeafGlyph />
          <span className="font-medium tracking-wide text-moss-800" style={{ fontFamily: 'var(--font-serif)' }}>
            oreille
          </span>
        </div>
        <span className="text-xs uppercase tracking-[0.18em] text-moss-600/70">écoute la nature</span>
      </header>

      <section className="flex flex-col items-center text-center max-w-md w-full">
        {phase === 'idle' && (
          <h1
            className="text-3xl sm:text-4xl leading-tight text-moss-800 mb-10"
            style={{ fontFamily: 'var(--font-serif)', fontWeight: 400 }}
          >
            Reste immobile.<br />
            <span className="text-moss-600 italic">Laisse la forêt parler.</span>
          </h1>
        )}

        {phase === 'loading-models' && <LoadingModels status={modelStatus} />}

        {phase === 'recording' && (
          <h1 className="text-2xl text-moss-800 mb-10" style={{ fontFamily: 'var(--font-serif)' }}>
            J&apos;écoute…
          </h1>
        )}

        {phase === 'thinking' && (
          <h1 className="text-2xl text-moss-800 mb-10" style={{ fontFamily: 'var(--font-serif)' }}>
            Je consulte les naturalistes du monde…
          </h1>
        )}

        {phase === 'result' && narration && (
          <article className="text-left w-full">
            <p
              className="text-xl leading-relaxed text-moss-900 mb-8"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              {narration.paragraph}
            </p>
            <ul className="space-y-3 mb-8">
              {narration.highlights.map((h) => (
                <li key={h.label} className="border-l-2 border-moss-300 pl-4">
                  <div className="text-moss-800 font-medium">{h.label}</div>
                  <div className="text-sm text-stone leading-snug">{h.note}</div>
                </li>
              ))}
            </ul>
            {preds.length > 0 && (
              <details className="text-xs text-stone/80">
                <summary className="cursor-pointer">détails techniques</summary>
                <ul className="mt-2 space-y-1">
                  {preds.map((p) => (
                    <li key={p.label + p.source}>
                      {p.label}
                      {p.scientific && <span className="opacity-50 italic"> · {p.scientific}</span>}
                      {' '}— {(p.score * 100).toFixed(0)}% <span className="opacity-50">({p.source})</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        )}

        {phase === 'error' && (
          <p className="text-bark-600 text-base mb-10">{errMsg}</p>
        )}

        {(phase === 'idle' || phase === 'recording' || phase === 'error') && (
          <PrimaryButton phase={phase} remaining={remaining} onClick={onPrimaryButton} />
        )}

        {phase === 'result' && (
          <button
            onClick={() => setPhase('idle')}
            className="mt-6 text-moss-700 underline underline-offset-4 decoration-moss-300"
          >
            écouter à nouveau
          </button>
        )}
      </section>

      <footer className="w-full max-w-md flex flex-col items-center gap-3 text-stone/80 text-sm">
        {(phase === 'idle' || phase === 'error') && (
          <>
            <button
              onClick={() => fileRef.current?.click()}
              className="underline underline-offset-4 decoration-moss-300 hover:text-moss-700 transition"
            >
              ou importer un enregistrement
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.m4a,.wav,.mp3,.aac,.ogg,.opus,.flac"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onFile(f)
              }}
            />
          </>
        )}
        <p className="text-[10px] uppercase tracking-[0.2em] opacity-60">
          BirdNET · YAMNet · GBIF · iNaturalist
        </p>
      </footer>
    </main>
  )
}

function PrimaryButton({
  phase,
  remaining,
  onClick,
}: {
  phase: Phase
  remaining: number
  onClick: () => void
}) {
  const isRecording = phase === 'recording'
  return (
    <div className="relative">
      {!isRecording && (
        <span aria-hidden className="absolute inset-0 rounded-full bg-moss-300 breathe" />
      )}
      <button
        onClick={onClick}
        aria-label={isRecording ? `Arrêter (${remaining}s)` : 'Tell me what is around'}
        className={[
          'relative rounded-full flex flex-col items-center justify-center select-none',
          'transition-transform active:scale-95',
          'w-60 h-60 sm:w-72 sm:h-72',
          isRecording
            ? 'bg-bark-600 text-mist record-pulse'
            : 'bg-moss-600 text-mist shadow-[0_12px_40px_rgba(56,80,46,0.35)]',
        ].join(' ')}
      >
        {isRecording ? (
          <>
            <span className="text-5xl font-light tabular-nums" style={{ fontFamily: 'var(--font-serif)' }}>
              {remaining}
            </span>
            <span className="text-[11px] uppercase tracking-[0.2em] mt-2 opacity-80">touche pour arrêter</span>
          </>
        ) : (
          <>
            <span className="text-xl leading-tight px-6 text-center" style={{ fontFamily: 'var(--font-serif)' }}>
              Tell me what is around
            </span>
            <span className="text-[11px] uppercase tracking-[0.2em] mt-3 opacity-80">60 sec max</span>
          </>
        )}
      </button>
    </div>
  )
}

function LoadingModels({ status }: { status: LoadStatus }) {
  // Combined progress weighted equally between the two models. Cached after
  // first load, so this screen is only seen once per device.
  const b = status.birdnet?.progress ?? 0
  const y = status.yamnet?.progress ?? 0
  const combined = Math.round((b + y) / 2)
  return (
    <div className="w-full max-w-xs flex flex-col items-center mb-10">
      <p className="text-moss-800 mb-4" style={{ fontFamily: 'var(--font-serif)' }}>
        Je télécharge les naturalistes… <span className="opacity-60">({combined}%)</span>
      </p>
      <div className="w-full h-1 bg-moss-100 rounded-full overflow-hidden">
        <div className="h-full bg-moss-500 transition-all" style={{ width: `${combined}%` }} />
      </div>
      <p className="text-xs text-stone/70 mt-4 leading-relaxed text-center">
        Première visite seulement. Ensuite tout est instantané et hors-ligne.
      </p>
    </div>
  )
}

function LeafGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" className="leaf-drift text-moss-600" fill="none">
      <path
        d="M4 20C4 11 11 4 20 4C20 13 13 20 4 20Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M4 20L14 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
