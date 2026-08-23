import * as vscode from "vscode";
import { findSeqIn, parseTektonFile, findResourceAt, resolvePipelineSpecOwner, trimTrailingNewline } from "../tekton/model";
import { indentAt, insertBlockAfter } from "./editUtils";

const K8S_NAME_VALIDATION = (v: string): string | undefined =>
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v) ? undefined : "must be a valid Kubernetes name";

const LOCAL_TASK_KIND = "Local task";
const CLUSTER_TASK_KIND = "Cluster-resolved task";

const ENTER_NAMESPACE = "$(edit) Enter a namespace…";
const NO_NAMESPACE = "$(circle-slash) Don't specify (use the cluster resolver's configured default)";

/**
 * Prompts for the namespace a cluster-resolved taskRef should fetch from.
 * Offers whatever namespaces `tektonIntellisense.clusterResources.sources`
 * already knows about (the same settings "Add Task" itself doesn't
 * otherwise touch) as one-click picks, since those are the namespaces this
 * workspace is already configured to look at — but doesn't require one:
 * the `namespace` param is optional in Tekton's own cluster resolver (it
 * falls back to the resolver's own `default-namespace` config), so leaving
 * it out is a legitimate, deliberate choice, not an incomplete one.
 * Returns `undefined` on cancel, `""` for "don't specify", otherwise the
 * chosen/typed namespace.
 */
async function pickClusterNamespace(): Promise<string | undefined> {
  const sources =
    vscode.workspace
      .getConfiguration("tektonIntellisense.clusterResources")
      .get<{ namespace: string }[]>("sources", []) ?? [];
  const known = [...new Set(sources.map((s) => s.namespace).filter(Boolean))];

  const picked = await vscode.window.showQuickPick([...known, ENTER_NAMESPACE, NO_NAMESPACE], {
    placeHolder: "Namespace containing this Task on the cluster",
  });
  if (picked === undefined) return undefined;
  if (picked === NO_NAMESPACE) return "";
  if (picked !== ENTER_NAMESPACE) return picked;

  return vscode.window.showInputBox({
    prompt: "Namespace containing this Task on the cluster",
    validateInput: K8S_NAME_VALIDATION,
  });
}

/** The `taskRef:` field's own lines (relative indent, no leading `  ` for the task entry itself yet) — either a plain local reference, or Tekton's `resolver: cluster` shape. */
export function taskRefLines(taskRef: string, namespace: string | undefined): string[] {
  if (namespace === undefined) return [`taskRef:`, `  name: ${taskRef}`];
  const lines = [`taskRef:`, `  resolver: "cluster"`, `  params:`, `    - name: kind`, `      value: task`, `    - name: name`, `      value: ${taskRef}`];
  if (namespace) lines.push(`    - name: namespace`, `      value: ${namespace}`);
  return lines;
}

/**
 * Adds a new task entry to spec.tasks (or spec.finally) — appended after
 * the last existing entry when the list exists, or the list created fresh
 * otherwise. Cursor position is never consulted: the owning Pipeline
 * (either a Pipeline document itself, or a PipelineRun's inline
 * pipelineSpec) is resolved purely from the document's structure, the same
 * way addParameter resolves where a parameter belongs.
 */
export async function addTaskCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  const parsed = findResourceAt(parseTektonFile(document.getText()), document.offsetAt(editor.selection.active));
  if (!parsed) {
    vscode.window.showWarningMessage("Tekton Intellisense: this doesn't look like a Tekton resource.");
    return;
  }

  const owner = resolvePipelineSpecOwner(parsed);
  if (!owner) {
    vscode.window.showWarningMessage(
      `Tekton Intellisense: don't know where to add a task for a ${parsed.symbols.kind} resource.`
    );
    return;
  }

  const taskName = await vscode.window.showInputBox({
    prompt: "New task name",
    validateInput: K8S_NAME_VALIDATION,
  });
  if (!taskName) return;

  const taskRef = await vscode.window.showInputBox({
    prompt: "taskRef name (Task this step runs)",
    value: taskName,
    validateInput: K8S_NAME_VALIDATION,
  });
  if (!taskRef) return;

  const kindPick = await vscode.window.showQuickPick(
    [
      { label: LOCAL_TASK_KIND, description: "taskRef: { name: ... } — resolved from this workspace/namespace" },
      { label: CLUSTER_TASK_KIND, description: "resolver: cluster — fetched from a namespace on the cluster at run time" },
    ],
    { placeHolder: "Where does this Task live?" }
  );
  if (!kindPick) return;

  let namespace: string | undefined;
  if (kindPick.label === CLUSTER_TASK_KIND) {
    namespace = await pickClusterNamespace();
    if (namespace === undefined) return;
  }

  const listKey = (await vscode.window.showQuickPick(["tasks", "finally"], {
    placeHolder: "Add to spec.tasks or spec.finally?",
  })) ?? "tasks";

  const itemLines = [
    `- name: ${taskName}`,
    ...taskRefLines(taskRef, namespace).map((l) => "  " + l),
    `  runAfter: []`,
    `  params: []`,
  ];

  const seq = findSeqIn(owner.ownerMap, listKey);

  if (seq?.range) {
    const lastItem = seq.items[seq.items.length - 1] as { range?: [number, number, number] } | undefined;
    const anchorOffset = trimTrailingNewline(parsed.text, lastItem?.range ? lastItem.range[1] : seq.range[1]);
    const itemIndent = lastItem ? indentAt(document, document.positionAt(seq.range[0])) : owner.keyIndent + "  ";
    await insertBlockAfter(editor, document.positionAt(anchorOffset), itemLines, itemIndent);
    return;
  }

  // No spec.tasks/finally list yet — create it, appended after the owning map's last existing key.
  const lines = [`${listKey}:`, ...itemLines.map((l) => "  " + l)];
  const anchorOffset = trimTrailingNewline(parsed.text, owner.ownerMapEnd);
  await insertBlockAfter(editor, document.positionAt(anchorOffset), lines, owner.keyIndent);
}
