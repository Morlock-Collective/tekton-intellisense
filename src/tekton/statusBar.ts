import * as vscode from "vscode";
import { TektonKind } from "./model";

/** Visible confirmation that Tekton Intellisense has recognized the active file as a Tekton resource. */
export class TektonStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = "Tekton Intellisense";
  }

  update(kind: TektonKind | undefined, helmTemplated: boolean): void {
    if (!kind || kind === "Unknown") {
      this.item.hide();
      return;
    }
    this.item.text = `$(tools) Tekton: ${kind}${helmTemplated ? " (Helm)" : ""}`;
    this.item.tooltip = `Tekton Intellisense is active for this ${kind} resource — reference validation and editing commands are available.`;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
