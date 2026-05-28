/* YAMNet in-browser inference worker.
 * Google AudioSet model, 521 classes (cricket, cicada, bee, frog, rain, wind, …).
 * Input: 0.96s mono @ 16kHz = 15360 Float32 samples.
 *
 * Messages in:  { message: 'load' } | { message: 'predict', pcm16k }
 * Messages out:
 *   { message: 'load', stage, progress }
 *   { message: 'predict', prediction: [{ label, confidence }, ...] }
 */

importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js')

const WIN = 15360
let model = null
let labels = null

main().catch((e) => postMessage({ message: 'error', error: e.message || String(e) }))

async function main() {
  await tf.setBackend('webgl')

  postMessage({ message: 'load', stage: 'model', progress: 0 })
  model = await tf.loadGraphModel('/models/yamnet/model.json', {
    onProgress: (p) => postMessage({ message: 'load', stage: 'model', progress: (p * 85) | 0 }),
  })

  postMessage({ message: 'load', stage: 'labels', progress: 88 })
  labels = await fetch('/models/yamnet/labels.json').then((r) => r.json())

  postMessage({ message: 'load', stage: 'warmup', progress: 92 })
  const warm = model.predict(tf.zeros([WIN]))
  await warm.data()
  warm.dispose()

  postMessage({ message: 'load', stage: 'done', progress: 100 })

  onmessage = async ({ data }) => {
    try {
      if (data.message === 'predict') {
        const out = await averagePredictions(data.pcm16k)
        postMessage({ message: 'predict', prediction: out })
      }
    } catch (e) {
      postMessage({ message: 'error', error: e.message || String(e) })
    }
  }
}

// YAMNet's natural window is 0.96s. For a longer clip we average scores
// across hops so a 60s recording produces one stable distribution.
async function averagePredictions(pcm) {
  const hop = WIN // non-overlapping hops; sufficient for ambient/insect ID
  const acc = new Float32Array(521)
  let n = 0
  for (let off = 0; off + WIN <= pcm.length; off += hop) {
    const slice = pcm.subarray(off, off + WIN)
    const t = tf.tensor1d(slice)
    const res = model.predict(t)
    const arr = await res.data()
    res.dispose()
    t.dispose()
    for (let i = 0; i < 521; i++) acc[i] += arr[i]
    n++
  }
  if (n === 0) {
    // Clip shorter than 0.96s: pad and predict once.
    const buf = new Float32Array(WIN)
    buf.set(pcm.subarray(0, Math.min(pcm.length, WIN)))
    const t = tf.tensor1d(buf)
    const res = model.predict(t)
    const arr = await res.data()
    res.dispose()
    t.dispose()
    for (let i = 0; i < 521; i++) acc[i] = arr[i]
    n = 1
  }
  const out = []
  for (let i = 0; i < 521; i++) {
    const score = acc[i] / n
    if (score > 0.05) out.push({ label: labels[i], confidence: score })
  }
  out.sort((a, b) => b.confidence - a.confidence)
  return out.slice(0, 12)
}
