// Audio capture + decode. All client-side. Returns the original Blob so
// callers can decode it at the multiple sample rates required by the two
// models (22050 for BirdNET, 16000 for YAMNet).

export const MAX_RECORD_SECONDS = 60

export type Capture = {
  blob: Blob
  durationSec: number
}

export async function recordFromMic(seconds: number, onTick?: (s: number) => void): Promise<Capture> {
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
    if (remaining <= 0 && rec.state === 'recording') rec.stop()
  }, 1000)

  await stopped
  clearInterval(tick)
  stream.getTracks().forEach((t) => t.stop())

  const blob = new Blob(chunks, { type: mime })
  return { blob, durationSec: Math.min(seconds, MAX_RECORD_SECONDS) - remaining }
}

export async function fromFile(file: File): Promise<Capture> {
  // We don't know duration yet; decode once at 16k just to measure.
  const pcm = await decodeAt(file, 16000)
  return { blob: file, durationSec: pcm.length / 16000 }
}

export async function decodeAt(source: Blob | File, sampleRate: number): Promise<Float32Array> {
  const buf = await source.arrayBuffer()
  // First decode at native rate (we don't pre-know it), then resample with OfflineAudioContext.
  const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
  const tmp = new Ctor()
  const decoded = await tmp.decodeAudioData(buf.slice(0))
  tmp.close()

  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * sampleRate), sampleRate)
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
