// STT smoke test: stream a PCM file (16kHz s16le mono) as the browser would,
// then send audio_end and expect an input transcript and a spoken reply.
import { readFileSync } from 'node:fs'

const url = process.argv[2] || 'ws://127.0.0.1:19387/api/voice-agent/ws'
const pcmPath = process.argv[3]
if (!pcmPath) { console.error('usage: node smoke-stt.mjs [ws url] <pcm file>'); process.exit(2) }
const pcm = readFileSync(pcmPath)

const ws = new WebSocket(url)
const started = Date.now()
const log = (msg) => console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`)
let gotInputTranscript = false
let audioChunks = 0

const timer = setTimeout(() => {
  log(`TIMEOUT. inputTranscript=${gotInputTranscript} audioChunks=${audioChunks}`)
  process.exit(gotInputTranscript ? 0 : 1)
}, 60000)

ws.binaryType = 'nodebuffer'
ws.onopen = () => log('ws open, waiting ready')

ws.onmessage = (event) => {
  if (typeof event.data !== 'string') { audioChunks += 1; return }
  let msg
  try { msg = JSON.parse(event.data) } catch { return }
  if (msg.type === 'audio') { audioChunks += 1; return }
  if (msg.type === 'ready') {
    log('ready, streaming audio')
    const CHUNK = 6400 // 200ms at 16kHz s16le
    let off = 0
    const pump = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) { clearInterval(pump); return }
      const slice = pcm.subarray(off, off + CHUNK)
      if (slice.length === 0) {
        clearInterval(pump)
        ws.send(JSON.stringify({ type: 'audio_end' }))
        log('audio_end sent')
        return
      }
      ws.send(slice)
      off += CHUNK
    }, 100)
    return
  }
  if (msg.type === 'input_transcript') {
    gotInputTranscript = true
    log(`INPUT TRANSCRIPT: ${msg.text}`)
    return
  }
  if (msg.type === 'output_transcript') { log(`reply transcript: ${String(msg.text).slice(0, 120)}`); return }
  log(`msg ${msg.type}: ${JSON.stringify(msg).slice(0, 200)}`)
  if (msg.type === 'error') { clearTimeout(timer); process.exit(1) }
  if (msg.type === 'turn_complete') {
    log(`DONE. inputTranscript=${gotInputTranscript} audioChunks=${audioChunks}`)
    clearTimeout(timer)
    process.exit(gotInputTranscript ? 0 : 1)
  }
}

ws.onerror = (err) => log(`ws error: ${err.message || err}`)
ws.onclose = (ev) => { log(`ws closed code=${ev.code} reason=${ev.reason}`); clearTimeout(timer); process.exit(gotInputTranscript ? 0 : 1) }
