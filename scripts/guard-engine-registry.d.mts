// Type declarations for the engine-registry guard (scripts/guard-engine-registry.mjs).
export interface RegistryProblem {
  /** File, plus the declaration inside it, e.g. `src/lib/engines.ts → ENGINE_BIN`. */
  where: string
  /** What is missing and what it costs to leave it missing. */
  why: string
}
/** Body of the first match's capture group, or null when the anchor is gone. */
export function extract(source: string, anchor: RegExp): string | null
/** The ids in ENGINE_IDS, or null when that declaration can no longer be found. */
export function engineIds(engineTs: string): string[] | null
/** Check every engine against every list it has to appear in. */
export function scanRepo(): RegistryProblem[]
