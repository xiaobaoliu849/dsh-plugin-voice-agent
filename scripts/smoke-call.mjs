// Smoke test for the voice-agent host plugin running inside the desktop app.
// Connects to the call WebSocket, sends one text turn (no microphone needed),
// and verifies DeepSeek + Cartesia TTS respond with audio.
const url = process.argv[2] || 'ws://127.0.0.1:19387/api/voice-agent/ws'
const prompt = process.argv[3] || '你好，请用一句中文简短介绍你自己。'

const ws = new WebSocket(url)
let audioBytes = 0
let audioChunks = 0
let sawTranscript = false
const started = Date.now()
const log = (msg) => console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`)

const timer = setTimeout(() => {
  log(`TIMEOUT after 60s. audioChunks=${audioChunks} audioBytes=${audioBytes} transcript=${sawTranscript}`)
  process.exit(audioChunks > 0 && sawTranscript ? 0 : 1)
}, 60000)

ws.onopen = () => {
  log('ws open')
  ws.send(JSON.stringify({ type: 'text', text: prompt }))
  log(`sent text: ${prompt}`)
}

ws.onmessage = (event) => {
  if (typeof event.data !== 'string') {
    audioChunks += 1
    audioBytes += event.data.byteLength ?? event.data.size ?? 0
    if (audioChunks === 1) log('first audio chunk received')
    return
  }
  let msg
  try { msg = JSON.parse(event.data) } catch { log(`raw: ${event.data.slice(0, 200)}`); return }
  if (msg.type === 'audio') {
    audioChunks += 1
    audioBytes += (msg.data || '').length
    if (audioChunks === 1) log('first audio chunk received')
    return
  }
  if (msg.type === 'output_transcript') {
    if (!sawTranscript) log(`transcript: ${String(msg.text).slice(0, 120)}`)
    sawTranscript = true
    return
  }
  log(`msg ${msg.type}: ${JSON.stringify(msg).slice(0, 200)}`)
  if (msg.type === 'error') { clearTimeout(timer); process.exit(1) }
  if (msg.type === 'turn_complete') {
    log(`DONE. audioChunks=${audioChunks} audioBytes=${audioBytes} transcript=${sawTranscript}`)
    clearTimeout(timer)
    process.exit(audioChunks > 0 && sawTranscript ? 0 : 1)
  }
}

ws.onerror = (err) => { log(`ws error: ${err.message || err}`) }
ws.onclose = (ev) => { log(`ws closed code=${ev.code} reason=${ev.reason}`); clearTimeout(timer); process.exit(audioChunks > 0 ? 0 : 1) }
