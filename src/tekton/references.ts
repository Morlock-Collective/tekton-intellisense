import * as vscode from "vscode";
import { ParsedTektonDoc, parseTektonDocument, TASK_LIKE_KINDS, TektonKind } from "./model";
import {
  resolveRenameTarget,
  sameDocumentEdits,
  sameDocumentResultEdits,
  taskResultReferenceEdits,
  taskRefIdentityEdits,
  pipelineRefIdentityEdits,
} from "./renameTarget";
import { TektonWorkspaceIndex, IndexedResource } from "./workspaceIndex";
import { findWorkspaceDocs } from "./workspaceScan";
import { toVscodeRange } from "./rangeUtils";

const PIPELINE_KIND: ReadonlySet<TektonKind> = new Set(["Pipeline"]);

function toLocation(uri: vscode.Uri, parsed: ParsedTektonDoc, range: [number, number]): vscode.Location {
  return new vscode.Location(uri, toVscodeRange(parsed, range));
}

/** Renaming-to-itself is a convenient way to reuse renameTarget.ts's edit finders as pure range finders — only .range is used, .newText is discarded. */
function noopRename<T extends { range: [number, number] }>(edits: T[]): [number, number][] {
  return edits.map((e) => e.range);
}

function locationKey(loc: vscode.Location): string {
  return `${loc.uri.toString()}#${loc.range.start.line}:${loc.range.start.character}-${loc.range.end.line}:${loc.range.end.character}`;
}

function dedupe(locations: vscode.Location[]): vscode.Location[] {
  const seen = new Set<string>();
  return locations.filter((loc) => {
    const key = locationKey(loc);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * "Find All References" (Shift+F12). Same-document entities (params,
 * workspaces, task aliases) are scoped to the current file. A Task's own
 * result and a Task/Pipeline's own identity search the whole workspace,
 * resolving the same targets `rename.ts` does — except an ambiguous name
 * is searched across every candidate and merged rather than rejected,
 * since this is read-only.
 */
export class TektonReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly workspaceIndex: TektonWorkspaceIndex) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext
  ): Promise<vscode.Location[] | undefined> {
    const parsed = parseTektonDocument(document.getText());
    if (!parsed) return undefined;

    const target = resolveRenameTarget(parsed, document.offsetAt(position));
    if (!target) return undefined;

    const locations: vscode.Location[] = [];

    switch (target.kind) {
      case "param":
      case "workspace":
      case "task-alias": {
        const declRange = declarationRange(parsed, target.kind, target.name);
        for (const range of noopRename(sameDocumentEdits(parsed, target.kind, target.name, target.name))) {
          // sameDocumentEdits always includes the declaration itself as its first edit.
          if (!context.includeDeclaration && declRange && range[0] === declRange[0] && range[1] === declRange[1]) continue;
          locations.push(toLocation(document.uri, parsed, range));
        }
        return locations;
      }

      case "result": {
        addResultReferences(locations, document.uri, parsed, target.name, context.includeDeclaration);
        await addCrossFileResultReferences(locations, parsed, target.name);
        return dedupe(locations);
      }

      case "task-result": {
        const taskRefName = target.taskEntry.taskRefName;
        if (!taskRefName) return locations;
        for (const record of this.workspaceIndex.lookupAllTaskRecords(taskRefName)) {
          addResultReferences(locations, record.uri, record.parsed, target.resultName, context.includeDeclaration);
          await addCrossFileResultReferences(locations, record.parsed, target.resultName);
        }
        return dedupe(locations);
      }

      case "task-identity": {
        const records = this.workspaceIndex.lookupAllTaskRecords(target.name);
        if (context.includeDeclaration) addIdentityDeclarations(locations, records, document, parsed, target.name, TASK_LIKE_KINDS);
        const referencingDocs = await findWorkspaceDocs(["Pipeline", "TaskRun"]);
        for (const { uri, parsed: refParsed } of referencingDocs) {
          for (const range of noopRename(taskRefIdentityEdits(refParsed, target.name, target.name))) {
            locations.push(toLocation(uri, refParsed, range));
          }
        }
        return dedupe(locations);
      }

      case "pipeline-identity": {
        const records = this.workspaceIndex.lookupAllPipelineRecords(target.name);
        if (context.includeDeclaration) addIdentityDeclarations(locations, records, document, parsed, target.name, PIPELINE_KIND);
        const referencingDocs = await findWorkspaceDocs(["PipelineRun"]);
        for (const { uri, parsed: refParsed } of referencingDocs) {
          for (const range of noopRename(pipelineRefIdentityEdits(refParsed, target.name, target.name))) {
            locations.push(toLocation(uri, refParsed, range));
          }
        }
        return dedupe(locations);
      }
    }
  }
}

function declarationRange(parsed: ParsedTektonDoc, kind: "param" | "workspace" | "task-alias", name: string): [number, number] | undefined {
  const list = kind === "param" ? parsed.symbols.params : kind === "workspace" ? parsed.symbols.workspaces : parsed.symbols.tasks;
  return list.find((s) => s.name === name)?.range;
}

function addResultReferences(
  locations: vscode.Location[],
  uri: vscode.Uri,
  parsed: ParsedTektonDoc,
  resultName: string,
  includeDeclaration: boolean
): void {
  const edits = sameDocumentResultEdits(parsed, resultName, resultName);
  const declRange = parsed.symbols.results.find((r) => r.name === resultName)?.range;
  for (const range of noopRename(edits)) {
    if (!includeDeclaration && declRange && range[0] === declRange[0] && range[1] === declRange[1]) continue;
    locations.push(toLocation(uri, parsed, range));
  }
}

/** Read-only: unlike rename, an ambiguous Task name isn't a reason to hold back — every matching Pipeline's references are searched and merged. */
async function addCrossFileResultReferences(
  locations: vscode.Location[],
  taskParsed: ParsedTektonDoc,
  resultName: string
): Promise<void> {
  const taskName = taskParsed.symbols.metadataName;
  if (!taskName) return;

  const pipelines = await findWorkspaceDocs(["Pipeline"]);
  for (const { uri, parsed } of pipelines) {
    for (const taskEntry of parsed.symbols.tasks) {
      if (taskEntry.taskRefName !== taskName) continue;
      for (const range of noopRename(taskResultReferenceEdits(parsed, taskEntry.name, resultName, resultName))) {
        locations.push(toLocation(uri, parsed, range));
      }
    }
  }
}

function addIdentityDeclarations(
  locations: vscode.Location[],
  records: IndexedResource[],
  document: vscode.TextDocument,
  currentParsed: ParsedTektonDoc,
  name: string,
  ownKinds: ReadonlySet<TektonKind>
): void {
  // The document this was invoked from might not be indexed yet (e.g. an unsaved new file) — include it directly when it IS the declaration.
  if (currentParsed.symbols.metadataName === name && ownKinds.has(currentParsed.symbols.kind) && currentParsed.symbols.metadataNameRange) {
    locations.push(toLocation(document.uri, currentParsed, currentParsed.symbols.metadataNameRange));
  }
  for (const record of records) {
    if (record.uri.toString() === document.uri.toString()) continue; // already added above, from the live buffer
    if (record.parsed.symbols.metadataNameRange) {
      locations.push(toLocation(record.uri, record.parsed, record.parsed.symbols.metadataNameRange));
    }
  }
}
