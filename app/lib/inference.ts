// Thin facade over the two TF.js models. Real loading happens lazily on
// first use so the home screen stays light. Until the models are dropped
// into /public/models/, the facade returns a deterministic placeholder so
// the rest of the pipeline (narration, UI) can be built and tested.

export type Prediction = { label: string; score: number; source: 'birdnet' | 'yamnet' }

let loaded = false

async function ensureLoaded() {
  if (loaded) return
  // TODO: dynamic-import @tensorflow/tfjs, fetch model.json from /models/yamnet
  // and /models/birdnet, warm them with a dummy tensor. Keeping this stub until
  // the model bundles are committed to /public/models/.
  loaded = true
}

export async function identify(audio: Float32Array, _sampleRate: number): Promise<Prediction[]> {
  await ensureLoaded()

  // Stub: derive a cheap "energy fingerprint" so the placeholder output
  // varies with input. Replaced by real YAMNet+BirdNET inference next.
  const rms = Math.sqrt(audio.reduce((s, v) => s + v * v, 0) / audio.length)
  const bias = Math.min(1, rms * 6)

  const stub: Prediction[] = [
    { label: 'Bird vocalization',  score: 0.62 + 0.2 * bias, source: 'yamnet' },
    { label: 'Insect (cricket)',   score: 0.48 + 0.2 * bias, source: 'yamnet' },
    { label: 'Wind in trees',      score: 0.41,              source: 'yamnet' },
    { label: 'Stream / running water', score: 0.18,          source: 'yamnet' },
  ]
  return stub.sort((a, b) => b.score - a.score)
}
