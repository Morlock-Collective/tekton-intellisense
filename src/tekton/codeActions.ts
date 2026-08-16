import * as vscode from "vscode";
import { isMap, isScalar, isSeq } from "yaml";
import { DIAGNOSTIC_SOURCE } from "./diagnostics";
import {
  findEnclosingTaskEntry,
  findSeqIn,
  findSpecMap,
  parseTektonFile,
  findResourceAt,
  ParsedTektonDoc,
  resolveParamsTarget,
  SpecListOwner,
  trimTrailingNewline,
} from "./model";
import { blockAfterText, quoteYamlString } from "../commands/snippetText";
import { indentAt } from "../commands/editUtils";
import { TektonWorkspaceIndex } from "./workspaceIndex";
import { toVscodePosition } from "./rangeUtils";

/**
 * A run of plain spaces matching `offset`'s own column — for aligning a
 * brand-new sibling key under a YAML *map* node whose range starts on that
 * key directly (`paramItem`, a `params:` list item), not on its `- `
 * marker. Taking the line's literal leading whitespace instead (as
 * `commands/editUtils.ts#indentAt` does, for a *sequence's* range, which
 * does start at its `-`) would stop two columns short here, landing the
 * new key on the marker instead of alongside the map's other keys — this
 * needs the offset's own column, not what's textually blank before it.
 * Works off raw text rather than a `vscode.TextDocument`, since the match
 * may live in a file that isn't open.
 */
function columnIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return " ".repeat(offset - lineStart);
}

/** Offers quick fixes encoded in a diagnostic's `code`: "suggest:X" applies a Did-you-mean rename; "add-runafter:X" adds X to the enclosing task's runAfter; "add-task-param:TASKREF:PARAM" offers both ways to satisfy a missing required param. */
export class TektonRefCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly workspaceIndex: TektonWorkspaceIndex) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) continue;
      const code = typeof diagnostic.code === "string" ? diagnostic.code : undefined;
      if (!code) continue;

      if (code.startsWith("suggest:")) {
        actions.push(this.suggestFix(document, diagnostic, code.slice("suggest:".length)));
      } else if (code.startsWith("add-runafter:")) {
        const action = this.addRunAfterFix(document, diagnostic, code.slice("add-runafter:".length));
        if (action) actions.push(action);
      } else if (code.startsWith("add-task-param:")) {
        const [taskRefName, paramName] = code.slice("add-task-param:".length).split(":");
        if (!taskRefName || !paramName) continue;
        const bindingFix = this.addTaskParamBindingFix(document, diagnostic, paramName);
        if (bindingFix) actions.push(bindingFix);
        const defaultFix = this.addTaskParamDefaultFix(diagnostic, taskRefName, paramName);
        if (defaultFix) actions.push(defaultFix);
      }
    }

    return actions;
  }

  private suggestFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, suggestion: string): vscode.CodeAction {
    const action = new vscode.CodeAction(`Change to "${suggestion}"`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, diagnostic.range, suggestion);
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    return action;
  }

  private addRunAfterFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, taskName: string): vscode.CodeAction | undefined {
    const offset = document.offsetAt(diagnostic.range.start);
    const parsed = findResourceAt(parseTektonFile(document.getText()), offset);
    if (!parsed) return undefined;

    const entryMap = findEnclosingTaskEntry(parsed, offset);
    if (!entryMap?.range) return undefined;

    const action = new vscode.CodeAction(`Add "${taskName}" to runAfter`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.diagnostics = [diagnostic];
    action.isPreferred = true;

    const runAfterNode = entryMap.get("runAfter", true);
    if (isSeq(runAfterNode) && runAfterNode.range) {
      const lastItem = runAfterNode.items[runAfterNode.items.length - 1] as { range?: [number, number, number] } | undefined;
      const rawAnchor = lastItem?.range ? lastItem.range[1] : runAfterNode.range[1];
      const anchorOffset = trimTrailingNewline(parsed.text, rawAnchor);
      const itemIndent = indentAt(document, document.positionAt(runAfterNode.range[0]));
      action.edit.insert(document.uri, document.positionAt(anchorOffset), blockAfterText([`- ${taskName}`], itemIndent));
      return action;
    }

    // No runAfter: yet — create it, appended after the task's last existing key.
    const anchorOffset = trimTrailingNewline(parsed.text, entryMap.range[1]);
    const taskIndent = indentAt(document, document.positionAt(entryMap.range[0]));
    action.edit.insert(
      document.uri,
      document.positionAt(anchorOffset),
      blockAfterText(["runAfter:", `  - ${taskName}`], taskIndent + "  ")
    );
    return action;
  }

  /** Where a missing param binding belongs: a Pipeline task entry's own map (a sibling of its `taskRef`/`runAfter`, not nested under a `spec`), or a TaskRun's own top-level `spec` (via {@link resolveParamsTarget}'s "binding" shape). */
  private paramBindingOwner(document: vscode.TextDocument, parsed: ParsedTektonDoc, offset: number): SpecListOwner | undefined {
    if (parsed.symbols.kind === "TaskRun") {
      const target = resolveParamsTarget(parsed);
      return target?.shape === "binding" ? target : undefined;
    }
    const entryMap = findEnclosingTaskEntry(parsed, offset);
    if (!entryMap?.range) return undefined;
    const keyIndent = indentAt(document, document.positionAt(entryMap.range[0])) + "  ";
    return { ownerMap: entryMap, ownerMapEnd: entryMap.range[1], keyIndent };
  }

  /**
   * One of the two "missing required param" fixes: adds `paramName` to
   * *this* binding (the Pipeline task entry's or TaskRun's own `params:`
   * list), with a placeholder value the user still needs to fill in.
   * Mirrors `commands/addParameter.ts`'s binding-shape insertion.
   */
  private addTaskParamBindingFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic, paramName: string): vscode.CodeAction | undefined {
    const offset = document.offsetAt(diagnostic.range.start);
    const parsed = findResourceAt(parseTektonFile(document.getText()), offset);
    if (!parsed) return undefined;

    const owner = this.paramBindingOwner(document, parsed, offset);
    if (!owner) return undefined;

    const action = new vscode.CodeAction(`Add "${paramName}" to this task's params`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.diagnostics = [diagnostic];
    action.isPreferred = true;

    const itemLines = [`- name: ${paramName}`, `  value: ${quoteYamlString("")}`];
    const seq = findSeqIn(owner.ownerMap, "params");

    if (seq?.range) {
      const lastItem = seq.items[seq.items.length - 1] as { range?: [number, number, number] } | undefined;
      const anchorOffset = trimTrailingNewline(parsed.text, lastItem?.range ? lastItem.range[1] : seq.range[1]);
      const itemIndent = lastItem ? indentAt(document, document.positionAt(seq.range[0])) : owner.keyIndent + "  ";
      action.edit.insert(document.uri, document.positionAt(anchorOffset), blockAfterText(itemLines, itemIndent));
      return action;
    }

    // No `params:` key yet on the owner -- create it, appended after the owner's last existing key.
    const anchorOffset = trimTrailingNewline(parsed.text, owner.ownerMapEnd);
    action.edit.insert(
      document.uri,
      document.positionAt(anchorOffset),
      blockAfterText(["params:", ...itemLines.map((l) => "  " + l)], owner.keyIndent)
    );
    return action;
  }

  /**
   * The other "missing required param" fix: adds a `default:` to the
   * referenced Task's own declaration of `paramName` instead — satisfying
   * every current and future binding at once, rather than just this one.
   * Cross-file: the Task may live in a different file than `diagnostic`'s
   * own document, possibly not even open, so positions are built from the
   * resolved record's own `lineCounter` ({@link toVscodePosition}), not
   * `document`'s.
   */
  private addTaskParamDefaultFix(diagnostic: vscode.Diagnostic, taskRefName: string, paramName: string): vscode.CodeAction | undefined {
    const record = this.workspaceIndex.lookupTaskRecord(taskRefName);
    if (!record) return undefined;

    const specMap = findSpecMap(record.parsed.doc);
    const paramsSeq = specMap && findSeqIn(specMap, "params");
    const paramItem = paramsSeq?.items.find((item) => {
      if (!isMap(item)) return false;
      const nameNode = item.get("name", true);
      return isScalar(nameNode) && nameNode.value === paramName;
    });
    if (!isMap(paramItem) || !paramItem.range) return undefined;

    const action = new vscode.CodeAction(`Add a default value to Task "${taskRefName}"'s "${paramName}" param`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.diagnostics = [diagnostic];

    const anchorOffset = trimTrailingNewline(record.parsed.text, paramItem.range[1]);
    const indent = columnIndent(record.parsed.text, paramItem.range[0]);
    action.edit.insert(
      record.uri,
      toVscodePosition(record.parsed, anchorOffset),
      blockAfterText([`default: ${quoteYamlString("")}`], indent)
    );
    return action;
  }
}
