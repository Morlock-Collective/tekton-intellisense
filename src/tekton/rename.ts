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

/** Throws if `newName` is already used by a *different* entity of the same kind in the same document — an unambiguous, always-a-mistake collision (Tekton/Kubernetes schema validation would reject it outright). */
function assertNoLocalCollision(parsed: ParsedTektonDoc, kind: SameDocKind, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const label = kind === "task-alias" ? "task" : kind;
  if (declListFor(parsed, kind).some((s) => s.name === newName)) {
    throw new Error(`Tekton Aid: "${newName}" is already used by another ${label} in this document.`);
  }
}

/**
 * Resolves a name to exactly one workspace record, or throws. Used
 * whenever the record is being resolved *from a reference* rather than
 * from sitting directly on the declaration: if the name is ambiguous (more
 * than one file declares it), there is no principled way to know which
 * declaration the reference actually means — Tekton itself can't tell them
 * apart by name alone either — so renaming would either have to guess (and
 * risk silently rewriting the wrong file while leaving the very reference
 * that was clicked unchanged, since a name that's ambiguous when resolving
 * *to* a declaration is equally ambiguous when resolving *from* it back to
 * other references) or, as here, refuse outright and say why.
 */
function resolveUnambiguous(candidates: IndexedResource[], name: string, kindLabel: string): IndexedResource {
  if (candidates.length === 0) {
    throw new Error(`Tekton Aid: can't rename — no ${kindLabel} named "${name}" is indexed in this workspace.`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Tekton Aid: can't rename — "${name}" is declared by ${candidates.length} different ${kindLabel} files in this workspace, and it's ambiguous which one this reference means. Rename the declaration directly instead, or make the name unique first.`
    );
  }
  return candidates[0];
}

/**
 * "Go to Definition"'s F2 counterpart. Same-document entities (params,
 * workspaces, pipeline task aliases) rename in isolation. A Task's own
 * result, a Task's own identity (`metadata.name`, referenced by a
 * Pipeline's per-task `taskRef.name` or a TaskRun's own `spec.taskRef`),
 * and a Pipeline's own identity (referenced by a PipelineRun's
 * `spec.pipelineRef`) can be referenced from other files and get a
 * workspace-wide rename by default — but only when the name being renamed
 * unambiguously belongs to one file. If multiple files share a name (a
 * vendored/catalog Task present in more than one chart is a normal
 * occurrence, not a hypothetical), blindly rewriting every reference to
 * that name workspace-wide could silently repoint references that were
 * actually meant for the *other*, untouched file. In that case this skips
 * the cross-file rewrite and tells the user why, rather than guessing.
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
            `Tekton Aid: "${newName}" is already used by another Task file in this workspace. Renamed anyway, but you now have two Tasks sharing a name — taskRef by name won't be able to tell them apart.`
          );
        }

        const sameName = this.workspaceIndex.lookupAllTaskRecords(target.name);
        if (sameName.length > 1) {
          void vscode.window.showWarningMessage(
            `Tekton Aid: "${target.name}" is declared by ${sameName.length} different Task files in this workspace — only the one you renamed from was updated. taskRef references elsewhere were left untouched, since it's ambiguous which Task they actually meant. Update them by hand if needed.`
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
            `Tekton Aid: "${newName}" is already used by another Pipeline file in this workspace. Renamed anyway, but you now have two Pipelines sharing a name — pipelineRef by name won't be able to tell them apart.`
          );
        }

        const sameName = this.workspaceIndex.lookupAllPipelineRecords(target.name);
        if (sameName.length > 1) {
          void vscode.window.showWarningMessage(
            `Tekton Aid: "${target.name}" is declared by ${sameName.length} different Pipeline files in this workspace — only the one you renamed from was updated. pipelineRef.name references elsewhere were left untouched, since it's ambiguous which Pipeline they actually meant. Update them by hand if needed.`
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
   * When F2 is invoked directly on the declaration itself, which file is
   * meant is unambiguous by construction — it's the one open right now —
   * regardless of whether some other file happens to declare the same
   * name (that only affects whether cross-file *reference* updates are
   * safe, handled separately below). Only when resolving *from a
   * reference* elsewhere does an ambiguous name become a real problem,
   * which {@link resolveUnambiguous} rejects outright.
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
        `Tekton Aid: "${taskName}" is declared by ${sameName.length} different Task files in this workspace — only this file's own $(results.${resultName}...) uses were updated. $(tasks.*.results.${resultName}) references in Pipelines were left untouched, since it's ambiguous which Task they actually meant. Update them by hand if needed.`
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
