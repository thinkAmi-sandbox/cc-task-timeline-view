import type { CommandRunInput, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The input when a person types /cc-task-timeline-view.
const TIMELINE_COMMAND: CommandRunInput = {
  command: 'cc-task-timeline-view',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}

const PANE = {
  plugin: 'cc-task-timeline-view',
  component: 'Pane',
  requestId: 'cc-task-timeline-view',
  props: {
    title: 'Timeline',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// A conversation shaped like this session's transcript (the app's task list, work, and recap).
const ROWS: SessionMessage[] = [
  { role: 'user', text: 'Explain the timeline', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      {
        tool_use_id: 'p1',
        tool: 'mcp__ccd_turn__update_plan',
        input: {
          items: [
            { content: 'Check the repository', status: 'in_progress' },
            { content: 'Organize and explain the content', status: 'pending' },
          ],
          scope: 'first_task',
        },
      },
      { tool_use_id: 'b1', tool: 'Bash', input: { command: 'gh repo view', description: 'Fetch repository info' } },
    ],
  },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'p2', tool: 'mcp__ccd_turn__update_plan', input: { advance: true } }],
  },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'w1', tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'Read the README and source and organized them.' } }],
  },
]

test('reads the plan, work and recap from the transcript and draws them on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'cc-task-timeline-view' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: ROWS }))
  on('clock.now', () => ({ value: 1_000_000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // /cc-task-timeline-view waits for the read before opening the Pane. Also check that reading twice adds no duplicates.
  await $.command.run(TIMELINE_COMMAND)
  await $.command.run(TIMELINE_COMMAND)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // Step names are the same plain text whether or not they have work; the button at the end of the row handles toggling.
    expect((await ui.find({ type: 'Text', text: /Check the repository/ }))?.text).toBe('✓ Check the repository')
    expect((await ui.find({ type: 'Text', text: /Organize and explain the content/ }))?.text).toBe('✓ Organize and explain the content')
    expect((await ui.find({ type: 'Text', text: /Summary/ }))?.text).toBe('Summary: Read the README and source and organized them.')
    // A short trigger is shown in full as is, with no toggle button.
    expect((await ui.find({ type: 'Text', text: /Prompt/ }))?.text).toBe('Prompt: Explain the timeline')

    // A done step's work starts closed; pressing the step opens it, and pressing again closes it.
    expect(await ui.find({ type: 'Text', text: /Fetch repository info/ })).toBeUndefined()
    await ui.press({ key: 'p1:0' })
    expect((await ui.find({ type: 'Text', text: /Fetch repository info/ }))?.text).toBe('    · Bash: Fetch repository info')
    await ui.press({ key: 'p1:0' })
    expect(await ui.find({ type: 'Text', text: /Fetch repository info/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /Progress/ }))?.text).toBe('Progress 2/2 done')
    expect(await ui.find({ type: 'Text', text: /…and \d+ more/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('shows a hint when there is no plan yet', async ($, on) => {
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1_000_000 }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe('No plans yet.')
  await ui.unmount()
})

test('shows only the start of a long trigger, toggled with the full-text button', async ($, on) => {
  const long = 'a'.repeat(50) + ' and this part is hidden while collapsed'
  const rows: SessionMessage[] = [
    { role: 'user', text: long, toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 'p1',
          tool: 'mcp__ccd_turn__update_plan',
          input: { items: [{ content: 'Investigate', status: 'in_progress' }], scope: 'first_task' },
        },
      ],
    },
  ]
  on('command.register', () => ({ value: { command: 'cc-task-timeline-view' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: rows }))
  on('clock.now', () => ({ value: 1_000_000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(TIMELINE_COMMAND)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Prompt/ }))?.text).toBe(`Prompt: ${long.slice(0, 60)}…`)
    await ui.press({ key: 'p1:trigger' })
    expect((await ui.find({ type: 'Text', text: /Prompt/ }))?.text).toBe(`Prompt: ${long}`)
    await ui.press({ key: 'p1:trigger' })
    await ui.unmount()
  }
})

test('draws a subagent\'s completion and report next to the row that launched it', async ($, on) => {
  const rows: SessionMessage[] = [
    { role: 'user', text: 'Run 3 agents', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 'p1',
          tool: 'mcp__ccd_turn__update_plan',
          input: { items: [{ content: 'Launch them', status: 'in_progress' }], scope: 'continuation' },
        },
        { tool_use_id: 't1', tool: 'Agent', input: { description: 'Check the defaults' }, agentId: 'a1', text: 'Async agent launched successfully.' },
        { tool_use_id: 't2', tool: 'Agent', input: { description: 'Check the languages' }, agentId: 'a2', text: 'Async agent launched successfully.' },
      ],
    },
    {
      role: 'user',
      text: 'Another Claude session sent a message:\n<agent-message from="a1">\nThe report follows:\n  18 found\n</agent-message>',
      toolUses: [],
    },
  ]
  on('command.register', () => ({ value: { command: 'cc-task-timeline-view' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: rows }))
  on('clock.now', () => ({ value: 1_000_000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(TIMELINE_COMMAND)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // The active step is open, and the number still running shows at the end of the row.
    expect((await ui.find({ type: 'Text', text: /Check the defaults/ }))?.text).toBe('    · Agent: Check the defaults  ✓ done')
    expect((await ui.find({ type: 'Text', text: /Check the languages/ }))?.text).toBe('    · Agent: Check the languages  … running')
    expect((await ui.find({ type: 'Text', text: /18 found/ }))?.text).toBe('18 found')
    expect((await ui.find({ type: 'Text', text: /Prompt/ }))?.text).toBe('Prompt: Run 3 agents')
    await ui.unmount()
  }
})

test('even if report rows never arrive, takes the state from agent.list and the report from the subagent\'s conversation', async ($, on) => {
  // The actual situation this time: the main conversation has only the launches and one completion notice, and no report rows.
  const main: SessionMessage[] = [
    { role: 'user', text: 'Run 3 agents again', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 'p1',
          tool: 'mcp__ccd_turn__update_plan',
          input: { items: [{ content: 'Launch them', status: 'in_progress' }], scope: 'continuation' },
        },
        { tool_use_id: 't1', tool: 'Agent', input: { description: 'Read the README' }, agentId: 'a1', text: 'Async agent launched successfully.' },
        { tool_use_id: 't2', tool: 'Agent', input: { description: 'Read the tools' }, agentId: 'a2', text: 'Async agent launched successfully.' },
        { tool_use_id: 't3', tool: 'Agent', input: { description: 'Count the lines' }, agentId: 'a3', text: 'Async agent launched successfully.' },
      ],
    },
    { role: 'user', text: '<task-notification>\n<task-id>a2</task-id>\n<status>completed</status>\n</task-notification>', toolUses: [] },
  ]
  const children: Record<string, SessionMessage[]> = {
    a1: [
      { role: 'user', text: 'Read the README', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'h1', tool: 'SubagentHandback', input: { report: 'There are 7 headings.\nDetails…' } }],
      },
    ],
    a2: [{ role: 'assistant', text: 'There are 5 tools.', toolUses: [] }],
    a3: [],
  }
  on('command.register', () => ({ value: { command: 'cc-task-timeline-view' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('session.messages', (_, e) => ({ value: e.agentId === undefined ? main : (children[e.agentId] ?? []) }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: 'Read the README', type: 'general-purpose', status: 'completed' },
      { id: 'a2', description: 'Read the tools', type: 'general-purpose', status: 'completed' },
      { id: 'a3', description: 'Count the lines', type: 'general-purpose', status: 'running' },
    ],
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(TIMELINE_COMMAND)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /Read the README/ }))?.text).toBe('    · Agent: Read the README  ✓ done')
  expect((await ui.find({ type: 'Text', text: /headings/ }))?.text).toBe('There are 7 headings.')
  expect((await ui.find({ type: 'Text', text: /Read the tools/ }))?.text).toBe('    · Agent: Read the tools  ✓ done')
  expect((await ui.find({ type: 'Text', text: /5 tools/ }))?.text).toBe('There are 5 tools.')
  expect((await ui.find({ type: 'Text', text: /Count the lines/ }))?.text).toBe('    · Agent: Count the lines  … running')
  await ui.unmount()
})

/** Sets up the environment around the notes file. Written content goes into written. */
function notesEnv(on: Parameters<TestBody>[1], file: string | undefined, written: { path: string; text: string }[]) {
  const path = '/home/u/.claude/cc-task-timeline-view/sessions/sess-1.json'
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: file !== undefined && e.path === path }))
  on('fs.read', () => ({ value: file ?? '' }))
  on('fs.write', (_, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'cc-task-timeline-view' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '+0900\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

test('after a restart, applies the times and subagent results from the notes file to the transcript and draws them', async ($, on) => {
  const rows: SessionMessage[] = [
    { role: 'user', text: 'Investigate this', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 'p1',
          tool: 'mcp__ccd_turn__update_plan',
          input: { items: [{ content: 'Investigate', status: 'in_progress' }], scope: 'first_task' },
        },
        { tool_use_id: 't1', tool: 'Agent', input: { description: 'Check the defaults' }, agentId: 'a1', text: 'Async agent launched successfully.' },
      ],
    },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w1', tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'Investigated' } }] },
  ]
  const file = JSON.stringify({
    format: 1,
    sessionId: 'sess-1',
    savedAt: 0,
    times: { p1: 1_000_000 - 12 * 60000, w1: 1_000_000 - 2 * 60000 },
    agents: { t1: { agentId: 'a1', status: 'done', report: '18 found' } },
  })
  const written: { path: string; text: string }[] = []
  notesEnv(on, file, written)
  on('session.messages', () => ({ value: rows }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(TIMELINE_COMMAND)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Times come back from the notes (started 12 minutes ago, ended 2 minutes ago = 10 minutes). The offset is +0900 from date +%z.
  expect((await ui.find({ type: 'Text', text: /^Done/ }))?.text).toBe('Done · 1970-01-01 09:04 – 09:14 (10m)')
  // Only the start of the session ID is shown (this ID is shorter than 8 characters, so it is shown as is).
  expect((await ui.find({ type: 'Text', text: /Session ID/ }))?.text).toBe('Session ID: sess-1')
  // Even with an empty agent.list, the notes restore completion and the report (the done step is closed, so open it).
  await ui.press({ key: 'p1:0' })
  expect((await ui.find({ type: 'Text', text: /Check the defaults/ }))?.text).toBe('    · Agent: Check the defaults  ✓ done')
  expect((await ui.find({ type: 'Text', text: /18 found/ }))?.text).toBe('18 found')
  // Nothing changed from what was read, so it is not rewritten.
  expect(written).toEqual([])
  await ui.unmount()
})

test('writes only newly observed times, and never writes message or plan text to the file', async ($, on) => {
  const rows: SessionMessage[] = [{ role: 'user', text: 'This is a secret request', toolUses: [] }]
  const written: { path: string; text: string }[] = []
  notesEnv(on, undefined, written)
  on('session.messages', () => ({ value: rows }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(TIMELINE_COMMAND)
  // A plan starts after loading.
  rows.push({
    role: 'assistant',
    text: '',
    toolUses: [
      {
        tool_use_id: 'p9',
        tool: 'mcp__ccd_turn__update_plan',
        input: { items: [{ content: 'Secret procedure', status: 'in_progress' }], scope: 'first_task' },
      },
    ],
  })
  await $.command.run(TIMELINE_COMMAND)

  const last = written.at(-1)
  expect(last?.path).toBe('/home/u/.claude/cc-task-timeline-view/sessions/sess-1.json')
  expect(JSON.parse(last?.text ?? '{}').times).toEqual({ p9: 1_000_000 })
  expect(last?.text.includes('secret')).toBe(false)
  expect(last?.text.includes('Secret procedure')).toBe(false)
})

test('copy buttons put the trigger, recap and report on the clipboard and report the result', async ($, on) => {
  const rows: SessionMessage[] = [
    { role: 'user', text: 'The request text I want to copy', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 'p1',
          tool: 'mcp__ccd_turn__update_plan',
          input: { items: [{ content: 'Investigate', status: 'in_progress' }], scope: 'first_task' },
        },
        { tool_use_id: 't1', tool: 'Agent', input: { description: 'Count' }, agentId: 'a1', text: 'Async agent launched successfully.' },
      ],
    },
    {
      role: 'user',
      text: 'Another Claude session sent a message:\n<agent-message from="a1">\nThe report follows:\n  30 items\n</agent-message>',
      toolUses: [],
    },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w1', tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'This is the summary' } }] },
  ]
  const copied: string[] = []
  const toasts: string[] = []
  let canCopy = true
  on('command.register', () => ({ value: { command: 'cc-task-timeline-view' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: rows }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: canCopy ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(TIMELINE_COMMAND)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'p1:copy-trigger' })
  await ui.press({ key: 'p1:copy-recap' })
  // The report is inside a done step, so open it before pressing.
  await ui.press({ key: 'p1:0' })
  await ui.press({ key: 't1:copy' })
  canCopy = false
  await ui.press({ key: 'p1:copy-recap' })

  expect(copied).toEqual(['The request text I want to copy', 'This is the summary', '30 items', 'This is the summary'])
  expect(toasts).toEqual(['Copied', 'Copied', 'Copied', 'Could not copy (no-clipboard)'])
  await ui.unmount()
})

test('shows only the first 8 characters of the session ID, and copies the full ID', async ($, on) => {
  const id = '4c610300-97b4-4cf5-8cfb-650938607fcb'
  const copied: string[] = []
  on('session.id', () => ({ value: id }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('command.register', () => ({ value: { command: 'cc-task-timeline-view' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Hello', toolUses: [] }] }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(TIMELINE_COMMAND)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Show the session ID at the top even when there is no plan yet.
    expect((await ui.find({ type: 'Text', text: /Session ID/ }))?.text).toBe('Session ID: 4c610300')
    await ui.press({ key: 'session:copy' })
    await ui.unmount()
  }
  expect(copied).toEqual([id, id])
})

test('turns without a task list become small cards with only the trigger and recap (or the start of the answer), in conversation order', async ($, on) => {
  const rows: SessionMessage[] = [
    { role: 'user', text: 'Investigate this', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'p1', tool: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'Investigate', status: 'in_progress' }], scope: 'first_task' } },
      ],
    },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w1', tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'Investigated' } }] },
    { role: 'user', text: 'Do I need an icon?', toolUses: [] },
    { role: 'assistant', text: 'No, it is not required.\nFor details…', toolUses: [] },
    { role: 'user', text: 'It opened', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w2', tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'Confirmed that it opened' } }] },
  ]
  const copied: string[] = []
  on('command.register', () => ({ value: { command: 'cc-task-timeline-view' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: rows }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(TIMELINE_COMMAND)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const heads = await ui.findAll({ type: 'Text', text: /^(Done|Answer only|Answering)/ })
    // Newest first: It opened (has a recap) → the icon question (answer only) → Investigate this (plan).
    expect(heads.map(head => head.text)).toEqual(['Answer only', 'Answer only', 'Done'])
    expect((await ui.find({ type: 'Text', text: /Confirmed/ }))?.text).toBe('Summary: Confirmed that it opened')
    expect((await ui.find({ type: 'Text', text: /^Answer:/ }))?.text).toBe('Answer: No, it is not required.')
    await ui.press({ key: 'turn:3:copy-answer' })
    await ui.unmount()
  }
  // Copying the answer takes the full text.
  expect(copied[0]).toBe('No, it is not required.\nFor details…')
})
