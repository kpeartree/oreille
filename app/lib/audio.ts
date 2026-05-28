// Audio capture + decode utilities.
// All processing is client-side. The PCM Float32Array returned by these
// helpers feeds directly into the TF.js inference pipeline.

export const TARGET_SAMPLE_RATE = 48_000
export const MAX_RECORD_SECONDS = 60

export async function recordFromMic(seconds: number, onTick?: (s: number) => void): Promise<Float32Array> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Micro non disponible sur cet appareil')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  })
  const mime = pickRecorderMime()
  const rec = new MediaRecorder(stream, { mimeType: mime })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)

  const stopped = new Promise<void>((res) => (rec.onstop = () => res()))
  rec.start()

  let remaining = Math.min(seconds, MAX_RECORD_SECONDS)
  onTick?.(remaining)
  const tick = setInterval(() => {
    remaining -= 1
    onTick?.(remaining)
    if (remaining <= 0) rec.state === 'recording' && rec.stop()
  }, 1000)

  await stopped
  clearInterval(tick)
  stream.getTracks().forEach((t) => t.stop())

  const blob = new Blob(chunks, { type: mime })
  return decodeToMono(await blob.arrayBuffer())
}

export async function decodeFile(file: File): Promise<Float32Array> {
  return decodeToMono(await file.arrayBuffer())
}

async function decodeToMono(buf: ArrayBuffer): Promise<Float32Array> {
  // OfflineAudioContext resamples to TARGET_SAMPLE_RATE in one pass.
  const tmp = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  const decoded = await tmp.decodeAudioData(buf.slice(0))
  tmp.close()

  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']
  for (const c of candidates) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  return ''
}
