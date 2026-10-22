import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

export interface QuestionEntry {
  opencodeId: string
  rpcId: string
  sessionId: string
  items: AskUserQuestionItem[]
}

/** One selectable option of a dsh question. */
export interface QuestionOption {
  label: string
  description: string
}

/** One question of a dsh question batch. */
export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
}

/** A dsh question batch as the bridge publishes it. */
export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

function toQuestionInfo(item: AskUserQuestionItem): QuestionInfo {
  return {
    question: item.question,
    header: item.header ?? '',
    options: (item.options ?? []).map((option) => ({
      label: option.label,
      description: option.description ?? '',
    })),
    ...(item.multiSelect === undefined ? {} : { multiple: item.multiSelect }),
  }
}

/** The 1.18.18 question projection the SSE stream still publishes. */
export function toQuestionRequest(entry: QuestionEntry): QuestionRequest {
  return {
    id: entry.opencodeId,
    sessionID: entry.sessionId,
    questions: entry.items.map(toQuestionInfo),
  }
}

/** v2 `/api/session/{id}/question` shape. */
export function toQuestionV2(entry: QuestionEntry): QuestionRequest {
  return {
    id: entry.opencodeId,
    sessionID: entry.sessionId,
    questions: entry.items.map(toQuestionInfo),
  }
}

/**
 * The OpenCode 2.x form of a dsh question batch. 2.x replaced the question
 * tool with typed forms, so every dsh question becomes one multi-select field
 * (a single-select question keeps `maxItems: 1`).
 */
export function toFormInfo(entry: QuestionEntry): {
  id: string
  sessionID: string
  title: string
  fields: Array<Record<string, unknown>>
} {
  const first = entry.items[0]
  return {
    id: entry.opencodeId,
    sessionID: entry.sessionId,
    title: first?.header || first?.question || 'Question',
    fields: entry.items.map((item) => ({
      key: item.id,
      title: item.question,
      type: 'multiselect',
      options: (item.options ?? []).map((option) => ({
        value: option.label,
        label: option.label,
      })),
      ...(item.multiSelect === true ? {} : { maxItems: 1 }),
    })),
  }
}

/** The OpenCode 2.x answer of a dsh question batch, keyed by question id. */
export function toFormAnswer(
  entry: QuestionEntry,
  answers: ReadonlyArray<ReadonlyArray<string>> | undefined,
): Record<string, unknown> {
  const answer: Record<string, unknown> = {}
  entry.items.forEach((item, index) => {
    answer[item.id] = answers?.[index] ?? []
  })
  return answer
}

/**
 * Map opencode answers (labels in question order) back to dsh answer items.
 * dsh asks one batch; opencode answers each question positionally.
 */
export function answersToDsh(
  entry: QuestionEntry,
  answers: Array<Array<string>>,
): Array<{ id: string; selected: string[]; custom?: string }> {
  return entry.items.map((item, index) => {
    const selected = answers[index] ?? []
    return {
      id: item.id,
      selected,
    }
  })
}
