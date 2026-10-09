// Capture one Chinese reply's TTS audio to a PCM file for STT round-trip testing.
import { writeFileSync } from 'node:fs'

const url = 'ws://127.0.0.1:19387/api/voice-agent/ws'
const out = process.argv[2] || '/tmp/zh_reply.pcm'
const ws = new WebSocket(url)
const chunks = []
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 60000)

ws.onopen = () => ws.send(JSON.stringify({ type: 'text', text: '请用一句中文介绍你自己，说明你是语音编程助手。' }))
ws.onmessage = async (event) => {
  if (typeof event.data !== 'string') { chunks.push(Buffer.from(await event.data.arrayBuffer())); return }
  let msg
  try { msg = JSON.parse(event.data) } catch { return }
  if (msg.type === 'audio' && msg.data) chunks.push(Buffer.from(msg.data, 'base64'))
  if (msg.type === 'output_transcript') process.stdout.write(String(msg.text))
  if (msg.type === 'error') { console.log('ERROR', msg.message); process.exit(1) }
  if (msg.type === 'turn_complete') {
    clearTimeout(timer)
    writeFileSync(out, Buffer.concat(chunks))
    console.log(`\nsaved ${chunks.length} chunks to ${out}`)
    process.exit(0)
  }
}
ws.onerror = (e) => { console.log('ws error', e.message || e); process.exit(1) }
