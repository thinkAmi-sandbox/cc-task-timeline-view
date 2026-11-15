// Pure functions that build a Timeline from the transcript's tool_use entries.
// They do not touch the Claude Code API, so they can be tested on their own.
import type { AgentNote, AgentRun, Notes, Plan, Step, StepStatus, Timeline, Trigger, TurnCard, Turns } from '../types'

/** One tool_use from the transcript (the needed part of $.session.messages()' ToolUseSummary). */
export type ToolUseLike = {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  /** The result as the model read it. Absent while running. */
  text?: string
  isError?: true
  /** For the Agent tool, the id of the launched subagent. */
  agentId?: string
}

const AGENT_TOOL = 'Agent'
const REPORT_LENGTH = 120

export const EMPTY: Timeline = { plans: [], seen: [] }

const MAX_PLANS = 30
const MAX_SEEN = 2000
const MAX_ACTIONS = 8
const LABEL_LENGTH = 80
const TRIGGER_LENGTH = 2000

/** How one user-side row is read. */
type UserRow =
  | { type: 'prompt'; text: string }
  | { type: 'auto'; text: string; taskId?: string; taskStatus?: string }
  | { type: 'report'; from: string; text: string }
  | { type: 'image' }
  | { type: 'skip' }

/** Takes the first non-empty line from multi-line text. */
const firstLine = (text: string): string =>
  text
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? ''

/** Extracts the sender and the report's first line from a subagent report (agent-message). */
const parseAgentMessage = (text: string): { from: string; text: string } | undefined => {
  const message = /<agent-message from="([^"]+)">([\s\S]*?)(<\/agent-message>|$)/.exec(text)
  if (message === null) return undefined

  const body = message[2] ?? ''
  // A fixed preamble is followed by the indented report body.
  const report = body.includes('The report follows:') ? (body.split('The report follows:')[1] ?? '') : body

  return { from: message[1] ?? '', text: cut(firstLine(report), REPORT_LENGTH) }
}

/**
 * Sorts a user-side row into a human message, an automatic notice, an attached image, or a row to skip.
 * The transcript also contains rows the human did not type (skill descriptions, caveats, etc.), so they are told apart by how they start.
 */
export const classifyUserText = (raw: string): UserRow => {
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (text === '') return { type: 'skip' }
  if (text.startsWith('[Image')) return { type: 'image' }
  if (text.startsWith('Base directory for this skill:')) return { type: 'skip' }
  if (text.startsWith('<local-command-caveat>') || text.startsWith('<local-command-stdout>')) return { type: 'skip' }

  const command = /^<command-name>([\s\S]*?)<\/command-name>/.exec(text)
  if (command !== null) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''

    return { type: 'prompt', text: `${command[1]?.trim() ?? ''} ${args}`.trim() }
  }

  // Reports from subagents or other sessions. Not a human message.
  if (text.startsWith('Another Claude session sent a message') || text.startsWith('<agent-message')) {
    const report = parseAgentMessage(text)

    return report === undefined ? { type: 'auto', text: 'message from another session' } : { type: 'report', ...report }
  }

  const tag = /^<([a-z][a-z0-9-]*)[\s>]/.exec(text)
  if (tag !== null) {
    const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim()
    const taskStatus = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim()

    return {
      type: 'auto',
      text: tag[1] ?? 'notification',
      ...(taskId === undefined ? {} : { taskId }),
      ...(taskStatus === undefined ? {} : { taskStatus }),
    }
  }

  return { type: 'prompt', text: cut(text, TRIGGER_LENGTH) }
}

/** Updates the latest trigger with one user-side row. */
const nextTrigger = (pending: Trigger | undefined, row: UserRow): Trigger | undefined => {
  if (row.type === 'prompt') return { kind: 'user', text: row.text, images: 0 }
  if (row.type === 'auto') return { kind: 'auto', text: row.text, images: 0 }
  if (row.type === 'report') return { kind: 'auto', text: 'subagent report', images: 0 }
  if (row.type === 'image' && pending !== undefined) return { ...pending, images: pending.images + 1 }

  return pending
}

/** Rewrites the subagents, across all plans, that match the condition. */
const updateAgents = (
  timeline: Timeline,
  matches: (run: AgentRun) => boolean,
  change: (run: AgentRun) => AgentRun,
): Timeline => {
  let changed = false
  const plans = timeline.plans.map(plan => {
    if (!plan.steps.some(step => step.agents?.some(matches))) return plan
    changed = true

    return {
      ...plan,
      steps: plan.steps.map(step =>
        step.agents?.some(matches) ? { ...step, agents: step.agents.map(run => (matches(run) ? change(run) : run)) } : step,
      ),
    }
  })

  return changed ? { ...timeline, plans } : timeline
}

/**
 * From an Agent tool call, applies the launched subagent's id and, when it ran in the foreground
 * and its result came straight back, its completion and report. Safe to call any number of times per read.
 */
const resolveAgentUse = (timeline: Timeline, use: ToolUseLike): Timeline => {
  if (use.tool !== AGENT_TOOL) return timeline

  const launched = use.text?.includes('Async agent launched') === true
  const agentId = use.agentId ?? /agentId: ([A-Za-z0-9_-]+)/.exec(use.text ?? '')?.[1]

  return updateAgents(
    timeline,
    run => run.toolUseId === use.tool_use_id,
    run => {
      const withId = run.agentId === undefined && agentId !== undefined ? { ...run, agentId } : run
      if (run.status !== 'running' || use.text === undefined || launched) return withId
      // For a foreground subagent, the tool result is the report itself.
      if (use.isError === true) return { ...withId, status: 'failed', report: cut(firstLine(use.text), REPORT_LENGTH) }

      return { ...withId, status: 'done', report: cut(firstLine(use.text), REPORT_LENGTH) }
    },
  )
}

/** Applies a report or completion notice to the subagent that sent it. */
const resolveAgentRow = (timeline: Timeline, row: UserRow): Timeline => {
  if (row.type === 'report') {
    return updateAgents(
      timeline,
      run => run.agentId === row.from,
      run => ({ ...run, status: run.status === 'failed' ? 'failed' : 'done', report: row.text }),
    )
  }

  if (row.type === 'auto' && row.text === 'task-notification' && row.taskId !== undefined) {
    const status = row.taskStatus
    if (status !== 'completed' && status !== 'failed' && status !== 'killed') return timeline

    return updateAgents(
      timeline,
      run => run.agentId === row.taskId && run.status === 'running',
      run => ({ ...run, status: status === 'completed' ? 'done' : 'failed' }),
    )
  }

  return timeline
}

/** The desktop app's task list tools. Matched by suffix so a changed server-name prefix still works. */
export const isPlanTool = (tool: string): boolean => tool.endsWith('ccd_turn__update_plan')
export const isWrapUpTool = (tool: string): boolean => tool.endsWith('ccd_turn__wrap_up')

/** Tools not counted as work (the task list itself, and tool loading). */
const isIgnored = (tool: string): boolean =>
  tool.includes('ccd_turn__') || tool === 'ToolSearch'

const toStatus = (value: unknown): StepStatus =>
  value === 'in_progress' ? 'active' : value === 'completed' ? 'done' : 'pending'

const cut = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text

/** Turns a tool call into one line such as "Bash: Check something". */
export const describeAction = (use: ToolUseLike): string => {
  const name = use.tool.split('__').at(-1) ?? use.tool
  const input = use.input
  const keys = ['description', 'url', 'query', 'file_path', 'pattern', 'command', 'prompt', 'skill']
  const key = keys.find(name => typeof input[name] === 'string' && input[name] !== '')
  const raw = key === undefined ? '' : String(input[key]).replace(/\s+/g, ' ').trim()
  // File paths are long, so keep only the file name.
  const detail = key === 'file_path' ? (raw.split('/').at(-1) ?? raw) : raw

  return cut(detail === '' ? name : `${name}: ${detail}`, LABEL_LENGTH)
}

const lastOpenPlan = (timeline: Timeline): Plan | undefined => {
  const plan = timeline.plans.at(-1)

  return plan !== undefined && plan.endedAt === undefined && plan.recap === undefined ? plan : undefined
}

const replaceLast = (timeline: Timeline, plan: Plan): Timeline => ({
  ...timeline,
  plans: [...timeline.plans.slice(0, -1), plan],
})

const start = (step: Step, now: number | undefined): Step => ({
  ...step,
  status: 'active',
  startedAt: step.startedAt ?? now,
})

const finish = (step: Step, now: number | undefined): Step => ({
  ...step,
  status: 'done',
  doneAt: step.doneAt ?? now,
})

/** Applies update_plan items (the whole plan). Replaces an unfinished plan if there is one, otherwise adds a new one. */
const applyItems = (
  timeline: Timeline,
  id: string,
  items: unknown[],
  now: number | undefined,
  trigger: Trigger | undefined,
  sameTurn: boolean,
): Timeline => {
  // A remake within the same turn replaces the plan. Once a user message intervenes, it becomes a new plan.
  const open = sameTurn ? lastOpenPlan(timeline) : undefined
  const steps: Step[] = items.map(item => {
    const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const text = typeof record.content === 'string' ? record.content : '(untitled)'
    const status = toStatus(record.status)
    // If a step with the same text existed before the replacement, carry over its work record.
    const before = open?.steps.find(step => step.text === text)
    const base: Step = before ?? { text, status: 'pending', actions: [], actionCount: 0 }

    return status === 'active' ? start(base, now) : status === 'done' ? finish(base, now) : { ...base, status }
  })

  if (open !== undefined) return replaceLast(timeline, { ...open, steps })

  const plan: Plan = trigger === undefined ? { id, startedAt: now, steps } : { id, trigger, startedAt: now, steps }

  return { ...timeline, plans: [...timeline.plans, plan].slice(-MAX_PLANS) }
}

/** Applies advance / done / start operations. */
const applyMoves = (timeline: Timeline, input: Record<string, unknown>, now: number | undefined): Timeline => {
  const open = lastOpenPlan(timeline)
  if (open === undefined) return timeline

  let steps = open.steps

  if (input.advance === true) {
    const active = steps.findIndex(step => step.status === 'active')
    if (active >= 0) steps = steps.map((step, i) => (i === active ? finish(step, now) : step))
    const next = steps.findIndex(step => step.status === 'pending')
    if (next >= 0) steps = steps.map((step, i) => (i === next ? start(step, now) : step))
  }

  if (Array.isArray(input.done)) {
    const done = new Set(input.done.filter((n): n is number => typeof n === 'number'))
    steps = steps.map((step, i) => (done.has(i + 1) ? finish(step, now) : step))
  }

  if (typeof input.start === 'number') {
    const target = input.start - 1
    steps = steps.map((step, i) => (i === target ? start(step, now) : step))
  }

  return replaceLast(timeline, { ...open, steps })
}

/** wrap_up: closes the plan with a recap. Active steps are treated as done (the app checks off the list too). */
const applyWrapUp = (timeline: Timeline, input: Record<string, unknown>, now: number | undefined): Timeline => {
  const open = lastOpenPlan(timeline)
  if (open === undefined) return timeline

  const recap = typeof input.recap === 'string' ? input.recap : ''
  const steps = open.steps.map(step => (step.status === 'active' ? finish(step, now) : step))

  // If the end time is unknown, leave it out (putting 0 would display as 1970).
  const endedAt = now ?? open.startedAt

  return replaceLast(timeline, endedAt === undefined ? { ...open, steps, recap } : { ...open, steps, recap, endedAt })
}

/** Any other tool: attached to the active step as work. */
const applyAction = (timeline: Timeline, use: ToolUseLike): Timeline => {
  const open = lastOpenPlan(timeline)
  if (open === undefined || isIgnored(use.tool)) return timeline

  const active = open.steps.findIndex(step => step.status === 'active')
  if (active < 0) return timeline

  // A subagent launch is kept not as a work line but as a separate row whose completion and report can be tracked.
  if (use.tool === AGENT_TOOL) {
    const description = typeof use.input.description === 'string' ? use.input.description : 'subagent'
    const run: AgentRun = { toolUseId: use.tool_use_id, description, status: 'running' }
    const steps = open.steps.map((step, i) => (i === active ? { ...step, agents: [...(step.agents ?? []), run] } : step))

    return replaceLast(timeline, { ...open, steps })
  }

  const label = describeAction(use)
  const steps = open.steps.map((step, i) =>
    i === active
      ? { ...step, actions: [...step.actions, label].slice(-MAX_ACTIONS), actionCount: step.actionCount + 1 }
      : step,
  )

  return replaceLast(timeline, { ...open, steps })
}

/**
 * Applies one tool_use. The same tool_use_id is never applied twice.
 * trigger is what started the plan; it is attached to a new plan when one begins.
 */
export const applyToolUse = (
  timeline: Timeline,
  use: ToolUseLike,
  now: number | undefined,
  trigger?: Trigger,
  sameTurn = true,
): Timeline => {
  if (timeline.seen.includes(use.tool_use_id)) return timeline

  const marked: Timeline = { ...timeline, seen: [...timeline.seen, use.tool_use_id].slice(-MAX_SEEN) }
  const input = use.input ?? {}

  if (isPlanTool(use.tool)) {
    return Array.isArray(input.items)
      ? applyItems(marked, use.tool_use_id, input.items, now, trigger, sameTurn)
      : applyMoves(marked, input, now)
  }

  // A recap from a turn that made no plan is not attached to the previous turn's plan.
  if (isWrapUpTool(use.tool)) return sameTurn ? applyWrapUp(marked, input, now) : marked

  return applyAction(marked, use)
}

/**
 * Applies conversation rows in bulk. User-side rows provide the latest trigger, and when
 * an assistant's toolUses start a new plan, that trigger is attached to it.
 * The conversation is read from the start every time, so the trigger only needs to live inside this function.
 */
export const applyMessages = (
  timeline: Timeline,
  messages: ReadonlyArray<{ role: string; text?: string; toolUses: ReadonlyArray<ToolUseLike> }>,
  now: number | undefined,
  timeOf?: (toolUseId: string) => number | undefined,
): Timeline => {
  let pending: Trigger | undefined
  // Whether a plan was made in the current turn (since the user's last message). Notices and reports do not split turns.
  let planThisTurn = false

  return messages.reduce((acc, message) => {
    if (message.role !== 'assistant') {
      const row = classifyUserText(message.text ?? '')
      pending = nextTrigger(pending, row)
      if (row.type === 'prompt') planThisTurn = false

      return resolveAgentRow(acc, row)
    }

    // After applying (only once), subagent ids and completion are re-applied every time.
    return message.toolUses.reduce((inner, use) => {
      // Use the time from the notes if there is one (restores past times after a restart). Otherwise the time observed now.
      const applied = applyToolUse(inner, use, timeOf?.(use.tool_use_id) ?? now, pending, planThisTurn)
      if (isPlanTool(use.tool) && Array.isArray(use.input.items)) planThisTurn = true

      return resolveAgentUse(applied, use)
    }, acc)
  }, timeline)
}

/** The number of a step's subagents that are still running. */
export const runningAgents = (step: Step): number => (step.agents ?? []).filter(run => run.status === 'running').length

/** A plan's progress (done count and total). */
export const progressOf = (plan: Plan): { done: number; total: number } => ({
  done: plan.steps.filter(step => step.status === 'done').length,
  total: plan.steps.length,
})

/** Writes elapsed time as "12m" or "1h 5m". */
export const formatElapsed = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Takes the first line to display from a report's text. */
export const reportLine = (text: string): string => cut(firstLine(text), REPORT_LENGTH)

/** Subagents whose state or report is not yet known (only those whose id is known). */
export const agentsToResolve = (timeline: Timeline): AgentRun[] =>
  timeline.plans.flatMap(plan =>
    plan.steps.flatMap(step =>
      (step.agents ?? []).filter(run => run.agentId !== undefined && (run.status === 'running' || run.report === undefined)),
    ),
  )

/** Each subagent's state and report (keyed by agentId). Unknown fields are left out. */
export type AgentUpdate = { status?: AgentRun['status']; report?: string }

/** Applies states and reports learned from $.agent.list() etc. Never turns done or failed back into running. */
export const applyAgentUpdates = (timeline: Timeline, updates: Readonly<Record<string, AgentUpdate>>): Timeline =>
  updateAgents(
    timeline,
    run => run.agentId !== undefined && updates[run.agentId] !== undefined,
    run => {
      const found = updates[run.agentId ?? ''] ?? {}
      const status = run.status === 'running' && found.status !== undefined ? found.status : run.status
      const report = run.report ?? found.report

      return report === undefined ? { ...run, status } : { ...run, status, report }
    },
  )

/** Empty notes. */
export const EMPTY_NOTES: Notes = { times: {}, agents: {} }

/** Calls whose time is kept in the notes (step start/finish and plan end happen at the moment of these calls). */
const isTimedTool = (tool: string): boolean => isPlanTool(tool) || isWrapUpTool(tool)

/** Ids of calls not yet applied whose time should be kept. They were just observed, so the current time applies. */
export const newTimedUses = (
  timeline: Timeline,
  messages: ReadonlyArray<{ role: string; toolUses: ReadonlyArray<ToolUseLike> }>,
): string[] =>
  messages.flatMap(message =>
    message.role === 'assistant'
      ? message.toolUses
          .filter(use => isTimedTool(use.tool) && !timeline.seen.includes(use.tool_use_id))
          .map(use => use.tool_use_id)
      : [],
  )

/** Extracts finished subagents' results, keyed by Agent tool call id. */
export const agentNotes = (timeline: Timeline): Record<string, AgentNote> =>
  Object.fromEntries(
    timeline.plans.flatMap(plan =>
      plan.steps.flatMap(step =>
        (step.agents ?? [])
          .filter((run): run is AgentRun & { status: 'done' | 'failed' } => run.status !== 'running')
          .map(run => {
            const note: AgentNote = {
              status: run.status,
              ...(run.agentId === undefined ? {} : { agentId: run.agentId }),
              ...(run.report === undefined ? {} : { report: run.report }),
            }

            return [run.toolUseId, note] as const
          }),
      ),
    ),
  )

/** Applies subagent results from the notes to rows that still look running (restoring after a restart). */
export const applyAgentNotes = (timeline: Timeline, notes: Readonly<Record<string, AgentNote>>): Timeline =>
  updateAgents(
    timeline,
    run => run.status === 'running' && notes[run.toolUseId] !== undefined,
    run => {
      const note = notes[run.toolUseId]
      if (note === undefined) return run

      return {
        ...run,
        status: note.status,
        ...(run.agentId === undefined && note.agentId !== undefined ? { agentId: note.agentId } : {}),
        ...(run.report === undefined && note.report !== undefined ? { report: note.report } : {}),
      }
    },
  )

/** Validates and extracts the notes file's contents. undefined if the shape is wrong (discarded). */
export const parseNotesFile = (text: string, sessionId: string): Notes | undefined => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const file = value as { format?: unknown; times?: unknown; agents?: unknown }
  if (file.format !== 1 || typeof file.times !== 'object' || file.times === null) return undefined
  if (typeof file.agents !== 'object' || file.agents === null) return undefined

  const times = Object.fromEntries(
    Object.entries(file.times as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  )
  const agents = Object.fromEntries(
    Object.entries(file.agents as Record<string, unknown>).flatMap(([id, raw]) => {
      if (typeof raw !== 'object' || raw === null) return []
      const note = raw as { agentId?: unknown; status?: unknown; report?: unknown }
      if (note.status !== 'done' && note.status !== 'failed') return []

      return [
        [
          id,
          {
            status: note.status,
            ...(typeof note.agentId === 'string' ? { agentId: note.agentId } : {}),
            ...(typeof note.report === 'string' ? { report: note.report } : {}),
          } satisfies AgentNote,
        ] as const,
      ]
    }),
  )

  return { sessionId, times, agents }
}

/** The string written to the notes file. Contains no message or plan text. */
export const serializeNotes = (notes: Notes, savedAt: number): string =>
  `${JSON.stringify({ format: 1, sessionId: notes.sessionId, savedAt, times: notes.times, agents: notes.agents }, null, 2)}\n`

/** Date-time parts with the UTC offset (minutes) applied. Does not rely on the mod runtime's time zone setting. */
const clockParts = (ms: number, offsetMinutes: number) => {
  const shifted = new Date(ms + offsetMinutes * 60000)
  const pad = (n: number) => String(n).padStart(2, '0')

  return {
    day: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  }
}

/**
 * Writes a plan's period as "2026-11-15 20:26 – 20:28 (2m)".
 * Omits the end date on the same day, and while in progress writes "2026-11-15 20:26 – (elapsed 3m)". Empty if the start is unknown.
 */
export const formatPeriod = (
  startedAt: number | undefined,
  endedAt: number | undefined,
  now: number,
  offsetMinutes: number,
): string => {
  if (startedAt === undefined) return ''
  const start = clockParts(startedAt, offsetMinutes)
  if (endedAt === undefined) return `${start.day} ${start.time} – (elapsed ${formatElapsed(now - startedAt)})`

  const end = clockParts(endedAt, offsetMinutes)
  const endText = end.day === start.day ? end.time : `${end.day} ${end.time}`

  return `${start.day} ${start.time} – ${endText} (${formatElapsed(endedAt - startedAt)})`
}

/** Turns `date +%z` output (e.g. +0900) into the offset from UTC (minutes). undefined if unreadable. */
export const parseUtcOffset = (text: string): number | undefined => {
  const match = /^([+-])(\d{2})(\d{2})/.exec(text.trim())
  if (match === null) return undefined
  const minutes = Number(match[2]) * 60 + Number(match[3])

  return match[1] === '-' ? -minutes : minutes
}

/** Shortens a session ID to its first characters, like a commit hash. */
export const shortId = (id: string, length = 8): string => id.slice(0, length)

/**
 * Extracts, from the conversation rows, a turn per user message and the positions of plans (task list calls).
 * Turns started automatically by notifications etc. are not made into cards.
 */
export const deriveTurns = (
  messages: ReadonlyArray<{ role: string; text?: string; toolUses: ReadonlyArray<ToolUseLike> }>,
): Turns => {
  const turns: TurnCard[] = []
  const planIndex: Record<string, number> = {}
  let current: TurnCard | undefined

  messages.forEach((message, index) => {
    if (message.role !== 'assistant') {
      const row = classifyUserText(message.text ?? '')
      if (row.type === 'prompt') {
        current = { index, trigger: { kind: 'user', text: row.text, images: 0 }, isLatest: false }
        turns.push(current)
      } else if (row.type === 'image' && current !== undefined && current.answer === undefined && current.planId === undefined) {
        current = { ...current, trigger: { ...current.trigger, images: current.trigger.images + 1 } }
        turns[turns.length - 1] = current
      } else if (row.type === 'auto' || row.type === 'report') {
        // A response after a notice or report is kept separate from the response to the user's message.
        current = undefined
      }

      return
    }

    for (const use of message.toolUses) {
      if (isPlanTool(use.tool) && Array.isArray(use.input.items) && planIndex[use.tool_use_id] === undefined) {
        planIndex[use.tool_use_id] = index
        if (current !== undefined && current.planId === undefined) current.planId = use.tool_use_id
      }
      if (isWrapUpTool(use.tool) && current !== undefined && typeof use.input.recap === 'string') {
        current.recap = use.input.recap
        current.wrapId = use.tool_use_id
      }
    }
    if (current !== undefined && (message.text ?? '').trim() !== '') current.answer = message.text
  })

  const last = turns.at(-1)
  if (last !== undefined) last.isLatest = true

  // Turns that are only a slash command with no response (ones handled locally, such as /cc-task-timeline-view) are not shown.
  const isEmptyCommand = (turn: TurnCard) =>
    turn.trigger.text.startsWith('/') && turn.planId === undefined && turn.recap === undefined && turn.answer === undefined

  return { turns: turns.filter(turn => !isEmptyCommand(turn)), planIndex }
}

/** Writes a date-time as "2026-11-15 21:43" (with the offset applied). */
export const formatClock = (ms: number, offsetMinutes: number): string => {
  const parts = clockParts(ms, offsetMinutes)

  return `${parts.day} ${parts.time}`
}
