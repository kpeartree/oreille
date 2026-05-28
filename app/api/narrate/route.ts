import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

type Prediction = { label: string; score: number; source: 'birdnet' | 'yamnet' }
type Geo = { lat: number; lon: number; accuracy: number } | null

type Body = {
  predictions: Prediction[]
  geo: Geo
  month: number
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: Request) {
  const body = (await req.json()) as Body
  const { predictions, geo, month } = body

  const regional = geo ? await regionalContext(geo, month) : null

  const system = `Tu es un naturaliste poétique francophone. À partir de prédictions audio (BirdNET pour les oiseaux, YAMNet pour l'ambiance/insectes) et d'un contexte régional issu de GBIF/iNaturalist, tu rédiges un paragraphe court (3-5 phrases) qui aide la personne à VOIR son environnement à travers ce qu'elle entend.

Règles:
- Reste sobre, précis, jamais sentimental.
- N'invente pas d'espèces absentes des données — uniquement croiser les prédictions avec la plausibilité régionale.
- Si la confiance est faible, dis-le clairement ("probablement", "il se peut que").
- Pas d'emoji.

Réponds en JSON strict:
{
  "paragraph": "...",
  "highlights": [{ "label": "nom commun", "note": "1 phrase de contexte naturaliste" }]
}
`

  const userPayload = {
    predictions: predictions.slice(0, 8),
    geo,
    month,
    regional_species_present_nearby: regional,
  }

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
  })

  const text = msg.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('')

  const parsed = safeJson(text) ?? {
    paragraph:
      'Je peine à interpréter clairement cet environnement sonore. Réessaie dans un endroit un peu plus calme, ou rapproche le micro de la source.',
    highlights: [],
  }
  return NextResponse.json(parsed)
}

function safeJson(s: string): { paragraph: string; highlights: { label: string; note: string }[] } | null {
  const m = s.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

// Pulls a small list of birds & insects recently observed within ~50km of the
// user from iNaturalist (which itself is largely fed by GBIF). Free, no key.
async function regionalContext(geo: NonNullable<Geo>, month: number): Promise<string[] | null> {
  try {
    const url = new URL('https://api.inaturalist.org/v1/observations')
    url.searchParams.set('lat', String(geo.lat))
    url.searchParams.set('lng', String(geo.lon))
    url.searchParams.set('radius', '50') // km
    url.searchParams.set('month', String(month))
    url.searchParams.set('iconic_taxa', 'Aves,Insecta,Amphibia')
    url.searchParams.set('quality_grade', 'research')
    url.searchParams.set('per_page', '40')
    url.searchParams.set('order_by', 'observed_on')
    const res = await fetch(url, { next: { revalidate: 3600 } })
    if (!res.ok) return null
    const data = (await res.json()) as { results: { taxon?: { preferred_common_name?: string; name: string } }[] }
    const names = new Set<string>()
    for (const r of data.results) {
      const n = r.taxon?.preferred_common_name || r.taxon?.name
      if (n) names.add(n)
    }
    return Array.from(names).slice(0, 30)
  } catch {
    return null
  }
}
