import * as vscode from "vscode";
import { parseTektonDocument, ParsedTektonDoc, TASK_LIKE_KINDS } from "./model";
import {
  resolveRenameTarget,
  RenameTarget,
  TextEdit,
  sameDocumentEdits,
  sameDocumentResultEdits,
  taskResultReferenceEdits,
  taskRefIdentityEdits,
} from "./renameTarget";
import { TektonWorkspaceIndex, IndexedTask } from "./workspaceIndex";

const YAML_GLOB = "**/*.{yaml,yml}";
const EXCLUDE_GLOB = "**/{node_modules,.git}/**";

function toVscodeRange(parsed: ParsedTektonDoc, range: [number, number]): vscode.Range {
  const start = parsed.lineCounter.linePos(range[0]);
  const end = parsed.lineCounter.linePos(range[1]);
  return new vscode.Range(start.line - 1, start.col - 1, end.line - 1, end.col - 1);
}

function addEdits(workspaceEdit: vscode.WorkspaceEdit, uri: vscode.Uri, parsed: ParsedTektonDoc, edits: TextEdit[]): void {
  for (const e of edits) {
    workspaceEdit.replace(uri, toVscodeRange(parsed, e.range), e.newText);
  }
}

function isValidNewName(kind: RenameTarget["kind"], newName: string): boolean {
  if (!newName) return false;
  // Task/ClusterTask/StepAction metadata.name is a Kubernetes resource name — stricter than the rest.
  if (kind === "task-identity") return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(newName);
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

async function readFileText(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

/** On-demand (not persistently indexed — rename is rare enough to afford a live scan) list of every Pipeline in the workspace. */
async function findPipelineFiles(): Promise<{ uri: vscode.Uri; parsed: ParsedTektonDoc }[]> {
  const uris = await vscode.workspace.findFiles(YAML_GLOB, EXCLUDE_GLOB, 5000);
  const found = await Promise.all(
    uris.map(async (uri) => {
      const text = await readFileText(uri);
      if (text === undefined) return undefined;
      const parsed = parseTektonDocument(text);
      return parsed && parsed.symbols.kind === "Pipeline" ? { uri, parsed } : undefined;
    })
  );
  return found.filter((x): x is { uri: vscode.Uri; parsed: ParsedTektonDoc } => !!x);
}

/**
 * "Go to Definition"'s F2 counterpart. Same-document entities (params,
 * workspaces, pipeline task aliases) rename in isolation. A Task's own
 * result, and a Task's own identity (`metadata.name`, referenced by
 * `taskRef.name`), can be referenced from other files and get a
 * workspace-wide rename by default — but only when the name being renamed
 * unambiguously belongs to one file. If multiple Task files share a name
 * (a vendored/catalog Task present in more than one chart is a normal
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
        const record = target.taskEntry.taskRefName
          ? this.workspaceIndex.lookupTaskRecord(target.taskEntry.taskRefName)
          : undefined;
        if (!record) {
          throw new Error(
            `Tekton Aid: can't rename — the Task "${target.taskEntry.taskRefName ?? "?"}" this refers to isn't indexed in this workspace.`
          );
        }
        assertNoLocalCollision(record.parsed, "result", target.resultName, newName);
        addEdits(edit, record.uri, record.parsed, sameDocumentResultEdits(record.parsed, target.resultName, newName));
        await this.addCrossFileResultEdits(edit, record.parsed, target.resultName, newName);
        return edit;
      }

      case "task-identity": {
        const record = this.resolveTaskIdentityRecord(document, parsed, target.name);
        if (!record) {
          throw new Error(`Tekton Aid: can't rename — no Task/ClusterTask/StepAction named "${target.name}" is indexed in this workspace.`);
        }

        const nameRange = record.parsed.symbols.metadataNameRange;
        if (nameRange) addEdits(edit, record.uri, record.parsed, [{ range: nameRange, newText: newName }]);

        const collidingNewName = this.workspaceIndex.lookupAllTaskRecords(newName);
        if (collidingNewName.length > 0) {
          void vscode.window.showWarningMessage(
            `Tekton Aid: "${newName}" is already used by another Task file in this workspace. Renamed anyway, but you now have two Tasks sharing a name — taskRef by name won't be able to tell them apart.`
          );
        }

        const sameName = this.workspaceIndex.lookupAllTaskRecords(target.name);
        if (sameName.length > 1) {
          void vscode.window.showWarningMessage(
            `Tekton Aid: "${target.name}" is declared by ${sameName.length} different Task files in this workspace — only the one you renamed from was updated. taskRef.name references elsewhere were left untouched, since it's ambiguous which Task they actually meant. Update them by hand if needed.`
          );
          return edit;
        }

        const pipelines = await findPipelineFiles();
        for (const { uri, parsed: pipelineParsed } of pipelines) {
          addEdits(edit, uri, pipelineParsed, taskRefIdentityEdits(pipelineParsed, target.name, newName));
        }
        return edit;
      }
    }
  }

  /** Prefers the document rename was invoked from when it *is* the Task being renamed, over whatever the index's deterministic tie-break would otherwise pick. */
  private resolveTaskIdentityRecord(
    document: vscode.TextDocument,
    parsed: ParsedTektonDoc,
    name: string
  ): IndexedTask | undefined {
    if (parsed.symbols.metadataName === name && TASK_LIKE_KINDS.has(parsed.symbols.kind)) {
      return { uri: document.uri, parsed };
    }
    return this.workspaceIndex.lookupTaskRecord(name);
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

    const pipelines = await findPipelineFiles();
    for (const { uri, parsed } of pipelines) {
      for (const taskEntry of parsed.symbols.tasks) {
        if (taskEntry.taskRefName !== taskName) continue;
        addEdits(edit, uri, parsed, taskResultReferenceEdits(parsed, taskEntry.name, resultName, newName));
      }
    }
  }
}
