import * as vscode from "vscode";
import { ParsedTektonDoc, parseTektonDocument, TASK_LIKE_KINDS, TRIGGER_BINDING_LIKE_KINDS, TektonKind } from "./model";
import {
  resolveRenameTarget,
  sameDocumentEdits,
  sameDocumentResultEdits,
  taskResultReferenceEdits,
  taskParamReferenceEdits,
  taskRefIdentityEdits,
  pipelineRefIdentityEdits,
  templateRefIdentityEdits,
  bindingRefIdentityEdits,
  triggerRefIdentityEdits,
  TextEdit,
} from "./renameTarget";
import { TektonWorkspaceIndex, IndexedResource } from "./workspaceIndex";
import { findWorkspaceDocs } from "./workspaceScan";
import { toVscodeRange } from "./rangeUtils";

const PIPELINE_KIND: ReadonlySet<TektonKind> = new Set(["Pipeline"]);
const TEMPLATE_KIND: ReadonlySet<TektonKind> = new Set(["TriggerTemplate"]);
const TRIGGER_KIND: ReadonlySet<TektonKind> = new Set(["Trigger"]);

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

/** A document kind that can reference an identity by name, and how to find those references within one such document. */
interface IdentityReferenceScan {
  kinds: TektonKind[];
  findEdits: (parsed: ParsedTektonDoc, oldName: string, newName: string) => TextEdit[];
}

/**
 * Shared orchestration for "Find All References" on a cross-file identity
 * name: the declaration site(s) (if `includeDeclaration`), plus every
 * referencing document, merged and deduped. Read-only, so — unlike
 * rename.ts's equivalent helper — an ambiguous name isn't a reason to hold
 * back: every candidate declaration is included rather than rejected. The
 * pieces that differ per identity kind are passed in, since this one shape
 * now serves 5 identity kinds (Task, Pipeline, TriggerTemplate,
 * TriggerBinding-family, Trigger).
 */
async function collectIdentityReferences(
  document: vscode.TextDocument,
  currentParsed: ParsedTektonDoc,
  name: string,
  ownKinds: ReadonlySet<TektonKind>,
  lookupAllRecords: (name: string) => IndexedResource[],
  includeDeclaration: boolean,
  referencingScans: IdentityReferenceScan[]
): Promise<vscode.Location[]> {
  const locations: vscode.Location[] = [];
  if (includeDeclaration) {
    addIdentityDeclarations(locations, lookupAllRecords(name), document, currentParsed, name, ownKinds);
  }

  for (const scan of referencingScans) {
    const referencingDocs = await findWorkspaceDocs(scan.kinds);
    for (const { uri, parsed: refParsed } of referencingDocs) {
      for (const range of noopRename(scan.findEdits(refParsed, name, name))) {
        locations.push(toLocation(uri, refParsed, range));
      }
    }
  }
  return dedupe(locations);
}

/**
 * "Find All References" (Shift+F12). Same-document entities (params,
 * workspaces, task aliases) are scoped to the current file. A Task's own
 * result and a resource's own identity search the whole workspace,
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

      case "param": {
        addParamReferences(locations, document.uri, parsed, target.name, context.includeDeclaration);
        // Only a Task/ClusterTask's own declared param can be bound from elsewhere (via taskRef) --
        // a Pipeline's own param has no such cross-file binding in scope (see rename.ts).
        if (parsed.symbols.kind === "Task" || parsed.symbols.kind === "ClusterTask") {
          await addCrossFileParamReferences(locations, parsed, target.name);
        }
        return dedupe(locations);
      }

      case "task-param": {
        // Read-only, so an ambiguous taskRefName isn't a reason to hold back -- every matching
        // Task's references are searched and merged, unlike rename.ts's reject-on-ambiguity.
        for (const record of this.workspaceIndex.lookupAllTaskRecords(target.taskRefName)) {
          addParamReferences(locations, record.uri, record.parsed, target.paramName, context.includeDeclaration);
          await addCrossFileParamReferences(locations, record.parsed, target.paramName);
        }
        return dedupe(locations);
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

      case "task-identity":
        return collectIdentityReferences(
          document,
          parsed,
          target.name,
          TASK_LIKE_KINDS,
          (n) => this.workspaceIndex.lookupAllTaskRecords(n),
          context.includeDeclaration,
          // Task/ClusterTask included alongside Pipeline/TaskRun for the same reason as rename.ts's
          // identical scan: a step's own `ref:` (pointing at a shared StepAction) can appear inside
          // any of them, not just inline taskSpecs. StepAction itself is omitted -- it has no steps
          // of its own to search.
          [{ kinds: ["Pipeline", "TaskRun", "Task", "ClusterTask"], findEdits: taskRefIdentityEdits }]
        );

      case "pipeline-identity":
        return collectIdentityReferences(
          document,
          parsed,
          target.name,
          PIPELINE_KIND,
          (n) => this.workspaceIndex.lookupAllPipelineRecords(n),
          context.includeDeclaration,
          [{ kinds: ["PipelineRun"], findEdits: pipelineRefIdentityEdits }]
        );

      case "template-identity":
        return collectIdentityReferences(
          document,
          parsed,
          target.name,
          TEMPLATE_KIND,
          (n) => this.workspaceIndex.lookupAllTriggerTemplateRecords(n),
          context.includeDeclaration,
          [{ kinds: ["EventListener", "Trigger"], findEdits: templateRefIdentityEdits }]
        );

      case "binding-identity":
        return collectIdentityReferences(
          document,
          parsed,
          target.name,
          TRIGGER_BINDING_LIKE_KINDS,
          (n) => this.workspaceIndex.lookupAllTriggerBindingRecords(n),
          context.includeDeclaration,
          [{ kinds: ["EventListener", "Trigger"], findEdits: bindingRefIdentityEdits }]
        );

      case "trigger-identity":
        return collectIdentityReferences(
          document,
          parsed,
          target.name,
          TRIGGER_KIND,
          (n) => this.workspaceIndex.lookupAllTriggerRecords(n),
          context.includeDeclaration,
          [{ kinds: ["EventListener"], findEdits: triggerRefIdentityEdits }]
        );
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

function addParamReferences(
  locations: vscode.Location[],
  uri: vscode.Uri,
  parsed: ParsedTektonDoc,
  paramName: string,
  includeDeclaration: boolean
): void {
  const edits = sameDocumentEdits(parsed, "param", paramName, paramName);
  const declRange = parsed.symbols.params.find((p) => p.name === paramName)?.range;
  for (const range of noopRename(edits)) {
    if (!includeDeclaration && declRange && range[0] === declRange[0] && range[1] === declRange[1]) continue;
    locations.push(toLocation(uri, parsed, range));
  }
}

/** Read-only counterpart to rename.ts's addCrossFileParamEdits — merges every matching Pipeline task entry's and TaskRun's params: binding rather than resolving to one. */
async function addCrossFileParamReferences(locations: vscode.Location[], taskParsed: ParsedTektonDoc, paramName: string): Promise<void> {
  const taskName = taskParsed.symbols.metadataName;
  if (!taskName) return;

  const pipelines = await findWorkspaceDocs(["Pipeline"]);
  for (const { uri, parsed } of pipelines) {
    for (const taskEntry of parsed.symbols.tasks) {
      if (taskEntry.taskRefName !== taskName) continue;
      for (const range of noopRename(taskParamReferenceEdits(parsed, taskEntry.name, paramName, paramName))) {
        locations.push(toLocation(uri, parsed, range));
      }
    }
  }

  const taskRuns = await findWorkspaceDocs(["TaskRun"]);
  for (const { uri, parsed } of taskRuns) {
    if (parsed.symbols.taskRefName !== taskName) continue;
    for (const p of parsed.symbols.params) {
      if (p.name === paramName && p.range) locations.push(toLocation(uri, parsed, p.range));
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
