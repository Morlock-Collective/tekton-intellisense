import * as vscode from "vscode";
import { parseTektonFile, findResourceAt, ParsedTektonDoc, TektonKind, TASK_LIKE_KINDS, TRIGGER_BINDING_LIKE_KINDS } from "./model";
import {
  resolveRenameTarget,
  RenameTarget,
  TextEdit,
  sameDocumentEdits,
  sameDocumentResultEdits,
  taskResultReferenceEdits,
  taskParamReferenceEdits,
  taskRefIdentityEdits,
  pipelineRefIdentityEdits,
  templateRefIdentityEdits,
  bindingRefIdentityEdits,
  triggerRefIdentityEdits,
} from "./renameTarget";
import { TektonWorkspaceIndex, IndexedResource } from "./workspaceIndex";
import { findWorkspaceDocs } from "./workspaceScan";
import { toVscodeRange } from "./rangeUtils";

const PIPELINE_KIND: ReadonlySet<TektonKind> = new Set(["Pipeline"]);
const TEMPLATE_KIND: ReadonlySet<TektonKind> = new Set(["TriggerTemplate"]);
const TRIGGER_KIND: ReadonlySet<TektonKind> = new Set(["Trigger"]);

function addEdits(workspaceEdit: vscode.WorkspaceEdit, uri: vscode.Uri, parsed: ParsedTektonDoc, edits: TextEdit[]): void {
  for (const e of edits) {
    workspaceEdit.replace(uri, toVscodeRange(parsed, e.range), e.newText);
  }
}

function isValidNewName(kind: RenameTarget["kind"], newName: string): boolean {
  if (!newName) return false;
  // metadata.name (a resource's own identity) is a Kubernetes resource name — stricter than the rest.
  if (kind === "task-identity" || kind === "pipeline-identity" || kind === "template-identity" || kind === "binding-identity" || kind === "trigger-identity") {
    return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(newName);
  }
  return /^[A-Za-z0-9_-]+$/.test(newName);
}

type SameDocKind = "param" | "workspace" | "task-alias" | "result";

function declListFor(parsed: ParsedTektonDoc, kind: SameDocKind) {
  switch (kind) {
    case "param":
      return parsed.symbols.params;
    case "workspace":
      return parsed.symbols.workspaces;
    case "task-alias":
      return parsed.symbols.tasks;
    case "result":
      return parsed.symbols.results;
  }
}

/** Throws if `newName` is already used by a different entity of the same kind in the same document — schema validation would reject the collision anyway. */
function assertNoLocalCollision(parsed: ParsedTektonDoc, kind: SameDocKind, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const label = kind === "task-alias" ? "task" : kind;
  if (declListFor(parsed, kind).some((s) => s.name === newName)) {
    throw new Error(`Tekton Intellisense: "${newName}" is already used by another ${label} in this document.`);
  }
}

/**
 * Resolves a name to exactly one workspace record, or throws. Used when
 * resolving *from a reference* (not the declaration): an ambiguous name
 * can't be resolved to a single target, and guessing risks rewriting the
 * wrong file while leaving the clicked reference unchanged.
 */
function resolveUnambiguous(candidates: IndexedResource[], name: string, kindLabel: string): IndexedResource {
  if (candidates.length === 0) {
    throw new Error(`Tekton Intellisense: can't rename — no ${kindLabel} named "${name}" is indexed in this workspace.`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Tekton Intellisense: can't rename — "${name}" is declared by ${candidates.length} different ${kindLabel} files, so it's ambiguous which one this reference means. Rename the declaration directly, or make the name unique first.`
    );
  }
  return candidates[0];
}

/** A document kind that can reference an identity by name, and how to find/edit those references within one such document. */
interface IdentityReferenceScan {
  kinds: TektonKind[];
  findEdits: (parsed: ParsedTektonDoc, oldName: string, newName: string) => TextEdit[];
}

/**
 * F2 rename. Same-document entities (params, workspaces, task aliases)
 * rename in isolation. A Task's own result and a resource's own identity
 * (`taskRef`/`pipelineRef`/`template.ref`/`bindings[].ref`/`triggerRef`)
 * rename workspace-wide by default, unless the name is ambiguous (two files
 * sharing a `metadata.name` — a vendored Task present in more than one
 * chart is a real case), in which case cross-file updates are skipped with
 * an explanation instead of guessed.
 */
export class TektonRenameProvider implements vscode.RenameProvider {
  constructor(private readonly workspaceIndex: TektonWorkspaceIndex) {}

  prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
    const offset = document.offsetAt(position);
    const parsed = findResourceAt(parseTektonFile(document.getText()), offset);
    if (!parsed) throw new Error("Tekton Intellisense: this isn't a Tekton resource.");

    const target = resolveRenameTarget(parsed, offset);
    if (!target) throw new Error("Tekton Intellisense: nothing renameable here.");

    return toVscodeRange(parsed, target.range);
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const offset = document.offsetAt(position);
    const parsed = findResourceAt(parseTektonFile(document.getText()), offset);
    if (!parsed) return undefined;

    const target = resolveRenameTarget(parsed, offset);
    if (!target) return undefined;

    if (!isValidNewName(target.kind, newName)) {
      throw new Error(`Tekton Intellisense: "${newName}" isn't a valid name.`);
    }

    const edit = new vscode.WorkspaceEdit();

    switch (target.kind) {
      case "workspace":
      case "task-alias": {
        assertNoLocalCollision(parsed, target.kind, target.name, newName);
        addEdits(edit, document.uri, parsed, sameDocumentEdits(parsed, target.kind, target.name, newName));
        return edit;
      }

      case "param": {
        assertNoLocalCollision(parsed, "param", target.name, newName);
        addEdits(edit, document.uri, parsed, sameDocumentEdits(parsed, "param", target.name, newName));
        // Only a Task/ClusterTask's own declared param can be bound from elsewhere (via taskRef) --
        // a Pipeline's own param has no such cross-file binding in scope here (see task-param below).
        if (parsed.symbols.kind === "Task" || parsed.symbols.kind === "ClusterTask") {
          await this.addCrossFileParamEdits(edit, parsed, target.name, newName);
        }
        return edit;
      }

      case "task-param": {
        // Invoked on a Pipeline task entry's or TaskRun's own params: [{name, value}] binding --
        // resolve the real Task the binding belongs to. Reference-resolved, so an ambiguous
        // taskRefName must reject outright (see resolveUnambiguous).
        const record = resolveUnambiguous(this.workspaceIndex.lookupAllTaskRecords(target.taskRefName), target.taskRefName, "Task");
        assertNoLocalCollision(record.parsed, "param", target.paramName, newName);
        addEdits(edit, record.uri, record.parsed, sameDocumentEdits(record.parsed, "param", target.paramName, newName));
        await this.addCrossFileParamEdits(edit, record.parsed, target.paramName, newName);
        return edit;
      }

      case "result": {
        assertNoLocalCollision(parsed, "result", target.name, newName);
        addEdits(edit, document.uri, parsed, sameDocumentResultEdits(parsed, target.name, newName));
        await this.addCrossFileResultEdits(edit, parsed, target.name, newName);
        return edit;
      }

      case "task-result": {
        // Invoked on some Pipeline's $(tasks.X.results.Y) — resolve the real Task Y belongs to.
        // Reference-resolved, so an ambiguous taskRefName must reject outright (see resolveUnambiguous).
        if (!target.taskEntry.taskRefName) {
          throw new Error(`Tekton Intellisense: can't rename — this pipeline task has no taskRef.`);
        }
        const record = resolveUnambiguous(
          this.workspaceIndex.lookupAllTaskRecords(target.taskEntry.taskRefName),
          target.taskEntry.taskRefName,
          "Task"
        );
        assertNoLocalCollision(record.parsed, "result", target.resultName, newName);
        addEdits(edit, record.uri, record.parsed, sameDocumentResultEdits(record.parsed, target.resultName, newName));
        await this.addCrossFileResultEdits(edit, record.parsed, target.resultName, newName);
        return edit;
      }

      case "task-identity":
        return this.renameIdentityAcrossWorkspace(
          edit,
          document,
          parsed,
          target.name,
          newName,
          TASK_LIKE_KINDS,
          (idx, n) => idx.lookupAllTaskRecords(n),
          "Task/ClusterTask/StepAction",
          "Task",
          // Task/ClusterTask included alongside Pipeline/TaskRun because a step's own `ref:`
          // (pointing at a shared StepAction) can appear inside any of them, not just inline
          // taskSpecs -- StepAction itself is omitted, since a StepAction resource has no
          // steps of its own to search.
          [{ kinds: ["Pipeline", "TaskRun", "Task", "ClusterTask"], findEdits: taskRefIdentityEdits }]
        );

      case "pipeline-identity":
        return this.renameIdentityAcrossWorkspace(
          edit,
          document,
          parsed,
          target.name,
          newName,
          PIPELINE_KIND,
          (idx, n) => idx.lookupAllPipelineRecords(n),
          "Pipeline",
          "Pipeline",
          [{ kinds: ["PipelineRun"], findEdits: pipelineRefIdentityEdits }]
        );

      case "template-identity":
        return this.renameIdentityAcrossWorkspace(
          edit,
          document,
          parsed,
          target.name,
          newName,
          TEMPLATE_KIND,
          (idx, n) => idx.lookupAllTriggerTemplateRecords(n),
          "TriggerTemplate",
          "TriggerTemplate",
          [{ kinds: ["EventListener", "Trigger"], findEdits: templateRefIdentityEdits }]
        );

      case "binding-identity":
        return this.renameIdentityAcrossWorkspace(
          edit,
          document,
          parsed,
          target.name,
          newName,
          TRIGGER_BINDING_LIKE_KINDS,
          (idx, n) => idx.lookupAllTriggerBindingRecords(n),
          "TriggerBinding/ClusterTriggerBinding",
          "TriggerBinding",
          [{ kinds: ["EventListener", "Trigger"], findEdits: bindingRefIdentityEdits }]
        );

      case "trigger-identity":
        return this.renameIdentityAcrossWorkspace(
          edit,
          document,
          parsed,
          target.name,
          newName,
          TRIGGER_KIND,
          (idx, n) => idx.lookupAllTriggerRecords(n),
          "Trigger",
          "Trigger",
          [{ kinds: ["EventListener"], findEdits: triggerRefIdentityEdits }]
        );
    }
  }

  /**
   * Invoked directly on the declaration, the target file is unambiguous
   * by construction (it's the one open). Only resolving *from a
   * reference* makes an ambiguous name a problem — see {@link resolveUnambiguous}.
   */
  private resolveIdentityRecord(
    document: vscode.TextDocument,
    parsed: ParsedTektonDoc,
    name: string,
    ownKinds: ReadonlySet<TektonKind>,
    lookupAll: (index: TektonWorkspaceIndex, name: string) => IndexedResource[],
    kindLabel: string
  ): IndexedResource {
    if (parsed.symbols.metadataName === name && ownKinds.has(parsed.symbols.kind)) {
      return { uri: document.uri, parsed };
    }
    return resolveUnambiguous(lookupAll(this.workspaceIndex, name), name, kindLabel);
  }

  /**
   * Shared orchestration for renaming a cross-file identity name (a
   * resource's own `metadata.name`, referenced elsewhere by
   * taskRef/pipelineRef/template.ref/bindings[].ref/triggerRef): apply the
   * declaration edit, warn on a new-name collision or on an ambiguous
   * *declaration* (renamed from the one unambiguous file, but other files
   * sharing the old name are left alone), then scan and edit every
   * referencing document. The pieces that differ per identity kind — which
   * documents count as "own", how to resolve a reference, which doc kinds
   * reference it and how to edit them — are passed in, since this one shape
   * now serves 5 identity kinds (Task, Pipeline, TriggerTemplate,
   * TriggerBinding-family, Trigger).
   */
  private async renameIdentityAcrossWorkspace(
    edit: vscode.WorkspaceEdit,
    document: vscode.TextDocument,
    parsed: ParsedTektonDoc,
    name: string,
    newName: string,
    ownKinds: ReadonlySet<TektonKind>,
    lookupAll: (index: TektonWorkspaceIndex, name: string) => IndexedResource[],
    resolveLabel: string,
    fileLabel: string,
    referencingScans: IdentityReferenceScan[]
  ): Promise<vscode.WorkspaceEdit> {
    const record = this.resolveIdentityRecord(document, parsed, name, ownKinds, lookupAll, resolveLabel);

    const nameRange = record.parsed.symbols.metadataNameRange;
    if (nameRange) addEdits(edit, record.uri, record.parsed, [{ range: nameRange, newText: newName }]);

    if (lookupAll(this.workspaceIndex, newName).length > 0) {
      void vscode.window.showWarningMessage(
        `Tekton Intellisense: "${newName}" is already used by another ${fileLabel} file — you now have two ${fileLabel} resources sharing a name, which references to it can't tell apart.`
      );
    }

    const sameName = lookupAll(this.workspaceIndex, name);
    if (sameName.length > 1) {
      void vscode.window.showWarningMessage(
        `Tekton Intellisense: "${name}" is declared by ${sameName.length} different ${fileLabel} files — only the one you renamed from was updated. Update references elsewhere by hand if needed.`
      );
      return edit;
    }

    for (const scan of referencingScans) {
      const referencingDocs = await findWorkspaceDocs(scan.kinds);
      for (const { uri, parsed: refParsed } of referencingDocs) {
        addEdits(edit, uri, refParsed, scan.findEdits(refParsed, name, newName));
      }
    }
    return edit;
  }

  private async addCrossFileResultEdits(
    edit: vscode.WorkspaceEdit,
    taskParsed: ParsedTektonDoc,
    resultName: string,
    newName: string
  ): Promise<void> {
    const taskName = taskParsed.symbols.metadataName;
    if (!taskName) return;

    const sameName = this.workspaceIndex.lookupAllTaskRecords(taskName);
    if (sameName.length > 1) {
      void vscode.window.showWarningMessage(
        `Tekton Intellisense: "${taskName}" is declared by ${sameName.length} different Task files — only this file's own $(results.${resultName}...) uses were updated. Update $(tasks.*.results.${resultName}) references in Pipelines by hand if needed.`
      );
      return;
    }

    const pipelines = await findWorkspaceDocs(["Pipeline"]);
    for (const { uri, parsed } of pipelines) {
      for (const taskEntry of parsed.symbols.tasks) {
        if (taskEntry.taskRefName !== taskName) continue;
        addEdits(edit, uri, parsed, taskResultReferenceEdits(parsed, taskEntry.name, resultName, newName));
      }
    }
  }

  /**
   * Propagates a Task's declared param rename into every `params:
   * [{name, value}]` binding pointing at it via `taskRef` — a Pipeline
   * task entry's (scoped to that one entry) and a TaskRun's own top-level
   * one. Mirrors {@link addCrossFileResultEdits}; doesn't cover a Pipeline
   * task entry using an inline `taskSpec` instead of `taskRef` (its
   * params bind to its own same-document declaration, a different case),
   * nor PipelineRun/Pipeline params (same shape one level up, not yet
   * built).
   */
  private async addCrossFileParamEdits(
    edit: vscode.WorkspaceEdit,
    taskParsed: ParsedTektonDoc,
    paramName: string,
    newName: string
  ): Promise<void> {
    const taskName = taskParsed.symbols.metadataName;
    if (!taskName) return;

    const sameName = this.workspaceIndex.lookupAllTaskRecords(taskName);
    if (sameName.length > 1) {
      void vscode.window.showWarningMessage(
        `Tekton Intellisense: "${taskName}" is declared by ${sameName.length} different Task files — only this file's own param and $(params.${paramName}...) uses were updated. Update param bindings in Pipelines/TaskRuns by hand if needed.`
      );
      return;
    }

    const pipelines = await findWorkspaceDocs(["Pipeline"]);
    for (const { uri, parsed } of pipelines) {
      for (const taskEntry of parsed.symbols.tasks) {
        if (taskEntry.taskRefName !== taskName) continue;
        addEdits(edit, uri, parsed, taskParamReferenceEdits(parsed, taskEntry.name, paramName, newName));
      }
    }

    const taskRuns = await findWorkspaceDocs(["TaskRun"]);
    for (const { uri, parsed } of taskRuns) {
      if (parsed.symbols.taskRefName !== taskName) continue;
      for (const p of parsed.symbols.params) {
        if (p.name === paramName && p.range) addEdits(edit, uri, parsed, [{ range: p.range, newText: newName }]);
      }
    }
  }
}
