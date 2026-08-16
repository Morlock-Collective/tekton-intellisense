import * as vscode from "vscode";
import { parseTektonFile, ParsedTektonDoc, TektonKind } from "./model";

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
 * resource of one of `kinds`, across every `---`-separated document in
 * every matching file — a file contributes as many entries as it has
 * matching resources, so a Task and a Pipeline sharing one file each show
 * up under their own kind's scan. Suitable for rare, latency-tolerant
 * operations like rename or workspace-wide find-references, not anything
 * invoked continuously.
 */
export async function findWorkspaceDocs(kinds: readonly TektonKind[]): Promise<{ uri: vscode.Uri; parsed: ParsedTektonDoc }[]> {
  const uris = await vscode.workspace.findFiles(YAML_GLOB, EXCLUDE_GLOB, 5000);
  const found = await Promise.all(
    uris.map(async (uri) => {
      const text = await readFileText(uri);
      if (text === undefined) return [];
      return parseTektonFile(text)
        .filter((parsed) => kinds.includes(parsed.symbols.kind))
        .map((parsed) => ({ uri, parsed }));
    })
  );
  return found.flat();
}
