import { expect, test } from 'claude-code/testing'

import {
  agentNotes,
  agentsToResolve,
  applyAgentNotes,
  applyAgentUpdates,
  applyMessages,
  applyToolUse,
  classifyUserText,
  deriveTurns,
  describeAction,
  EMPTY,
  formatElapsed,
  formatPeriod,
  newTimedUses,
  parseNotesFile,
  parseUtcOffset,
  serializeNotes,
  shortId,
  progressOf,
} from './timeline'

const plan = (id: string, input: Record<string, unknown>) => ({
  tool_use_id: id,
  tool: 'mcp__ccd_turn__update_plan',
  input,
})
const bash = (id: string, description: string) => ({
  tool_use_id: id,
  tool: 'Bash',
  input: { command: 'ls', description },
})

test('advance finishes the active step and starts the next one', async () => {
  let t = applyToolUse(
    EMPTY,
    plan('p1', {
      items: [
        { content: 'Investigate', status: 'in_progress' },
        { content: 'Write', status: 'pending' },
      ],
      scope: 'first_task',
    }),
    1000,
  )
  t = applyToolUse(t, bash('b1', 'Read the file'), 2000)
  t = applyToolUse(t, plan('p2', { advance: true }), 3000)
  t = applyToolUse(t, bash('b2', 'Write the file'), 4000)

  const [only] = t.plans
  expect(t.plans.length).toBe(1)
  expect(only?.steps[0]?.status).toBe('done')
  expect(only?.steps[0]?.actions).toEqual(['Bash: Read the file'])
  expect(only?.steps[1]?.status).toBe('active')
  expect(only?.steps[1]?.actions).toEqual(['Bash: Write the file'])
  expect(only?.steps[1]?.startedAt).toBe(3000)
})

test('done and start can move ahead out of order', async () => {
  let t = applyToolUse(
    EMPTY,
    plan('p1', {
      items: [
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'pending' },
        { content: 'C', status: 'pending' },
      ],
      scope: 'first_task',
    }),
    undefined,
  )
  t = applyToolUse(t, plan('p2', { done: [1, 2], start: 3 }), undefined)

  expect(t.plans[0]?.steps.map(step => step.status)).toEqual(['done', 'done', 'active'])
  expect(progressOf(t.plans[0]!)).toEqual({ done: 2, total: 3 })
})

test('wrap_up closes the plan, and the next items become a new plan', async () => {
  let t = applyToolUse(
    EMPTY,
    plan('p1', { items: [{ content: 'A', status: 'in_progress' }], scope: 'first_task' }),
    1000,
  )
  t = applyToolUse(t, { tool_use_id: 'w1', tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'Did A' } }, 2000)
  t = applyToolUse(t, plan('p2', { items: [{ content: 'B', status: 'in_progress' }], scope: 'continuation' }), 3000)

  expect(t.plans.length).toBe(2)
  expect(t.plans[0]?.recap).toBe('Did A')
  expect(t.plans[0]?.steps[0]?.status).toBe('done')
  expect(t.plans[0]?.endedAt).toBe(2000)
  expect(t.plans[1]?.steps[0]?.text).toBe('B')
})

test('items arriving before the plan closes replace the same plan and carry over the work record', async () => {
  let t = applyToolUse(
    EMPTY,
    plan('p1', { items: [{ content: 'Investigate', status: 'in_progress' }], scope: 'first_task' }),
    undefined,
  )
  t = applyToolUse(t, bash('b1', 'Get the list'), undefined)
  t = applyToolUse(
    t,
    plan('p2', {
      items: [
        { content: 'Investigate', status: 'in_progress' },
        { content: 'Fix', status: 'pending' },
      ],
      scope: 'continuation',
    }),
    undefined,
  )

  expect(t.plans.length).toBe(1)
  expect(t.plans[0]?.steps.length).toBe(2)
  expect(t.plans[0]?.steps[0]?.actions).toEqual(['Bash: Get the list'])
})

test('the same tool_use is not applied twice, and the task list and ToolSearch do not count as work', async () => {
  const rows = [
    {
      role: 'assistant',
      toolUses: [
        plan('p1', { items: [{ content: 'A', status: 'in_progress' }], scope: 'first_task' }),
        { tool_use_id: 't1', tool: 'ToolSearch', input: { query: 'select:WebFetch' } },
        bash('b1', 'Read'),
      ],
    },
  ]
  const once = applyMessages(EMPTY, rows, undefined)
  const twice = applyMessages(once, rows, undefined)

  expect(twice.plans[0]?.steps[0]?.actions).toEqual(['Bash: Read'])
  expect(twice.plans[0]?.steps[0]?.actionCount).toBe(1)
})

test('work descriptions prefer description or URL, and are cut when long', async () => {
  expect(describeAction({ tool_use_id: 'x', tool: 'WebFetch', input: { url: 'https://example.com', prompt: 'p' } })).toBe(
    'WebFetch: https://example.com',
  )
  expect(describeAction({ tool_use_id: 'x', tool: 'mcp__srv__do', input: {} })).toBe('do')
  expect(describeAction({ tool_use_id: 'x', tool: 'Edit', input: { file_path: '/a/b/register.tsx' } })).toBe(
    'Edit: register.tsx',
  )
  expect(describeAction(bash('x', 'a'.repeat(200))).length).toBe(80)
  expect(formatElapsed(12 * 60000)).toBe('12m')
  expect(formatElapsed(65 * 60000)).toBe('1h 5m')
})

test('sorts user-side rows into messages, automatic, images and skipped', async () => {
  expect(classifyUserText('Make a prototype')).toEqual({ type: 'prompt', text: 'Make a prototype' })
  expect(classifyUserText('<system-reminder>Note</system-reminder>\nShow the original text briefly')).toEqual({
    type: 'prompt',
    text: 'Show the original text briefly',
  })
  expect(classifyUserText('<system-reminder>Note only</system-reminder>')).toEqual({ type: 'skip' })
  expect(classifyUserText('[Image: source: /tmp/1.png]')).toEqual({ type: 'image' })
  expect(classifyUserText('Base directory for this skill: /x')).toEqual({ type: 'skip' })
  expect(classifyUserText('<local-command-caveat>The command below…</local-command-caveat>')).toEqual({ type: 'skip' })
  expect(
    classifyUserText('<command-name>/cc-task-timeline-view</command-name>\n<command-message>cc-task-timeline-view</command-message>\n<command-args></command-args>'),
  ).toEqual({ type: 'prompt', text: '/cc-task-timeline-view' })
  expect(classifyUserText('<task-notification>\nmods loaded\n</task-notification>')).toEqual({
    type: 'auto',
    text: 'task-notification',
  })
})

test('attaches the preceding message and its attached image count to a new plan as the trigger', async () => {
  const rows = [
    { role: 'user', text: 'Toggling works. I want to align the indentation', toolUses: [] },
    { role: 'user', text: '[Image: source: /tmp/2.png]', toolUses: [] },
    { role: 'user', text: 'Base directory for this skill: /x', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [plan('p1', { items: [{ content: 'A', status: 'in_progress' }], scope: 'continuation' })],
    },
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'w1', tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'Did A' } }],
    },
    { role: 'user', text: '<task-notification>done</task-notification>', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [plan('p2', { items: [{ content: 'B', status: 'in_progress' }], scope: 'continuation' })],
    },
  ]
  const t = applyMessages(EMPTY, rows, undefined)

  expect(t.plans[0]?.trigger).toEqual({ kind: 'user', text: 'Toggling works. I want to align the indentation', images: 1 })
  expect(t.plans[1]?.trigger).toEqual({ kind: 'auto', text: 'task-notification', images: 0 })
})

const HANDBACK = (from: string, report: string) =>
  `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back] The text below is the final report. The report follows:\n  ${report}\n  second line\n</agent-message>`

test('a subagent report is treated as an automatic trigger, not a user message', async () => {
  expect(classifyUserText(HANDBACK('a1', '18 found'))).toEqual({ type: 'report', from: 'a1', text: '18 found' })

  const rows = [
    { role: 'user', text: 'First request', toolUses: [] },
    { role: 'user', text: HANDBACK('a1', '18 found'), toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [plan('p1', { items: [{ content: 'A', status: 'in_progress' }], scope: 'continuation' })],
    },
  ]

  expect(applyMessages(EMPTY, rows, undefined).plans[0]?.trigger).toEqual({
    kind: 'auto',
    text: 'subagent report',
    images: 0,
  })
})

test('background subagents link launch, completion notice and report by ID', async () => {
  const launch = (id: string, description: string, agentId: string) => ({
    tool_use_id: id,
    tool: 'Agent',
    input: { description, prompt: '…', model: 'haiku' },
    text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)`,
  })
  const rows = [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        plan('p1', { items: [{ content: 'Launch 3 agents', status: 'in_progress' }], scope: 'continuation' }),
        launch('t1', 'Check the defaults', 'a1'),
        launch('t2', 'Check the languages', 'a2'),
        launch('t3', 'Count the tests', 'a3'),
      ],
    },
    { role: 'user', text: HANDBACK('a2', 'There are 8 files'), toolUses: [] },
    {
      role: 'user',
      text: '<task-notification>\n<task-id>a2</task-id>\n<status>completed</status>\n</task-notification>',
      toolUses: [],
    },
    {
      role: 'user',
      text: '<task-notification>\n<task-id>a3</task-id>\n<status>failed</status>\n</task-notification>',
      toolUses: [],
    },
  ]
  const once = applyMessages(EMPTY, rows, undefined)
  // The conversation is read from the start every time, so reading it twice must give the same result.
  const t = applyMessages(once, rows, undefined)
  const step = t.plans[0]?.steps[0]

  expect(step?.actions).toEqual([])
  expect(step?.agents).toEqual([
    { toolUseId: 't1', description: 'Check the defaults', status: 'running', agentId: 'a1' },
    { toolUseId: 't2', description: 'Check the languages', status: 'done', agentId: 'a2', report: 'There are 8 files' },
    { toolUseId: 't3', description: 'Count the tests', status: 'failed', agentId: 'a3' },
  ])
})

test('a foreground subagent is marked done with the tool result as its report', async () => {
  const rows = [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        plan('p1', { items: [{ content: 'Investigate', status: 'in_progress' }], scope: 'first_task' }),
        { tool_use_id: 't1', tool: 'Agent', input: { description: 'Investigate' }, agentId: 'a1', text: '\nFound 3 results\nDetails…' },
      ],
    },
  ]
  const run = applyMessages(EMPTY, rows, undefined).plans[0]?.steps[0]?.agents?.[0]

  expect(run).toEqual({ toolUseId: 't1', description: 'Investigate', status: 'done', agentId: 'a1', report: 'Found 3 results' })
})

test('applies states and reports learned from agent.list etc., and never turns done back into running', async () => {
  const base = applyMessages(
    EMPTY,
    [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          plan('p1', { items: [{ content: 'A', status: 'in_progress' }], scope: 'first_task' }),
          { tool_use_id: 't1', tool: 'Agent', input: { description: 'x' }, agentId: 'a1', text: 'Async agent launched successfully.' },
          { tool_use_id: 't2', tool: 'Agent', input: { description: 'y' }, agentId: 'a2', text: 'Async agent launched successfully.' },
        ],
      },
    ],
    undefined,
  )

  expect(agentsToResolve(base).map(run => run.agentId)).toEqual(['a1', 'a2'])

  const t = applyAgentUpdates(base, { a1: { status: 'done', report: 'Result' }, a2: { status: 'failed' } })
  const again = applyAgentUpdates(t, { a1: { status: 'running' } })

  expect(again.plans[0]?.steps[0]?.agents?.map(run => [run.status, run.report])).toEqual([
    ['done', 'Result'],
    ['failed', undefined],
  ])
  expect(agentsToResolve(again).map(run => run.agentId)).toEqual(['a2'])
})

test('applies times from the notes to past calls when available', async () => {
  const rows = [
    { role: 'user', text: 'Request', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [plan('p1', { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }], scope: 'first_task' })],
    },
    { role: 'assistant', text: '', toolUses: [plan('p2', { advance: true })] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w1', tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'Finished' } }] },
  ]
  const times: Record<string, number> = { p1: 1000, p2: 2000, w1: 3000 }
  const t = applyMessages(EMPTY, rows, undefined, id => times[id])

  expect(t.plans[0]?.startedAt).toBe(1000)
  expect(t.plans[0]?.steps.map(step => [step.startedAt, step.doneAt])).toEqual([[1000, 2000], [2000, 3000]])
  expect(t.plans[0]?.endedAt).toBe(3000)
  // Times are kept only for task list and recap calls not yet applied.
  expect(newTimedUses(EMPTY, rows)).toEqual(['p1', 'p2', 'w1'])
  expect(newTimedUses(t, rows)).toEqual([])
})

test('extracts finished subagent results into notes and reapplies them after a restart', async () => {
  const rows = [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        plan('p1', { items: [{ content: 'A', status: 'in_progress' }], scope: 'first_task' }),
        { tool_use_id: 't1', tool: 'Agent', input: { description: 'x' }, agentId: 'a1', text: 'Async agent launched successfully.' },
        { tool_use_id: 't2', tool: 'Agent', input: { description: 'y' }, agentId: 'a2', text: 'Async agent launched successfully.' },
      ],
    },
  ]
  const finished = applyAgentUpdates(applyMessages(EMPTY, rows, undefined), { a1: { status: 'done', report: 'Result' } })
  const notes = agentNotes(finished)

  expect(notes).toEqual({ t1: { status: 'done', agentId: 'a1', report: 'Result' } })

  // After a restart: the transcript shows only the launch, but the notes restore completion and the report.
  const restored = applyAgentNotes(applyMessages(EMPTY, rows, undefined), notes)
  expect(restored.plans[0]?.steps[0]?.agents?.map(run => [run.status, run.report])).toEqual([
    ['done', 'Result'],
    ['running', undefined],
  ])
})

test('the notes file is validated on read, and contains no message or plan text when written', async () => {
  const text = serializeNotes({ sessionId: 's1', times: { p1: 1000 }, agents: { t1: { status: 'done', report: 'r' } } }, 5000)

  expect(JSON.parse(text)).toEqual({ format: 1, sessionId: 's1', savedAt: 5000, times: { p1: 1000 }, agents: { t1: { status: 'done', report: 'r' } } })
  expect(parseNotesFile(text, 's1')).toEqual({ sessionId: 's1', times: { p1: 1000 }, agents: { t1: { status: 'done', report: 'r' } } })
  expect(parseNotesFile('{ broken', 's1')).toBeUndefined()
  expect(parseNotesFile('{"format":2,"times":{},"agents":{}}', 's1')).toBeUndefined()
  // Only malformed values are discarded.
  expect(parseNotesFile('{"format":1,"times":{"p1":"x","p2":2},"agents":{"t1":{"status":"running"}}}', 's1')).toEqual({
    sessionId: 's1',
    times: { p2: 2 },
    agents: {},
  })
})

test('the period is written with the offset applied, omitting the end date on the same day', async () => {
  const at = (iso: string) => Date.parse(iso)
  const jst = 9 * 60

  expect(formatPeriod(at('2026-11-15T11:26:00Z'), at('2026-11-15T11:28:30Z'), 0, jst)).toBe('2026-11-15 20:26 – 20:28 (3m)')
  expect(formatPeriod(at('2026-11-15T14:58:00Z'), at('2026-11-15T15:03:00Z'), 0, jst)).toBe('2026-11-15 23:58 – 2026-11-16 00:03 (5m)')
  expect(formatPeriod(at('2026-11-15T11:26:00Z'), undefined, at('2026-11-15T11:29:00Z'), jst)).toBe('2026-11-15 20:26 – (elapsed 3m)')
  expect(formatPeriod(undefined, undefined, 0, jst)).toBe('')
  expect(parseUtcOffset('+0900\n')).toBe(540)
  expect(parseUtcOffset('-0430')).toBe(-270)
  expect(parseUtcOffset('JST')).toBeUndefined()
  expect(shortId('4c610300-97b4-4cf5-8cfb-650938607fcb')).toBe('4c610300')
})

test('a recap with an unknown end time keeps no end time', async () => {
  let t = applyToolUse(EMPTY, plan('p1', { items: [{ content: 'A', status: 'in_progress' }], scope: 'first_task' }), undefined)
  t = applyToolUse(t, { tool_use_id: 'w1', tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'Finished' } }, undefined)

  expect(t.plans[0]?.recap).toBe('Finished')
  expect(t.plans[0]?.endedAt).toBeUndefined()
})

const wrap = (id: string, recap: string) => ({ tool_use_id: id, tool: 'mcp__ccd_turn__wrap_up', input: { recap } })

test('builds a turn per user message and links its plan, recap and answer', async () => {
  const rows = [
    { role: 'user', text: 'First request', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [plan('p1', { items: [{ content: 'A', status: 'in_progress' }], scope: 'first_task' })] },
    { role: 'assistant', text: 'All done', toolUses: [wrap('w1', 'Plan recap')] },
    { role: 'user', text: 'Do I need an icon?', toolUses: [] },
    { role: 'user', text: '[Image: source: /tmp/1.png]', toolUses: [] },
    { role: 'assistant', text: 'It is not required.\nThe reason is…', toolUses: [] },
    { role: 'user', text: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>', toolUses: [] },
    { role: 'assistant', text: 'The report arrived', toolUses: [] },
    { role: 'user', text: 'It opened', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [wrap('w2', 'Confirmed')] },
  ]
  const { turns, planIndex } = deriveTurns(rows)

  expect(planIndex).toEqual({ p1: 1 })
  expect(turns.map(turn => [turn.index, turn.trigger.text, turn.trigger.images, turn.planId, turn.recap, turn.answer, turn.isLatest])).toEqual([
    [0, 'First request', 0, 'p1', 'Plan recap', 'All done', false],
    // The response after the notice (The report arrived) is not taken as this turn's answer.
    [3, 'Do I need an icon?', 1, undefined, undefined, 'It is not required.\nThe reason is…', false],
    [8, 'It opened', 0, undefined, 'Confirmed', undefined, true],
  ])
  expect(turns[2]?.wrapId).toBe('w2')
})

test('a recap or task list from a turn that made no plan is not attached to the previous turn\'s plan', async () => {
  const rows = [
    { role: 'user', text: 'Request 1', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [plan('p1', { items: [{ content: 'A', status: 'in_progress' }], scope: 'first_task' })] },
    // The turn ended without a recap.
    { role: 'user', text: 'Question', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [wrap('w1', 'Recap for the question')] },
    { role: 'user', text: 'Request 2', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [plan('p2', { items: [{ content: 'B', status: 'in_progress' }], scope: 'continuation' })] },
  ]
  const t = applyMessages(EMPTY, rows, undefined)

  expect(t.plans.map(p => [p.id, p.recap, p.steps.map(step => step.text)])).toEqual([
    ['p1', undefined, ['A']],
    ['p2', undefined, ['B']],
  ])
})

test('a turn that is only a slash command with no response is not made into a card', async () => {
  const rows = [
    { role: 'user', text: '<command-name>/cc-task-timeline-view</command-name>\n<command-args></command-args>', toolUses: [] },
    { role: 'user', text: '<local-command-caveat>…</local-command-caveat>', toolUses: [] },
    { role: 'user', text: 'It opened', toolUses: [] },
    { role: 'assistant', text: 'Glad to hear it', toolUses: [] },
    { role: 'user', text: '<command-name>/code-review</command-name>', toolUses: [] },
    { role: 'assistant', text: 'Reviewed it', toolUses: [] },
  ]

  expect(deriveTurns(rows).turns.map(turn => turn.trigger.text)).toEqual(['It opened', '/code-review'])
})
