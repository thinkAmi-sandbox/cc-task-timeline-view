// cc-task-timeline-view: reads the desktop app's task list (update_plan) and recap (wrap_up)
// from the transcript, and draws the work for each step in a Pane.
// Adds nothing to the model: registers no tools, and the hooks only pass through.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { AgentRun, Notes, Step, Trigger, TurnCard } from '../types'
import {
  agentNotes,
  agentsToResolve,
  applyAgentNotes,
  applyAgentUpdates,
  applyMessages,
  deriveTurns,
  EMPTY,
  EMPTY_NOTES,
  formatClock,
  formatPeriod,
  newTimedUses,
  parseNotesFile,
  parseUtcOffset,
  progressOf,
  reportLine,
  runningAgents,
  serializeNotes,
  shortId,
} from './timeline'
import type { AgentUpdate } from './timeline'

const PANE = 'cc-task-timeline-view'
const TITLE = 'Timeline'
// Change the tag when the saved shape changes: values saved by an older version are discarded unread.
// timeline-2: added the trigger to plans.
// timeline-3: added subagents (agents) to steps. Discard and rebuild from the whole conversation.
const timeline = atom({ plugin: 'cc-task-timeline-view', key: 'timeline' } as const, EMPTY, {
  shape: 'timeline-3',
})
/** Number of characters of the triggering message shown when collapsed. */
const TRIGGER_SHORT = 60
// Holds only the steps whose open state the user toggled. Steps not held are "open if active".
const openSteps = atom({ plugin: 'cc-task-timeline-view', key: 'open' } as const, {}, { shape: 'open-1' })

/**
 * Puts text on the clipboard. Text in a Pane cannot be selected and copied, so it is done from a button.
 * Writes to the clipboard of the surface that was pressed and reports the result in a short toast. Adds nothing to the model's conversation.
 */
async function copyText($: EngineInterface, text: string, surface: RenderSurface): Promise<void> {
  const result = await $.ui.copy({ text, surface })
  $.ui.toast(result.isCopied ? 'Copied' : `Could not copy (${result.reason})`)
}

/** Opens or closes a step's work list. Sets it to the opposite of how it looks now (isOpen). */
function toggleStep($: EngineInterface, stepKey: string, isOpen: boolean): Promise<Record<string, boolean>> {
  return update($, openSteps, map => ({ ...map, [stepKey]: !(map[stepKey] ?? isOpen) }))
}

// This Mac's offset from UTC (minutes). The mod runtime's time zone setting is unreliable, so it is taken at startup.
const utcOffset = atom({ plugin: 'cc-task-timeline-view', key: 'utcOffset' } as const, null)

/** Gets this Mac's offset with `date +%z`. Falls back to the runtime's offset if that fails. */
async function detectOffset($: EngineInterface): Promise<void> {
  let offset: number | undefined
  try {
    const result = await $.process.run(['date', '+%z'])
    if (result.exitCode === 0) offset = parseUtcOffset(result.stdout)
  } catch {
    // If external commands are unavailable, use the runtime's offset instead.
  }
  await update($, utcOffset, () => offset ?? -new Date().getTimezoneOffset())
}

// Notes on the transcript (observed times and finished subagents' results). Holds no message or plan text.
const notesAtom = atom({ plugin: 'cc-task-timeline-view', key: 'notes' } as const, EMPTY_NOTES, { shape: 'notes-1' })
// Turns built from the transcript. Used to show turns without a task list as small cards. Not saved.
const turnsAtom = atom({ plugin: 'cc-task-timeline-view', key: 'turns' } as const, { turns: [], planIndex: {} }, {
  shape: 'turns-1',
})
/** Folder for notes files (relative to the config folder). One file per session. */
const NOTES_DIR = 'cc-task-timeline-view/sessions'
/** The content last written to the file. Not written again if unchanged. */
let lastSaved: string | undefined

// Queue reads in a single line, and merge requests that arrive while waiting into one.
let queue: Promise<void> = Promise.resolve()
let isQueued = false

/** Reads the transcript and applies tool_use entries not yet applied to the Timeline. */
async function syncOnce($: EngineInterface): Promise<void> {
  // Notes are optional. Even if they cannot be read, the timeline is drawn from the transcript.
  const notes = await loadNotesFor($).catch(() => EMPTY_NOTES)
  const current = await read($, timeline)
  // This version of $.session.messages() has no incremental read, so read it all. Duplicates are removed via seen.
  const rows = await $.session.messages()
  if (rows.length === 0) return

  // Past entries right after loading have no known time. Use the time from the notes file if present.
  const now = current.seeded === true ? await $.clock.now() : undefined
  const observed = now === undefined ? {} : Object.fromEntries(newTimedUses(current, rows).map(id => [id, now]))
  const times = { ...notes.times, ...observed }

  await update($, timeline, value => ({
    ...applyAgentNotes(applyMessages(value, rows, now, id => times[id]), notes.agents),
    seeded: true,
  }))
  // Turns are rebuilt from the transcript every time (the transcript is the source of truth).
  await update($, turnsAtom, () => deriveTurns(rows))
  await resolveAgents($)

  // Add newly observed times and finished subagents' results to the notes and write them out.
  const settled = agentNotes(await read($, timeline))
  const next: Notes = { ...notes, times, agents: { ...notes.agents, ...settled } }
  await update($, notesAtom, () => next)
  await saveNotes($, next).catch(() => undefined)
}

/** Location of the notes file. Under CLAUDE_CONFIG_DIR if set, otherwise under ~/.claude. */
async function notesPath($: EngineInterface, sessionId: string): Promise<string | undefined> {
  // The session id is used as the file name as is, so do not save if it has unexpected characters.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const base = configured !== undefined && configured !== '' ? configured : home === undefined || home === '' ? undefined : `${home}/.claude`

  return base === undefined ? undefined : `${base}/${NOTES_DIR}/${sessionId}.json`
}

/** Returns the current session's notes. If switched to another session, re-reads that session's file. */
async function loadNotesFor($: EngineInterface): Promise<Notes> {
  const sessionId = await $.session.id()
  const held = await read($, notesAtom)
  if (held.sessionId === sessionId) return held

  const path = await notesPath($, sessionId)
  let loaded: Notes = { ...EMPTY_NOTES, sessionId }
  if (path !== undefined) {
    try {
      // Ignore a file that is missing, unreadable or malformed. Only the display of times and subagent results is lost.
      if (await $.fs.exists(path)) loaded = parseNotesFile(await $.fs.read(path), sessionId) ?? loaded
    } catch {
      // If unreadable, start from empty notes.
    }
  }
  lastSaved = serializeBody(loaded)
  await update($, notesAtom, () => loaded)

  return loaded
}

/** Writes the notes to the file if they changed since the last write. */
async function saveNotes($: EngineInterface, notes: Notes): Promise<void> {
  const body = serializeBody(notes)
  if (body === lastSaved || notes.sessionId === undefined) return
  const path = await notesPath($, notes.sessionId)
  if (path === undefined) return

  await $.fs.write(path, serializeNotes(notes, await $.clock.now()))
  lastSaved = body
}

/** The content without the save time, used to check for changes. */
const serializeBody = (notes: Notes): string => JSON.stringify({ times: notes.times, agents: notes.agents })

/** Reads a subagent's conversation and returns the first line of its last report. undefined if unreadable. */
async function readReport($: EngineInterface, agentId: string): Promise<string | undefined> {
  const rows = await $.session.messages({ agentId })
  if (!Array.isArray(rows)) return undefined

  for (const row of [...rows].reverse()) {
    if (row.role !== 'assistant') continue
    // The report is passed as the SubagentHandback tool's input. If absent, the last message is taken as the report.
    const handback = [...row.toolUses].reverse().find(use => /handback/i.test(use.tool))
    const fromTool = Object.values(handback?.input ?? {}).find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    )
    if (fromTool !== undefined) return reportLine(fromTool)
    if (row.text.trim() !== '') return reportLine(row.text)
  }

  return undefined
}

/**
 * Fills in subagents whose state and report are not yet known.
 * Report rows may be missing from the conversation the mod reads, so the state comes from $.agent.list()
 * and the report from the subagent's own conversation.
 */
async function resolveAgents($: EngineInterface): Promise<void> {
  const pending = agentsToResolve(await read($, timeline))
  if (pending.length === 0) return

  const infos = await $.agent.list()
  const byId = new Map(infos.map(info => [info.id, info]))
  const updates: Record<string, AgentUpdate> = {}

  for (const run of pending) {
    if (run.agentId === undefined) continue
    const info = byId.get(run.agentId)
    const status: AgentRun['status'] | undefined =
      info === undefined
        ? undefined
        : info.status === 'completed'
          ? 'done'
          : info.status === 'failed' || info.status === 'killed'
            ? 'failed'
            : undefined
    const isFinished = (status ?? run.status) !== 'running'
    const report = isFinished && run.report === undefined ? await readReport($, run.agentId) : undefined

    if (status !== undefined || report !== undefined) {
      updates[run.agentId] = {
        ...(status === undefined ? {} : { status }),
        ...(report === undefined ? {} : { report }),
      }
    }
  }

  if (Object.keys(updates).length > 0) await update($, timeline, value => applyAgentUpdates(value, updates))
}

function sync($: EngineInterface): Promise<void> {
  if (isQueued) return queue
  isQueued = true
  queue = queue
    .then(() => {
      isQueued = false

      return syncOnce($)
    })
    .catch(() => undefined)

  return queue
}

async function reset($: EngineInterface): Promise<void> {
  await update($, timeline, () => EMPTY)
  await update($, openSteps, () => ({}))
}

const STEP_MARK: Record<Step['status'], string> = { done: '✓', active: '▶', pending: '·' }
const STEP_COLOR = { done: 'success', active: 'claude', pending: 'inactive' } as const
const AGENT_LABEL: Record<AgentRun['status'], string> = { running: '… running', done: '✓ done', failed: '✗ failed' }
const AGENT_COLOR = { running: 'claude', done: 'success', failed: 'error' } as const
/** The copy button's mark. The word "Copy" stands out too much, so use an overlapping-squares symbol. */
const COPY_ICON = '⧉'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'cc-task-timeline-view',
        description: 'Show the task list and the progress of the work as a timeline in a pane',
      })
    } catch {
      // Even if a command with the same name exists, keep the Pane and hooks working.
    }
    void $.ui.open({ id: PANE, title: TITLE })
    void detectOffset($)
    void sync($)

    return next(e)
  })

  on('command.run', { command: 'cc-task-timeline-view' }, async $ => {
    await sync($)
    await $.ui.open({ id: PANE, title: TITLE })

    return {}
  })

  // Read further each time a tool finishes. The result is passed through untouched.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) void sync($)

    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) void sync($)

    return next(e)
  })

  // On /clear or a switch to another session, clear the display and read again.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await reset($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Progress, Button } = $.ui.resolve(e)
    const value = await read($, timeline)
    const opened = await read($, openSteps)
    const now = await $.clock.now()
    // Until the offset is known, use the runtime's offset instead.
    const offset = (await read($, utcOffset)) ?? -new Date().getTimezoneOffset()
    const sessionId = (await read($, notesAtom)).sessionId
    const { turns, planIndex } = await read($, turnsAtom)
    const notes = await read($, notesAtom)

    // List plan cards and the small cards for turns without a task list in conversation order, newest first.
    // Plans whose position in the conversation is unknown (older than the readable range) go last.
    const planIds = new Set(value.plans.map(plan => plan.id))
    const entries = [
      ...value.plans.map((plan, i) => ({
        kind: 'plan' as const,
        plan,
        order: planIndex[plan.id] ?? i - value.plans.length,
      })),
      ...turns
        .filter(turn => turn.planId === undefined || !planIds.has(turn.planId))
        .map(turn => ({ kind: 'turn' as const, turn, order: turn.index })),
    ]
      .sort((a, b) => b.order - a.order)
      .slice(0, 10)

    // The trigger row: show only the start of a user message, and if long, toggle with "▸ More". Copy takes the full text.
    const triggerRow = (cardKey: string, trigger: Trigger) => {
      const triggerKey = `${cardKey}:trigger`
      const flat = trigger.text.replace(/\s+/g, ' ')
      const isLong = trigger.kind === 'user' && flat.length > TRIGGER_SHORT
      const isTriggerOpen = isLong && (opened[triggerKey] ?? false)
      const shown =
        trigger.kind === 'auto'
          ? `Automatic (${trigger.text})`
          : isTriggerOpen
            ? trigger.text
            : isLong
              ? `${flat.slice(0, TRIGGER_SHORT)}…`
              : flat
      const imageNote = trigger.images > 0 ? (trigger.images === 1 ? ' (1 image)' : ` (${trigger.images} images)`) : ''

      return (
        <Box flexDirection="row" alignItems="flex-start" columnGap={1}>
          <Box flexShrink={1}>
            <Text wrap="wrap">
              <Text dimColor>Prompt: </Text>
              {shown}
              <Text dimColor>{imageNote}</Text>
            </Text>
          </Box>
          {isLong && (
            <Button
              key={triggerKey}
              plain
              dimColor
              label={isTriggerOpen ? '▾ Less' : '▸ More'}
              onPress={() => toggleStep($, triggerKey, isTriggerOpen)}
            />
          )}
          {trigger.kind === 'user' && (
            <Button
              key={`${cardKey}:copy-trigger`}
              plain
              dimColor
              label={COPY_ICON}
              onPress={press => void copyText($, trigger.text, press.surface)}
            />
          )}
        </Box>
      )
    }

    // The "Summary:" / "Answer:" row. The shown text and the copied text can differ.
    const copyRow = (key: string, label: string, shown: string, copied: string) => (
      <Box flexDirection="row" alignItems="flex-start" columnGap={1}>
        <Box flexShrink={1}>
          <Text dimColor wrap="wrap">
            {label}
            {shown}
          </Text>
        </Box>
        <Button key={key} plain dimColor label={COPY_ICON} onPress={press => void copyText($, copied, press.surface)} />
      </Box>
    )

    // The small card for a turn without a task list: only the trigger and the recap (or, if none, the start of the answer).
    const turnCard = (turn: TurnCard) => {
      const cardKey = `turn:${turn.index}`
      const isAnswering = turn.isLatest && turn.recap === undefined && turn.answer === undefined
      const endedAt = turn.wrapId === undefined ? undefined : notes.times[turn.wrapId]
      const time = endedAt === undefined ? '' : ` · ${formatClock(endedAt, offset)}`

      return (
        <Box
          key={cardKey}
          flexDirection="column"
          borderStyle="round"
          borderColor={isAnswering ? 'claude' : 'inactive'}
          paddingX={1}
        >
          <Text bold>
            {isAnswering ? 'Answering' : 'Answer only'}
            <Text dimColor>{time}</Text>
          </Text>
          {triggerRow(cardKey, turn.trigger)}
          {turn.recap !== undefined && turn.recap !== ''
            ? copyRow(`${cardKey}:copy-recap`, 'Summary: ', turn.recap, turn.recap)
            : turn.answer !== undefined && turn.answer.trim() !== ''
              ? copyRow(`${cardKey}:copy-answer`, 'Answer: ', reportLine(turn.answer), turn.answer)
              : null}
        </Box>
      )
    }

    // Show only the start of the session ID, like a commit hash; copying puts the full ID.
    const sessionRow =
      sessionId === undefined ? null : (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Text>
            <Text dimColor>Session ID: </Text>
            {shortId(sessionId)}
          </Text>
          <Button
            key="session:copy"
            plain
            dimColor
            label={COPY_ICON}
            onPress={press => void copyText($, sessionId, press.surface)}
          />
        </Box>
      )

    if (entries.length === 0) {
      return (
        <Box flexDirection="column">
          {sessionRow}
          <Text dimColor>No plans yet.</Text>
          <Text dimColor>When Claude makes a task list, its progress appears here.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {sessionRow}
        {entries.map((entry, index) => {
          if (entry.kind === 'turn') return turnCard(entry.turn)
          const plan = entry.plan
        const { done, total } = progressOf(plan)
        const isLatest = index === 0
        // Period: "2026-11-15 20:26 – 20:28 (2m)". Not shown when finished but the end time is unknown.
        const period =
          plan.recap !== undefined && plan.endedAt === undefined
            ? ''
            : formatPeriod(plan.startedAt, plan.recap === undefined ? undefined : plan.endedAt, now, offset)
        const elapsed = period === '' ? '' : ` · ${period}`
        const state = plan.recap === undefined ? 'In progress' : 'Done'
        const trigger = plan.trigger

        // Each plan is separated into its own card. A card in progress stands out by its border color.
        return (
          <Box
            key={plan.id}
            flexDirection="column"
            borderStyle="round"
            borderColor={plan.recap === undefined ? 'claude' : 'inactive'}
            paddingX={1}
          >
            <Text bold>
              {state}
              <Text dimColor>{elapsed}</Text>
            </Text>
            {trigger !== undefined && triggerRow(plan.id, trigger)}
            <Progress
              label="Progress"
              value={done}
              max={Math.max(1, total)}
              valueText={`${done}/${total} done`}
            />
            {plan.steps.map((step, i) => {
              const stepKey = `${plan.id}:${i}`
              const agents = step.agents ?? []
              const running = runningAgents(step)
              const itemCount = step.actionCount + agents.length
              const hasActions = itemCount > 0
              // Active steps, and steps with subagents still running, start open.
              const isOpen = hasActions && (opened[stepKey] ?? (step.status === 'active' || running > 0))
              // The desktop draws a Button as a padded native button, so the step name stays plain
              // text to keep the left edge and color aligned, and only the trailing "▸ n items" is the toggle button.
              return (
                <Box key={`${plan.id}-${i}`} flexDirection="column">
                  <Box flexDirection="row" alignItems="center" columnGap={1}>
                    <Box flexShrink={1}>
                      <Text color={STEP_COLOR[step.status]} dimColor={!isLatest && step.status !== 'active'}>
                        {STEP_MARK[step.status]} {step.text}
                      </Text>
                    </Box>
                    {hasActions && (
                      <Button
                        key={stepKey}
                        plain
                        dimColor
                        label={`${isOpen ? '▾' : '▸'} ${itemCount} ${itemCount === 1 ? 'item' : 'items'}${running > 0 ? ` · ${running} running` : ''}`}
                        onPress={() => toggleStep($, stepKey, isOpen)}
                      />
                    )}
                  </Box>
                  {isOpen &&
                    agents.map(run => (
                      <Box key={run.toolUseId} flexDirection="column">
                        <Text wrap="truncate-end">
                          {'    · Agent: '}
                          {run.description}
                          <Text color={AGENT_COLOR[run.status]}>{`  ${AGENT_LABEL[run.status]}`}</Text>
                        </Text>
                        {run.report !== undefined && run.report !== '' && (
                          // Split into a fixed column up to "└" and the rest for the report, so the report's left edge stays aligned when wrapped.
                          <Box flexDirection="row" columnGap={1}>
                            <Text dimColor>{'        └'}</Text>
                            <Box flexShrink={1}>
                              <Text dimColor wrap="wrap">
                                {run.report}
                              </Text>
                            </Box>
                            <Button
                              key={`${run.toolUseId}:copy`}
                              plain
                              dimColor
                              label={COPY_ICON}
                              onPress={press => void copyText($, run.report ?? '', press.surface)}
                            />
                          </Box>
                        )}
                      </Box>
                    ))}
                  {isOpen &&
                    step.actions.map(action => (
                      <Text dimColor wrap="truncate-end">
                        {'    · '}
                        {action}
                      </Text>
                    ))}
                  {isOpen && step.actionCount > step.actions.length && (
                    <Text dimColor>{`    …and ${step.actionCount - step.actions.length} more`}</Text>
                  )}
                </Box>
              )
            })}
            {plan.recap !== undefined && plan.recap !== '' && copyRow(`${plan.id}:copy-recap`, 'Summary: ', plan.recap, plan.recap)}
          </Box>
        )
        })}
      </Box>
    )
  })
}
