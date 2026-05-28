// Orchestrates two classic Web Workers (BirdNET + YAMNet) served from /public/workers.
// Both models are loaded lazily on first identify() call and kept alive for subsequent runs.

import type { Capture } from './audio'
import { decodeAt } from './audio'
import type { Geo } from './geolocate'

export type Prediction = { label: string; scientific?: string; score: number; source: 'birdnet' | 'yamnet' }

type AnyMsg = Record<string, unknown> & { message: string }

type WorkerHandle = {
  worker: Worker
  loaded: Promise<void>
  request: <T extends AnyMsg>(msg: AnyMsg) => Promise<T>
}

let birdnet: WorkerHandle | null = null
let yamnet: WorkerHandle | null = null

function spawn(path: string, onProgress?: (stage: string, p: number) => void): WorkerHandle {
  const worker = new Worker(path)
  const pending = new Map<string, ((m: AnyMsg) => void)[]>()
  worker.addEventListener('message', (e) => {
    const data = e.data as AnyMsg
    if (data.message === 'load' && onProgress) onProgress(String(data.stage ?? ''), Number(data.progress ?? 0))
    if (data.message === 'error') console.error('[worker]', data.error)
    const waiters = pending.get(data.message)
    if (waiters && waiters.length) {
      const w = waiters.shift()!
      w(data)
    }
  })
  const loaded = new Promise<void>((resolve) => {
    const onLoad = (e: MessageEvent) => {
      const d = e.data as AnyMsg
      if (d.message === 'load' && d.stage === 'done') {
        worker.removeEventListener('message', onLoad)
        resolve()
      }
    }
    worker.addEventListener('message', onLoad)
  })
  const request = <T extends AnyMsg>(msg: AnyMsg): Promise<T> => {
    return new Promise<T>((resolve) => {
      const arr = pending.get(msg.message) ?? []
      arr.push((m) => resolve(m as T))
      pending.set(msg.message, arr)
      worker.postMessage(msg)
    })
  }
  return { worker, loaded, request }
}

export type LoadStatus = { birdnet?: { stage: string; progress: number }; yamnet?: { stage: string; progress: number } }

export function ensureWorkers(onStatus?: (s: LoadStatus) => void): Promise<void> {
  if (!birdnet) birdnet = spawn('/workers/birdnet.js', (stage, progress) => onStatus?.({ birdnet: { stage, progress } }))
  if (!yamnet) yamnet = spawn('/workers/yamnet.js', (stage, progress) => onStatus?.({ yamnet: { stage, progress } }))
  return Promise.all([birdnet.loaded, yamnet.loaded]).then(() => undefined)
}

export async function identify(capture: Capture, geo: Geo, onStatus?: (s: LoadStatus) => void): Promise<Prediction[]> {
  await ensureWorkers(onStatus)
  if (!birdnet || !yamnet) throw new Error('workers not ready')

  // Decode at both rates in parallel.
  const [pcm22050, pcm16000] = await Promise.all([decodeAt(capture.blob, 22050), decodeAt(capture.blob, 16000)])

  // If we have geolocation, prime BirdNET's area model so its predictions get
  // a regional plausibility score (~30% recall boost in practice).
  if (geo) {
    await birdnet.request({ message: 'area-scores', latitude: geo.lat, longitude: geo.lon })
  }

  // BirdNET expects exactly 3-second chunks (65920 samples @ 22050). Average
  // top-K predictions across the whole clip so a 60s recording is summarized
  // by its dominant species rather than per-window noise.
  const CHUNK = 65920
  const birdAccum = new Map<string, { scientific: string; total: number; n: number }>()
  for (let off = 0; off + CHUNK <= pcm22050.length; off += CHUNK) {
    const chunk = pcm22050.subarray(off, off + CHUNK)
    const padded = chunk.length === CHUNK ? chunk : padTo(chunk, CHUNK)
    const res = await birdnet.request<AnyMsg & { prediction: { name: string; scientific: string; confidence: number; geoscore: number }[] }>({
      message: 'predict',
      pcm22050: padded,
    })
    for (const p of res.prediction.slice(0, 5)) {
      const k = p.name
      const cur = birdAccum.get(k) ?? { scientific: p.scientific, total: 0, n: 0 }
      cur.total += p.confidence * (geo ? Math.max(0.2, p.geoscore) : 1)
      cur.n += 1
      birdAccum.set(k, cur)
    }
  }
  const birds: Prediction[] = Array.from(birdAccum.entries())
    .map(([label, v]) => ({ label, scientific: v.scientific, score: v.total / v.n, source: 'birdnet' as const }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)

  const yam = await yamnet.request<AnyMsg & { prediction: { label: string; confidence: number }[] }>({
    message: 'predict',
    pcm16k: pcm16000,
  })
  const ambient: Prediction[] = yam.prediction
    .filter((p) => !isJunkLabel(p.label))
    .slice(0, 8)
    .map((p) => ({ label: p.label, score: p.confidence, source: 'yamnet' as const }))

  return [...birds, ...ambient].sort((a, b) => b.score - a.score)
}

function padTo(a: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n)
  out.set(a)
  return out
}

// YAMNet has many AudioSet classes that aren't "nature" (speech, vehicles,
// music, white noise…). Filter them out so the narration focuses on living
// things and the environment, not on the human handling the phone.
const JUNK = new Set([
  'Speech', 'Child speech, kid speaking', 'Conversation', 'Narration, monologue',
  'Babbling', 'Whispering', 'Laughter', 'Baby laughter', 'Giggle', 'Snicker',
  'Belly laugh', 'Chuckle, chortle', 'Crying, sobbing', 'Baby cry, infant cry',
  'Whimper', 'Wail, moan', 'Sigh', 'Singing', 'Choir', 'Yodeling', 'Chant',
  'Mantra', 'Male singing', 'Female singing', 'Child singing', 'Synthetic singing',
  'Rapping', 'Humming', 'Groan', 'Grunt', 'Whistling', 'Breathing', 'Wheeze',
  'Snoring', 'Gasp', 'Pant', 'Snort', 'Cough', 'Throat clearing', 'Sneeze',
  'Sniff', 'Music', 'Musical instrument', 'Plucked string instrument',
  'Guitar', 'Electric guitar', 'Bass guitar', 'Acoustic guitar', 'Steel guitar, slide guitar',
  'Tapping (guitar technique)', 'Strum', 'Banjo', 'Sitar', 'Mandolin', 'Zither',
  'Ukulele', 'Keyboard (musical)', 'Piano', 'Electric piano', 'Organ', 'Electronic organ',
  'Hammond organ', 'Synthesizer', 'Sampler', 'Harpsichord', 'Percussion',
  'Drum kit', 'Drum machine', 'Drum', 'Snare drum', 'Rimshot', 'Drum roll',
  'Bass drum', 'Timpani', 'Tabla', 'Cymbal', 'Hi-hat', 'Wood block', 'Tambourine',
  'Rattle (instrument)', 'Maraca', 'Gong', 'Tubular bells', 'Mallet percussion',
  'Marimba, xylophone', 'Glockenspiel', 'Vibraphone', 'Steelpan', 'Orchestra',
  'Brass instrument', 'French horn', 'Trumpet', 'Trombone', 'Bowed string instrument',
  'String section', 'Violin, fiddle', 'Pizzicato', 'Cello', 'Double bass',
  'Wind instrument, woodwind instrument', 'Flute', 'Saxophone', 'Clarinet',
  'Harp', 'Bell', 'Church bell', 'Jingle bell', 'Bicycle bell', 'Tuning fork',
  'Chime', 'Wind chime', 'Change ringing (campanology)', 'Harmonica', 'Accordion',
  'Bagpipes', 'Didgeridoo', 'Shofar', 'Theremin', 'Singing bowl', 'Scratching (performance technique)',
  'Pop music', 'Hip hop music', 'Beatboxing', 'Rock music', 'Heavy metal',
  'Punk rock', 'Grunge', 'Progressive rock', 'Rock and roll', 'Psychedelic rock',
  'Rhythm and blues', 'Soul music', 'Reggae', 'Country', 'Swing music', 'Bluegrass',
  'Funk', 'Folk music', 'Middle Eastern music', 'Jazz', 'Disco', 'Classical music',
  'Opera', 'Electronic music', 'House music', 'Techno', 'Dubstep', 'Drum and bass',
  'Electronica', 'Electronic dance music', 'Ambient music', 'Trance music',
  'Music of Latin America', 'Salsa music', 'Flamenco', 'Blues', 'Music for children',
  'New-age music', 'Vocal music', 'A capella', 'Music of Africa', 'Afrobeat',
  'Christian music', 'Gospel music', 'Music of Asia', 'Carnatic music',
  'Music of Bollywood', 'Ska', 'Traditional music', 'Independent music', 'Song',
  'Background music', 'Theme music', 'Jingle (music)', 'Soundtrack music', 'Lullaby',
  'Video game music', 'Christmas music', 'Dance music', 'Wedding music', 'Happy music',
  'Funny music', 'Sad music', 'Tender music', 'Exciting music', 'Angry music', 'Scary music',
  'Vehicle', 'Boat, Water vehicle', 'Sailboat, sailing ship', 'Rowboat, canoe, kayak',
  'Motorboat, speedboat', 'Ship', 'Motor vehicle (road)', 'Car', 'Vehicle horn, car horn, honking',
  'Toot', 'Car alarm', 'Power windows, electric windows', 'Skidding', 'Tire squeal',
  'Car passing by', 'Race car, auto racing', 'Truck', 'Air brake', 'Air horn, truck horn',
  'Reversing beeps', 'Ice cream truck, ice cream van', 'Bus', 'Emergency vehicle',
  'Police car (siren)', 'Ambulance (siren)', 'Fire engine, fire truck (siren)', 'Motorcycle',
  'Traffic noise, roadway noise', 'Rail transport', 'Train', 'Train whistle', 'Train horn',
  'Railroad car, train wagon', 'Train wheels squealing', 'Subway, metro, underground',
  'Aircraft', 'Aircraft engine', 'Jet engine', 'Propeller, airscrew', 'Helicopter',
  'Fixed-wing aircraft, airplane', 'Bicycle', 'Skateboard', 'Engine', 'Light engine (high frequency)',
  'Dental drill, dentist\'s drill', 'Lawn mower', 'Chainsaw', 'Medium engine (mid frequency)',
  'Heavy engine (low frequency)', 'Engine knocking', 'Engine starting', 'Idling',
  'Accelerating, revving, vroom', 'Door', 'Doorbell', 'Ding-dong', 'Sliding door', 'Slam',
  'Knock', 'Tap', 'Squeak', 'Cupboard open or close', 'Drawer open or close',
  'Dishes, pots, and pans', 'Cutlery, silverware', 'Chopping (food)', 'Frying (food)',
  'Microwave oven', 'Blender', 'Water tap, faucet', 'Sink (filling or washing)',
  'Bathtub (filling or washing)', 'Hair dryer', 'Toilet flush', 'Toothbrush', 'Electric toothbrush',
  'Vacuum cleaner', 'Zipper (clothing)', 'Keys jangling', 'Coin (dropping)', 'Scissors',
  'Electric shaver, electric razor', 'Shuffling cards', 'Typing', 'Typewriter', 'Computer keyboard',
  'Writing', 'Alarm', 'Telephone', 'Telephone bell ringing', 'Ringtone',
  'Telephone dialing, DTMF', 'Dial tone', 'Busy signal', 'Alarm clock', 'Siren',
  'Civil defense siren', 'Buzzer', 'Smoke detector, smoke alarm', 'Fire alarm', 'Foghorn',
  'Whistle', 'Steam whistle', 'Mechanisms', 'Ratchet, pawl', 'Clock', 'Tick', 'Tick-tock',
  'Gears', 'Pulleys', 'Sewing machine', 'Mechanical fan', 'Air conditioning', 'Cash register',
  'Printer', 'Camera', 'Single-lens reflex camera', 'Tools', 'Hammer', 'Jackhammer', 'Sawing',
  'Filing (rasp)', 'Sanding', 'Power tool', 'Drill', 'Explosion', 'Gunshot, gunfire',
  'Machine gun', 'Fusillade', 'Artillery fire', 'Cap gun', 'Fireworks', 'Firecracker',
  'Burst, pop', 'Eruption', 'Boom', 'Wood', 'Chop', 'Splinter', 'Crack',
  'Glass', 'Chink, clink', 'Shatter', 'Liquid', 'Splash, splatter', 'Slosh', 'Squish',
  'Drip', 'Pour', 'Trickle, dribble', 'Fill (with liquid)', 'Spray', 'Pump (liquid)',
  'Stir', 'Boiling', 'Sonar', 'Arrow', 'Whoosh, swoosh, swish', 'Thump, thud', 'Thunk', 'Electronic tuner',
  'Effects unit', 'Chorus effect', 'Basketball bounce', 'Bang', 'Smash, crash', 'Breaking',
  'Bouncing', 'Whip', 'Flap', 'Scratch', 'Scrape', 'Rub', 'Roll', 'Crushing', 'Crumpling, crinkling',
  'Tearing', 'Beep, bleep', 'Ping', 'Ding', 'Clang', 'Squeal', 'Creak', 'Rustle', 'Whir',
  'Clatter', 'Sizzle', 'Clicking', 'Clickety-clack', 'Rumble', 'Plop', 'Jingle, tinkle',
  'Hum', 'Zing', 'Boing', 'Crunch', 'Silence', 'Sine wave', 'Harmonic', 'Chirp tone',
  'Sound effect', 'Pulse', 'Inside, small room', 'Inside, large room or hall', 'Inside, public space',
  'Outside, urban or manmade', 'Outside, rural or natural', 'Reverberation', 'Echo', 'Noise',
  'Environmental noise', 'Static', 'Mains hum', 'Distortion', 'Sidetone', 'Cacophony',
  'White noise', 'Pink noise', 'Throbbing', 'Vibration', 'Television', 'Radio', 'Field recording',
])
function isJunkLabel(l: string): boolean { return JUNK.has(l) }
