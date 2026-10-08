/**
 * Call audio: microphone capture as 16 kHz mono PCM16 frames, a speech gate
 * that withholds silent frames, and gapless playback of the model's 24 kHz
 * PCM16 stream with an immediate flush when the user interrupts.
 */

/** Sample rate Gemini Live expects for input audio. */
const INPUT_RATE = 16_000
/** Sample rate of Gemini Live output audio. */
const OUTPUT_RATE = 24_000

/** Frames (32 ms each) replayed before detected speech so its onset is not clipped. */
const PREROLL_FRAMES = 10
/**
 * Silent frames still sent after speech (~1.5 s). Longer than Gemini's
 * end-of-speech silence window (800 ms in the setup message), so Gemini sees
 * the pause that ends the user's turn before the stream stops.
 */
const HANGOVER_FRAMES = 47
/** RMS level below which a frame never counts as speech. */
const MIN_SPEECH_RMS = 0.012

/**
 * Sends microphone frames only around speech. Gemini Live bills input audio by
 * duration, so a call left open while the agent works would otherwise pay for
 * minutes of silence. Speech is a frame louder than both {@link MIN_SPEECH_RMS}
 * and three times the tracked noise floor; in a constantly loud room every
 * frame passes and the gate degrades to continuous streaming.
 */
export class SpeechGate {
  private noiseFloor = 0.004
  private hangover = 0
  private streaming = false
  private readonly preroll: ArrayBuffer[] = []

  /**
   * @param send - forwards one frame to Gemini.
   * @param pause - signals that streaming stopped after speech (audio stream end).
   */
  constructor(
    private readonly send: (frame: ArrayBuffer) => void,
    private readonly pause: () => void,
  ) {}

  /**
   * Route one captured frame.
   * @param frame - mono PCM16 at 16 kHz.
   */
  push(frame: ArrayBuffer): void {
    const level = rms(frame)
    const speech = level > Math.max(MIN_SPEECH_RMS, this.noiseFloor * 3)
    if (!speech) this.noiseFloor = this.noiseFloor * 0.98 + level * 0.02
    if (speech) {
      if (!this.streaming) {
        this.streaming = true
        for (const buffered of this.preroll.splice(0)) this.send(buffered)
      }
      this.hangover = HANGOVER_FRAMES
      this.send(frame)
      return
    }
    if (this.streaming) {
      this.send(frame)
      this.hangover -= 1
      if (this.hangover <= 0) {
        this.streaming = false
        this.pause()
      }
      return
    }
    this.preroll.push(frame)
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift()
  }
}

/**
 * Root-mean-square level of a PCM16 frame.
 * @param frame - mono PCM16 samples.
 * @returns the level in [0, 1].
 */
function rms(frame: ArrayBuffer): number {
  const samples = new Int16Array(frame)
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += (sample / 0x8000) ** 2
  return Math.sqrt(sum / samples.length)
}

/**
 * AudioWorklet that downsamples the capture stream to 16 kHz PCM16 and posts
 * ~32 ms frames to the main thread. Loaded from a Blob URL, so it carries no
 * imports.
 */
const CAPTURE_WORKLET = `
class VoiceAgentCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.ratio = options.processorOptions.inputRate / ${String(INPUT_RATE)}
    this.pending = []
    this.frame = 512
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) this.pending.push(channel[i])
    const need = Math.ceil(this.frame * this.ratio)
    while (this.pending.length >= need) {
      const chunk = this.pending.splice(0, need)
      const out = new Int16Array(this.frame)
      for (let i = 0; i < this.frame; i++) {
        const start = Math.floor(i * this.ratio)
        const end = Math.min(chunk.length, Math.floor((i + 1) * this.ratio))
        let sum = 0
        for (let j = start; j < end; j++) sum += chunk[j]
        const v = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : 0))
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
      }
      this.port.postMessage(out.buffer, [out.buffer])
    }
    return true
  }
}
registerProcessor('voice-agent-capture', VoiceAgentCapture)
`

/** Live microphone capture; stop() releases the device. */
export interface MicCapture {
  /** Suspend sending frames without releasing the device. */
  setMuted(muted: boolean): void
  /** Current input level in [0, 1] for the activity meter. */
  level(): number
  stop(): void
}

/**
 * Open the microphone and stream PCM16 16 kHz frames.
 * @param onFrame - receives each ~32 ms frame.
 * @returns the running capture.
 * @throws when microphone permission is denied or no device exists.
 */
export async function startMic(onFrame: (frame: ArrayBuffer) => void): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const context = new AudioContext()
  const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }))
  try {
    await context.audioWorklet.addModule(workletUrl)
  } finally {
    URL.revokeObjectURL(workletUrl)
  }
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 256
  const node = new AudioWorkletNode(context, 'voice-agent-capture', {
    processorOptions: { inputRate: context.sampleRate },
  })
  let muted = false
  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (!muted) onFrame(event.data)
  }
  source.connect(analyser)
  source.connect(node)
  const samples = new Uint8Array(analyser.fftSize)
  return {
    setMuted(next) { muted = next },
    level() {
      if (muted) return 0
      analyser.getByteTimeDomainData(samples)
      let peak = 0
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128))
      return Math.min(1, peak / 64)
    },
    stop() {
      node.port.onmessage = null
      source.disconnect()
      node.disconnect()
      for (const track of stream.getTracks()) track.stop()
      void context.close()
    },
  }
}

/** Gapless player for the model's PCM16 24 kHz stream. */
export class SpeechPlayer {
  private readonly context = new AudioContext({ sampleRate: OUTPUT_RATE })
  private readonly analyser: AnalyserNode
  private readonly samples: Uint8Array<ArrayBuffer>
  private playhead = 0
  private readonly sources = new Set<AudioBufferSourceNode>()

  constructor() {
    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.connect(this.context.destination)
    this.samples = new Uint8Array(this.analyser.fftSize)
  }

  /**
   * Queue one PCM16 chunk right after the previous one.
   * @param pcm - little-endian mono PCM16 at 24 kHz.
   */
  enqueue(pcm: ArrayBuffer): void {
    const ints = new Int16Array(pcm)
    if (ints.length === 0) return
    const buffer = this.context.createBuffer(1, ints.length, OUTPUT_RATE)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < ints.length; i++) channel[i] = (ints[i] ?? 0) / 0x8000
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser)
    const startAt = Math.max(this.context.currentTime + 0.02, this.playhead)
    source.start(startAt)
    this.playhead = startAt + buffer.duration
    this.sources.add(source)
    source.onended = () => { this.sources.delete(source) }
  }

  /** @returns whether queued speech is still playing. */
  get speaking(): boolean {
    return this.sources.size > 0
  }

  /** Stop all queued speech immediately (user barge-in). */
  flush(): void {
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // A source that already finished throws InvalidStateError; nothing is left to stop.
      }
    }
    this.sources.clear()
    this.playhead = 0
  }

  /** Current output level in [0, 1] for the activity meter. */
  level(): number {
    if (this.sources.size === 0) return 0
    this.analyser.getByteTimeDomainData(this.samples)
    let peak = 0
    for (const sample of this.samples) peak = Math.max(peak, Math.abs(sample - 128))
    return Math.min(1, peak / 64)
  }

  /** Resume after the browser's autoplay policy suspended the context. */
  async resume(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume()
  }

  close(): void {
    this.flush()
    void this.context.close()
  }
}
