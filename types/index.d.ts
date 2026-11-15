/** A step's state. Maps to the app's pending / in_progress / completed. */
export type StepStatus = 'pending' | 'active' | 'done'

/** One subagent launched during a step. */
export type AgentRun = {
  /** The id of the Agent tool call that launched it. */
  toolUseId: string
  /** The Agent tool's description. */
  description: string
  /** The launched subagent's id (links it to reports and completion notices). Absent until known. */
  agentId?: string
  status: 'running' | 'done' | 'failed'
  /** The first line of the report. */
  report?: string
}

/** One step of a plan, and the work done during it. */
export type Step = {
  text: string
  status: StepStatus
  /** Observed time (ms). Not kept for entries read from past records, since it is unknown. */
  startedAt?: number
  doneAt?: number
  /** Short descriptions of the tools called during this step (up to 8, newest kept). */
  actions: string[]
  /** Total count, including those that overflowed actions. */
  actionCount: number
  /** Subagents launched during this step. */
  agents?: AgentRun[]
}

/** What started a plan: a user message, or a turn started automatically by a notification etc. */
export type Trigger = {
  kind: 'user' | 'auto'
  /** The original message text (cut if too long). For auto, the kind of notification. */
  text: string
  /** Number of images attached to the message. */
  images: number
}

/** The plan for one request (one update_plan items list). */
export type Plan = {
  id: string
  trigger?: Trigger
  startedAt?: number
  endedAt?: number
  steps: Step[]
  /** The wrap_up recap. */
  recap?: string
}

/** The whole state the Pane draws. */
export type Timeline = {
  plans: Plan[]
  /** tool_use_ids already applied (prevents applying twice). */
  seen: string[]
  /** Whether the first apply after loading (past entries, no times) is done. */
  seeded?: boolean
}

/**
 * A turn that starts from one user message. Rebuilt from the transcript every time
 * (not saved to a file) so that turns without a task list can be shown as small cards.
 */
export type TurnCard = {
  /** Position in the conversation (used for display order). */
  index: number
  trigger: Trigger
  /** The id of the plan made in this turn (the task list call id). Absent for a turn without a task list. */
  planId?: string
  /** This turn's end-of-turn recap, and its call id (to look up the time note). */
  recap?: string
  wrapId?: string
  /** The text of this turn's last answer. */
  answer?: string
  /** No user message comes after this one (the current turn). */
  isLatest: boolean
}

/** Turns built from the transcript, and the plans' positions (row number in the conversation). */
export type Turns = { turns: TurnCard[]; planIndex: Record<string, number> }

/** A finished subagent's result. A fact that is in the transcript but cannot be read through the current API. */
export type AgentNote = {
  agentId?: string
  status: 'done' | 'failed'
  /** The first line of the report. */
  report?: string
}

/**
 * Notes on the transcript. Keys are tool call ids in the transcript; values are only facts
 * that cannot be read from the transcript through the current API. Holds no message or plan text (the transcript is the source of truth).
 */
export type Notes = {
  /** Which session these notes are for. Reloaded when switching to a different session. */
  sessionId?: string
  /** Call id of a task list operation or end-of-turn recap → observed time (ms). */
  times: Record<string, number>
  /** Agent tool call id → the subagent's final result. */
  agents: Record<string, AgentNote>
}

declare module 'claude-code' {
  interface PluginState {
    'cc-task-timeline-view': {
      timeline: Shaped<Timeline>
      /** Notes: those read from the file plus those observed in this session. */
      notes: Shaped<Notes>
      /** This Mac's offset from UTC (minutes). Taken with `date +%z` at startup. null until known. */
      utcOffset: number | null
      /** Turns built from the transcript (rebuilt on every read). */
      turns: Shaped<Turns>
      /** Open/closed state per step (key is `${plan.id}:${step number}`). Holds only those the user toggled. */
      open: Shaped<Record<string, boolean>>
    }
  }
}
