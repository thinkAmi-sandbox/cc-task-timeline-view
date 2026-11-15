# cc-task-timeline-view

A Claude Code mod that shows what Claude has been doing as a timeline, in a pane beside the conversation in the Claude desktop app (Code tab).

It only reads what the app already records, the task list and the recap at the end of each turn, from the conversation record. **It adds nothing to the model**: no tools, no additions to the prompt, and no extra model calls. The model behaves exactly as it would without the mod, and the mod spends no tokens.

## What it shows

### A card for each plan

Each turn in which Claude made a task list gets one card. The newest card is at the top.

- **Header**: the state (In progress or Done) and the period, such as `Done · 2026-11-15 20:26 – 20:28 (2m)` or `In progress · 2026-11-15 20:26 – (elapsed 3m)`
- **Prompt**: what you wrote to start the turn. A long prompt shows its beginning, and `▸ More` expands it. Attached images are noted, as in `(1 image)`
- **Progress**: a bar of the completed steps
- **Steps**: each step with its state (✓ done, ▶ in progress, · pending). `▸ n items` at the end of a row expands the work done during that step, such as a command's description, a URL or the name of an edited file. The step in progress starts expanded
- **Subagents**: for each subagent launched during a step, its state (… running, ✓ done, ✗ failed) and the first line of its report
- **Summary**: the recap Claude wrote at the end of the turn

### A small card for a turn without a task list

A turn in which Claude made no task list, such as a short answer to a question, gets a smaller card.

- **Header**: `Answer only`, with the time when the turn has a recap, or `Answering` while Claude is still working on it
- **Prompt**: as on a plan card
- **Summary or answer**: the recap when there is one, otherwise the first line of the answer

A slash command that got no answer, and a short reply to a notification or a subagent's report, get no card.

### Other

- **Session ID**: the first 8 characters, at the top of the pane (such as `4c610300`)
- **Copy**: `⧉` beside the prompt, the summary, the answer, a report or the session ID copies the whole text to the clipboard. Text in the pane can't be selected and copied, so these buttons do it instead
- **Number of cards**: the 10 newest

## Requirements

- The Code tab of the Claude desktop app
- Claude Code v2.1.290 or later (mods need it). Tested with v2.1.325
- macOS (the mod runs `date` to find the local time zone)

## Install

At the prompt of a terminal session:

```text
/plugin install cc-task-timeline-view --marketplace thinkAmi-sandbox/cc-task-timeline-view
```

Answer `y` to add the marketplace, then choose the user scope.

From a shell:

```bash
claude plugin install cc-task-timeline-view --marketplace thinkAmi-sandbox/cc-task-timeline-view
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `thinkAmi-sandbox/cc-task-timeline-view`, then Add plugin.

Sessions started after the install load the mod. In a session that is already open, run `/reload-plugins`.

## Use

- The pane opens beside the conversation when a session starts
- If you close it, run `/cc-task-timeline-view` to open it again

## How it works

| What is shown | Where it comes from |
|---|---|
| Plans, steps, work and summaries | The app's task list (`update_plan`), the recap at the end of a turn (`wrap_up`) and the tool calls, in the conversation record (`$.session.messages()`) |
| Prompts and answers | Your messages and Claude's answers, in the conversation record |
| Subagents' states and reports | `$.agent.list()` and each subagent's own conversation (`$.session.messages({ agentId })`) |
| Start and end times | The notes file (below) |

The conversation record is the source of truth: the timeline is rebuilt from it every time it is read.

### The notes file

The mod saves only the facts that the conversation record's API cannot give back, one JSON file per session.

- Location: `~/.claude/cc-task-timeline-view/sessions/<session id>.json` (under `$CLAUDE_CONFIG_DIR` instead when it is set)
- Contents:
  - `times`: the time the mod saw each task list call and each recap call, by tool call id
  - `agents`: each finished subagent's state and the first line of its report, by tool call id
- **It does not save your prompts, the text of plans and steps, the work, or the summaries**

The file is a disposable annotation. If it is missing or broken, the timeline still comes from the conversation record; only the times and the subagents' results are not shown.

## Limitations

- **Desktop app only**: the task list and the recaps come from tools of the desktop app's Code tab. In a terminal `claude` session there is nothing to show
- **Unpublished internals**: the app's tool names (`mcp__ccd_turn__update_plan`, `mcp__ccd_turn__wrap_up`) and their inputs are internal and undocumented. An app update can change them, and the timeline would then stay empty
- **Times**: only for the calls the mod saw while it was running. Turns from before the install are shown without times
- **Length of the conversation**: `$.session.messages()` returns the newest 4,096 messages. When a very long session is reopened, older cards are not shown
- **Reading cost**: the API has no way to read only what is new, so the mod reads the whole conversation after each tool call and at the end of each turn. In a very long session, the pane can update late
- **Inside subagents**: the tools a subagent used are not shown, and only the first line of its report is
- **Old files stay**: a mod cannot delete files, so the notes files add up, one per session (a few KB each)
- **Buttons**: the desktop app draws buttons with its own frame, so `▸ n items` and `⧉` have one
- **Not yet tried in the app**: the display after `/compact`, `/clear`, `/resume` and `/branch` is covered by tests but has not been checked in the desktop app

## Develop

```text
.claude-plugin/
  plugin.json        the mod's manifest
  marketplace.json   makes this repository a marketplace
hooks/
  hooks.json         names the hooks module
  register.tsx       hooks, reading, the notes file, and drawing the pane
  timeline.ts        pure functions that build the timeline from the conversation record
  *.test.ts(x)       tests
types/
  index.d.ts         types of the mod's state
```

Run the tests and the checks:

```bash
claude plugin test .
```

```bash
claude plugin validate .
```

## License

[MIT](LICENSE)
