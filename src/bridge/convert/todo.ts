import { stableId } from './common.js'

interface DshTodoLike {
  content?: unknown
  status?: unknown
  priority?: unknown
  id?: unknown
}

/**
 * The todo shape the SSE `todo.updated` event carries. OpenCode 2.1.0 has
 * no todo type of its own, so the bridge keeps the 1.x projection locally.
 */
export interface Todo {
  content: string
  status: string
  priority: string
  id: string
}

const PRIORITY = new Set(['high', 'medium', 'low'])

/**
 * Convert dsh todo projection/`todo/write` items into opencode `Todo[]`.
 * dsh items carry no id or priority, so both get stable defaults.
 */
export function convertTodos(value: unknown): Todo[] {
  if (!Array.isArray(value)) return []
  const todos: Todo[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as DshTodoLike
    if (typeof item.content !== 'string') continue
    const status =
      item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed'
        ? item.status
        : 'pending'
    const priority =
      typeof item.priority === 'string' && PRIORITY.has(item.priority) ? item.priority : 'medium'
    todos.push({
      content: item.content,
      status,
      priority,
      id: typeof item.id === 'string' ? item.id : stableId(`${item.content}\0${status}`),
    })
  }
  return todos
}
