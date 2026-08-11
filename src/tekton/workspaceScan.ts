import * as vscode from "vscode";
import { parseTektonDocument, ParsedTektonDoc, TektonKind } from "./model";

const YAML_GLOB = "**/*.{yaml,yml}";
const EXCLUDE_GLOB = "**/{node_modules,.git}/**";

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

/**
 * On-demand (not persistently indexed — `workspaceIndex.ts` covers the
 * "every keystroke" case for Task/Pipeline lookup) list of every workspace
 * document of one of `kinds`. Suitable for rare, latency-tolerant
 * operations like rename or workspace-wide find-references, not anything
 * invoked continuously.
 */
export async function findWorkspaceDocs(kinds: readonly TektonKind[]): Promise<{ uri: vscode.Uri; parsed: ParsedTektonDoc }[]> {
  const uris = await vscode.workspace.findFiles(YAML_GLOB, EXCLUDE_GLOB, 5000);
  const found = await Promise.all(
    uris.map(async (uri) => {
      const text = await readFileText(uri);
      if (text === undefined) return undefined;
      const parsed = parseTektonDocument(text);
      return parsed && kinds.includes(parsed.symbols.kind) ? { uri, parsed } : undefined;
    })
  );
  return found.filter((x): x is { uri: vscode.Uri; parsed: ParsedTektonDoc } => !!x);
}
