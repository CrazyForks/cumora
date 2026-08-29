/**
 * What a board column MEANS, as opposed to what it is called.
 *
 * `board_columns.kind` is 'todo' | 'doing' | 'done', or null when the column's
 * meaning is unknown — a board named "Backlog / In flight / Shipped" is left
 * unclassified on purpose rather than guessed at.
 *
 * This exists because agents could set a card's assignee but never advance it:
 * `card claim` had no way to know which column was "Doing", so the board sat at
 * Todo while the work was finished and delivered in chat (#69). The decision is
 * a pure function so the one rule that matters — never move a card backwards —
 * is testable without a database.
 */

export type ColumnKind = 'todo' | 'doing' | 'done'

const KINDS: ReadonlySet<string> = new Set<ColumnKind>(['todo', 'doing', 'done'])

export function isColumnKind(v: unknown): v is ColumnKind {
  return typeof v === 'string' && KINDS.has(v)
}

export interface BoardColumn {
  id: string
  position: number
  kind: string | null
}

/** The column a claim should advance the card into, or null to leave it put.
 *
 *  Claiming a card is the moment work starts, so it should read as Doing — that
 *  is the whole ask in #69. But the move only ever goes FORWARD:
 *
 *   - no 'doing' column on this board (custom columns, all unclassified) → stay.
 *     Guessing which column meant Doing is what this feature exists to avoid.
 *   - the card is already in the doing column → stay (no churn, no event).
 *   - the card is in a 'done' column → stay. Re-claiming something finished
 *     must never drag it back into progress; that would rewrite history the
 *     humans on the board can see.
 *   - the card's current column is UNCLASSIFIED → stay. The board is using its
 *     own workflow, and moving a card out of a column we do not understand is
 *     exactly the silent damage the null kind is there to prevent.
 *
 *  With several 'doing' columns, the leftmost (lowest position) wins, so the
 *  choice is deterministic rather than dependent on row order. */
export function claimTargetColumn(args: {
  columns: readonly BoardColumn[]
  currentColumnId: string
}): string | null {
  const current = args.columns.find((c) => c.id === args.currentColumnId)
  // Only advance from a column we understand to be "not started".
  if (!current || current.kind !== 'todo') return null
  const doing = args.columns
    .filter((c) => c.kind === 'doing')
    .sort((a, b) => a.position - b.position)[0]
  if (!doing || doing.id === args.currentColumnId) return null
  return doing.id
}

/** Is this column one where a card counts as finished? Used to describe a
 *  board's shape to an agent, so "move it to a done column" stops being a
 *  guess at column titles. */
export function isDoneColumn(column: Pick<BoardColumn, 'kind'>): boolean {
  return column.kind === 'done'
}
