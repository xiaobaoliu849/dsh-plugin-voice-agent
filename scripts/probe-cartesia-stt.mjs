// Direct Cartesia STT probe: uses the plugin's own fallback key loader to
// verify the /stt/websocket protocol and language behavior with a PCM sample.
// Usage: node probe-cartesia-stt.mjs <pcm file> [language]
import { readFileSync } from 'node:fs'
import { loadVoiceSpiritFallback } from '../plugin/src/fallback.ts'

const pcmPath = process.argv[2]
const language = process.argv[3] || 'zh'
if (!pcmPath) { console.error('usage: node probe-cartesia-stt.mjs <pcm> [language]'); process.exit(2) }
const pcm = readFileSync(pcmPath)

const key = loadVoiceSpiritFallback()?.cartesiaApiKey || process.env.CARTESIA_API_KEY
if (!key) { console.error('no cartesia key available'); process.exit(2) }

const params = new URLSearchParams({
  model: 'ink-whisper',
  encoding: 'pcm_s16le',
  sample_rate: '16000',
  cartesia_version: '2024-06-10',
})
if (language !== 'auto') params.set('language', language)
const url = `wss://api.cartesia.ai/stt/websocket?${params}`

const ws = new WebSocket(url, { headers: { 'X-API-Key': key, 'Cartesia-Version': '2024-06-10' } })
const started = Date.now()
const log = (m) => console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`)

setTimeout(() => { log('TIMEOUT'); process.exit(1) }, 30000)

ws.onopen = () => {
  log(`open (language=${language})`)
  const CHUNK = 3200
  let off = 0
  const pump = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) { clearInterval(pump); return }
    const slice = pcm.subarray(off, off + CHUNK)
    if (slice.length === 0) {
      clearInterval(pump)
      ws.send('finalize')
      log('finalize sent')
      setTimeout(() => { try { ws.send('close') } catch {}; }, 4000)
      return
    }
    ws.send(slice)
    off += CHUNK
  }, 100)
}
ws.onmessage = (ev) => log(`msg: ${String(ev.data).slice(0, 300)}`)
ws.onerror = (e) => log(`error: ${e.message || e}`)
ws.onclose = (ev) => { log(`closed code=${ev.code} reason=${ev.reason}`); process.exit(0) }
