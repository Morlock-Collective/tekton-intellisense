import { isScalar, isSeq } from "yaml";
import { ParsedTektonDoc, findEnclosingTaskEntry } from "./model";
import { paramRefsIn } from "./paramRefs";

export interface MissingRunAfter {
  /** the task whose runAfter is missing an entry */
  taskName: string;
  /** anchor range for a diagnostic — the task's own name field */
  taskNameRange: [number, number];
  /** the referenced task name that isn't listed in runAfter */
  missingTaskRef: string;
}

/**
 * Tekton infers a task's run order automatically from any
 * `$(tasks.X.results.Y)` reference within it (in `params`, `when`,
 * `matrix`, ...) — `runAfter` isn't required for correctness here.
 * Finds cases where a task references another task's result without also
 * listing it in `runAfter`: not a bug, just a readability gap some authors
 * want closed — the ordering is real either way, this only makes it
 * visible without cross-referencing every param value to find the DAG.
 */
export function findMissingRunAfter(parsed: ParsedTektonDoc): MissingRunAfter[] {
  if (parsed.symbols.kind !== "Pipeline") return [];

  const results: MissingRunAfter[] = [];
  const allRefs = paramRefsIn(parsed);
  const taskNames = new Set(parsed.symbols.tasks.map((t) => t.name));

  for (const taskEntry of parsed.symbols.tasks) {
    if (!taskEntry.range) continue;
    const entryMap = findEnclosingTaskEntry(parsed, taskEntry.range[0]);
    if (!entryMap?.range) continue;
    const [entryStart, , entryEnd] = entryMap.range;

    const referenced = new Set<string>();
    for (const ref of allRefs) {
      if (ref.kind !== "task-result" || !ref.name) continue;
      if (ref.start < entryStart || ref.end > entryEnd) continue; // must belong to this task entry's own subtree
      if (ref.name === taskEntry.name) continue; // self-reference isn't meaningful here
      if (!taskNames.has(ref.name)) continue; // unknown task — already flagged by the "unknown task" check
      referenced.add(ref.name);
    }
    if (referenced.size === 0) continue;

    const runAfterNode = entryMap.get("runAfter", true);
    const existing = new Set<string>();
    if (isSeq(runAfterNode)) {
      for (const item of runAfterNode.items) {
        if (isScalar(item) && typeof item.value === "string") existing.add(item.value);
      }
    }

    for (const missingTaskRef of referenced) {
      if (existing.has(missingTaskRef)) continue;
      results.push({ taskName: taskEntry.name, taskNameRange: taskEntry.range, missingTaskRef });
    }
  }

  return results;
}
