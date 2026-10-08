/**
 * What the voice model knows: its system instruction and the four harness
 * tools it may call. The browser executes these tools against the session the
 * user is viewing; their names are the shared vocabulary of both halves.
 */

/** Tool names the voice model can call; the browser half switches on these. */
export const VOICE_AGENT_TOOLS = ['ask_harness', 'steer_harness', 'stop_harness', 'harness_status'] as const

/** Gemini function declarations for {@link VOICE_AGENT_TOOLS}. */
export const FUNCTION_DECLARATIONS: readonly object[] = [
  {
    name: 'ask_harness',
    description: 'Give a new task to the DeepSeek Harness coding agent working in the user\'s project: reading or changing files, running commands, fixing bugs, explaining code, searching the codebase. Use this for ANY request about the user\'s project or computer. The agent works asynchronously: this returns immediately, and the result arrives later as an [agent update] message.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task: { type: 'STRING', description: 'The complete task as a clear standalone instruction to the coding agent. Write it in the SAME language the user spoke (if the user spoke Chinese, write the task in Chinese); never translate it. Keep the user\'s wording and include every detail they gave.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'steer_harness',
    description: 'Redirect the coding agent while it is already working: add a correction, a constraint, or extra detail to the running task. Use when the user changes their mind or adds information about the current task.',
    parameters: {
      type: 'OBJECT',
      properties: {
        message: { type: 'STRING', description: 'The correction or extra instruction for the running task, in the same language the user spoke; never translate it.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'stop_harness',
    description: 'Stop the coding agent\'s current task immediately. Use when the user says stop, cancel, or wait.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'harness_status',
    description: 'Check what the coding agent is doing right now: whether it is working, which tools it recently used, and its latest answer.',
    parameters: { type: 'OBJECT', properties: {} },
  },
]

/** Built-in system instruction; user `instructions` from settings are appended. */
const BASE_INSTRUCTIONS = `You are the voice interface of DeepSeek Harness, a coding agent running on the user's computer. You talk with the user; the coding agent does the actual work.

How to work:
- For any request about the user's project, files, code, terminal, or computer, call ask_harness with a clear, complete task. Do not try to answer those from your own knowledge, and never pretend you did the work.
- Write every task and correction in the language the user is speaking. If the user speaks Chinese, the task text must be Chinese. Never translate the user's request into English: the coding agent answers in the language of the task.
- After calling ask_harness, say one short sentence such as "On it." and then wait. Do not invent progress.
- Messages that start with [agent update] come from the coding agent, not the user. When you get one, tell the user the result in one to three short spoken sentences. Summarize; do not read code, long paths, or symbols aloud. Say file names naturally ("the index file in src").
- If an update says the agent is waiting for approval, tell the user to approve or deny it in the window.
- If the user corrects or adds to the current task, use steer_harness. If they say stop or cancel, use stop_harness. If they ask what is happening, use harness_status.
- For small talk or general questions that do not involve their project, just answer briefly yourself.
- Keep every reply short and conversational. Answer in the language the user speaks.`

/**
 * Compose the system instruction for one call.
 * @param extra - user-supplied instructions from settings; empty adds nothing.
 * @returns the complete instruction text.
 */
export function buildInstructions(extra: string): string {
  const trimmed = extra.trim()
  return trimmed === '' ? BASE_INSTRUCTIONS : `${BASE_INSTRUCTIONS}\n\nAdditional instructions from the user:\n${trimmed}`
}
