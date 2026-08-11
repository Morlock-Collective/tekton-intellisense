import * as vscode from "vscode";
import { parseTektonDocument, ParsedTektonDoc, TektonKind, TASK_LIKE_KINDS } from "./model";
import {
  resolveRenameTarget,
  RenameTarget,
  TextEdit,
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

function addEdits(workspaceEdit: vscode.WorkspaceEdit, uri: vscode.Uri, parsed: ParsedTektonDoc, edits: TextEdit[]): void {
  for (const e of edits) {
    workspaceEdit.replace(uri, toVscodeRange(parsed, e.range), e.newText);
  }
}

function isValidNewName(kind: RenameTarget["kind"], newName: string): boolean {
  if (!newName) return false;
  // metadata.name (Task or Pipeline identity) is a Kubernetes resource name — stricter than the rest.
  if (kind === "task-identity" || kind === "pipeline-identity") {
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
    throw new Error(`Tekton Aid: "${newName}" is already used by another ${label} in this document.`);
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
    throw new Error(`Tekton Aid: can't rename — no ${kindLabel} named "${name}" is indexed in this workspace.`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Tekton Aid: can't rename — "${name}" is declared by ${candidates.length} different ${kindLabel} files, so it's ambiguous which one this reference means. Rename the declaration directly, or make the name unique first.`
    );
  }
  return candidates[0];
}

/**
 * F2 rename. Same-document entities (params, workspaces, task aliases)
 * rename in isolation. A Task's own result and a Task/Pipeline's own
 * identity (`taskRef`/`pipelineRef`) rename workspace-wide by default,
 * unless the name is ambiguous (two files sharing a `metadata.name` — a
 * vendored Task present in more than one chart is a real case), in which
 * case cross-file updates are skipped with an explanation instead of
 * guessed.
 */
export class TektonRenameProvider implements vscode.RenameProvider {
  constructor(private readonly workspaceIndex: TektonWorkspaceIndex) {}

  prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
    const parsed = parseTektonDocument(document.getText());
    if (!parsed) throw new Error("Tekton Aid: this isn't a Tekton resource.");

    const target = resolveRenameTarget(parsed, document.offsetAt(position));
    if (!target) throw new Error("Tekton Aid: nothing renameable here.");

    return toVscodeRange(parsed, target.range);
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const parsed = parseTektonDocument(document.getText());
    if (!parsed) return undefined;

    const target = resolveRenameTarget(parsed, document.offsetAt(position));
    if (!target) return undefined;

    if (!isValidNewName(target.kind, newName)) {
      throw new Error(`Tekton Aid: "${newName}" isn't a valid name.`);
    }

    const edit = new vscode.WorkspaceEdit();

    switch (target.kind) {
      case "param":
      case "workspace":
      case "task-alias": {
        assertNoLocalCollision(parsed, target.kind, target.name, newName);
        addEdits(edit, document.uri, parsed, sameDocumentEdits(parsed, target.kind, target.name, newName));
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
          throw new Error(`Tekton Aid: can't rename — this pipeline task has no taskRef.`);
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

      case "task-identity": {
        const record = this.resolveIdentityRecord(
          document,
          parsed,
          target.name,
          TASK_LIKE_KINDS,
          (idx, n) => idx.lookupAllTaskRecords(n),
          "Task/ClusterTask/StepAction"
        );

        const nameRange = record.parsed.symbols.metadataNameRange;
        if (nameRange) addEdits(edit, record.uri, record.parsed, [{ range: nameRange, newText: newName }]);

        if (this.workspaceIndex.lookupAllTaskRecords(newName).length > 0) {
          void vscode.window.showWarningMessage(
            `Tekton Aid: "${newName}" is already used by another Task file — you now have two Tasks sharing a name, which taskRef can't tell apart.`
          );
        }

        const sameName = this.workspaceIndex.lookupAllTaskRecords(target.name);
        if (sameName.length > 1) {
          void vscode.window.showWarningMessage(
            `Tekton Aid: "${target.name}" is declared by ${sameName.length} different Task files — only the one you renamed from was updated. Update taskRef references elsewhere by hand if needed.`
          );
          return edit;
        }

        // Both a Pipeline's per-task taskRef and a TaskRun's own top-level taskRef can point at a Task.
        const referencingDocs = await findWorkspaceDocs(["Pipeline", "TaskRun"]);
        for (const { uri, parsed: refParsed } of referencingDocs) {
          addEdits(edit, uri, refParsed, taskRefIdentityEdits(refParsed, target.name, newName));
        }
        return edit;
      }

      case "pipeline-identity": {
        const record = this.resolveIdentityRecord(
          document,
          parsed,
          target.name,
          PIPELINE_KIND,
          (idx, n) => idx.lookupAllPipelineRecords(n),
          "Pipeline"
        );

        const nameRange = record.parsed.symbols.metadataNameRange;
        if (nameRange) addEdits(edit, record.uri, record.parsed, [{ range: nameRange, newText: newName }]);

        if (this.workspaceIndex.lookupAllPipelineRecords(newName).length > 0) {
          void vscode.window.showWarningMessage(
            `Tekton Aid: "${newName}" is already used by another Pipeline file — you now have two Pipelines sharing a name, which pipelineRef can't tell apart.`
          );
        }

        const sameName = this.workspaceIndex.lookupAllPipelineRecords(target.name);
        if (sameName.length > 1) {
          void vscode.window.showWarningMessage(
            `Tekton Aid: "${target.name}" is declared by ${sameName.length} different Pipeline files — only the one you renamed from was updated. Update pipelineRef references elsewhere by hand if needed.`
          );
          return edit;
        }

        const pipelineRuns = await findWorkspaceDocs(["PipelineRun"]);
        for (const { uri, parsed: runParsed } of pipelineRuns) {
          addEdits(edit, uri, runParsed, pipelineRefIdentityEdits(runParsed, target.name, newName));
        }
        return edit;
      }
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
        `Tekton Aid: "${taskName}" is declared by ${sameName.length} different Task files — only this file's own $(results.${resultName}...) uses were updated. Update $(tasks.*.results.${resultName}) references in Pipelines by hand if needed.`
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
}
