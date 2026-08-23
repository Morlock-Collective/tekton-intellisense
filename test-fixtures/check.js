// Standalone sanity check (no vscode API) exercising the core parsing/validation logic
// against the fixtures in this directory. Run with: node test-fixtures/check.js
const fs = require("fs");
const path = require("path");
const {
  parseTektonDocument,
  parseTektonFile,
  findResourceAt,
  resolveParamsTarget,
  resolvePipelineSpecOwner,
  resolveTaskSpecOwner,
  pipelineTaskEntryMaps,
  findEnclosingTaskEntry,
  stepAndSidecarEntryMaps,
  findEnclosingStepEntry,
  findSeqIn,
  findSpecMap,
  trimTrailingNewline,
} = require("../out/tekton/model");
const { findParamRefs } = require("../out/tekton/paramRefs");
const { closestMatch } = require("../out/tekton/levenshtein");
const { findDuplicateGroups } = require("../out/tekton/duplicates");
const { findMissingRunAfter } = require("../out/tekton/runAfterCheck");
const { blockAfterText, quoteYamlString } = require("../out/commands/snippetText");
const {
  findEmbeddedScriptBlocks,
  detectShebangLanguage,
  reindentScriptContent,
  restoreTemplateGaps,
  refreshTemplateGapMarkers,
} = require("../out/tekton/scriptEmbed");
const {
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
} = require("../out/tekton/renameTarget");
const { validateAgainstSchema } = require("../out/tekton/schemaValidation");
const { checkCelExpression, celIssuesInSource, tokenizeCelForHighlighting, celHighlightTokensInSource } = require("../out/tekton/celExpr");
const { fetchClusterResources, isClusterResourceKind, splitCommandLine } = require("../out/tekton/clusterResources");
const { findCelExpressions } = require("../out/tekton/model");
const YAML = require("yaml");
const SCHEMAS_DIR = path.join(__dirname, "..", "schemas");

let failures = 0;

console.log("quoteYamlString round-trip check:");
for (const c of ['plain text', 'has "quotes" inside', "back\\slash", "colon: here", "cost is $5", "multi\nline", "tab\there"]) {
  const line = "value: " + quoteYamlString(c);
  let ok = false;
  try {
    ok = YAML.parse(line).value === c;
  } catch {
    ok = false;
  }
  if (!ok) {
    console.log(`  [FAIL] quoteYamlString(${JSON.stringify(c)}) did not round-trip: ${line}`);
    failures++;
  }
}
console.log(failures === 0 ? "  [PASS] all cases round-tripped" : "  some cases failed, see above");

/** Parses `file`, prints its symbol table, and asserts exactly `expectedWarnings` unknown-reference warnings are found. */
function check(file, expectedWarnings) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const parsed = parseTektonDocument(source);
  if (!parsed) {
    console.log(`  [FAIL] ${file}: NOT recognized as a Tekton document`);
    failures++;
    return;
  }
  console.log(`\n${file} -> kind=${parsed.symbols.kind} helmTemplated=${parsed.isHelmTemplated}`);
  console.log(
    "  params:",
    parsed.symbols.params.map((p) => p.name),
    "workspaces:",
    parsed.symbols.workspaces.map((w) => w.name),
    "results:",
    parsed.symbols.results.map((r) => r.name),
    "tasks:",
    parsed.symbols.tasks.map((t) => t.name)
  );

  let warningCount = 0;
  const refs = findParamRefs(parsed.text);
  for (const ref of refs) {
    let names;
    if (ref.kind === "param") names = parsed.symbols.params.map((p) => p.name);
    else if (ref.kind === "workspace") names = parsed.symbols.workspaces.map((w) => w.name);
    else if (ref.kind === "result") names = parsed.symbols.results.map((r) => r.name);
    else if (ref.kind === "task-result") names = parsed.symbols.tasks.map((t) => t.name);
    else continue;

    if (ref.name && !names.includes(ref.name)) {
      warningCount++;
      const suggestion = closestMatch(ref.name, names);
      console.log(
        `  [WARN] ${ref.kind} "${ref.name}" not declared.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`
      );
    }
  }

  if (warningCount !== expectedWarnings) {
    console.log(`  [FAIL] ${file}: expected ${expectedWarnings} warning(s), found ${warningCount}`);
    failures++;
  }
}

check("pipeline-typo.yaml", 1);
check("helm-templated-task.yaml", 1);
check("helm-top-level-if.yaml", 1);

// Task-level `workspaces: [{name, workspace}]` bindings: the `workspace:`
// value is a plain field, not $(...) syntax, so it's checked separately
// from the reference-based checks above — mirrors checkTaskWorkspaceBindings
// in diagnostics.ts (which can't be called directly from Node; it needs
// vscode.Diagnostic/vscode.Range).
console.log("\ntask-level workspace binding check:");
{
  const source = fs.readFileSync(path.join(__dirname, "pipeline-typo.yaml"), "utf8");
  const parsed = parseTektonDocument(source);
  const names = parsed.symbols.workspaces.map((w) => w.name);
  const problems = [];
  for (const task of parsed.symbols.tasks) {
    for (const binding of task.workspaceBindings) {
      if (binding.workspaceName && !names.includes(binding.workspaceName)) {
        problems.push({ task: task.name, workspace: binding.workspaceName, suggestion: closestMatch(binding.workspaceName, names) });
      }
    }
  }
  console.log("  found:", problems);
  const ok =
    problems.length === 1 &&
    problems[0].task === "build" &&
    problems[0].workspace === "shared-workspce" &&
    problems[0].suggestion === "shared-workspace";
  console.log(`  [${ok ? "PASS" : "FAIL"}] catches the planted "shared-workspce" typo, suggests "shared-workspace", no false positives`);
  if (!ok) failures++;
}

console.log("\nduplicate-name check:");
const dup = parseTektonDocument(fs.readFileSync(path.join(__dirname, "pipeline-duplicates.yaml"), "utf8"));
let duplicatesFound = 0;
for (const [list, label] of [
  [dup.symbols.params, "parameter"],
  [dup.symbols.workspaces, "workspace"],
  [dup.symbols.results, "result"],
  [dup.symbols.tasks, "task"],
]) {
  for (const [name, occurrences] of findDuplicateGroups(list)) {
    duplicatesFound++;
    console.log(`  [ERROR] duplicate ${label} name "${name}" — declared ${occurrences.length} times`);
  }
}
if (duplicatesFound !== 2) {
  console.log(`  [FAIL] pipeline-duplicates.yaml: expected 2 duplicate groups (param + task), found ${duplicatesFound}`);
  failures++;
}

// End-to-end "Add Parameter" simulation: reproduces addParameter.ts's own
// splicing logic (minus the vscode calls) and re-parses the result, to
// catch exactly the class of bug that shipped once already — a node range
// that already includes its trailing newline gluing two lines together, or
// duplicating a blank line, depending on the fixture's exact byte layout.
function simulateAddParameter(source, itemLines) {
  const parsed = parseTektonDocument(source);
  const target = resolveParamsTarget(parsed);
  if (!target) return { target: undefined };

  const seq = findSeqIn(target.ownerMap, "params");
  let text, offset;
  if (seq && seq.range) {
    const lastItem = seq.items[seq.items.length - 1];
    const rawAnchor = lastItem && lastItem.range ? lastItem.range[1] : seq.range[1];
    offset = trimTrailingNewline(parsed.text, rawAnchor);
    const lineStart = parsed.text.lastIndexOf("\n", seq.range[0] - 1) + 1;
    const itemIndent = lastItem ? parsed.text.slice(lineStart, seq.range[0]) : target.keyIndent + "  ";
    text = blockAfterText(itemLines, itemIndent);
  } else {
    offset = trimTrailingNewline(parsed.text, target.ownerMapEnd);
    text = blockAfterText(["params:", ...itemLines.map((l) => "  " + l)], target.keyIndent);
  }
  return { target, result: source.slice(0, offset) + text + source.slice(offset) };
}

/** Recursively hunts the parsed JS value for any array entry with `name === expectedName`, regardless of nesting depth. */
function containsNamedEntry(value, expectedName) {
  if (Array.isArray(value)) return value.some((v) => containsNamedEntry(v, expectedName));
  if (value && typeof value === "object") {
    if (value.name === expectedName) return true;
    return Object.values(value).some((v) => containsNamedEntry(v, expectedName));
  }
  return false;
}

function checkAddParameter(file, itemLines, expectedName) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const before = YAML.parse(source);
  const { target, result } = simulateAddParameter(source, itemLines);
  if (!target) {
    console.log(`  [FAIL] ${file}: resolveParamsTarget found no target`);
    failures++;
    return;
  }

  let after;
  try {
    after = YAML.parse(result);
  } catch (err) {
    console.log(`  [FAIL] ${file}: result is no longer valid YAML (${err.message})`);
    console.log(result);
    failures++;
    return;
  }

  const hasNewParam = containsNamedEntry(after, expectedName);
  const beforeSize = JSON.stringify(before).length;
  const growth = JSON.stringify(after).length - beforeSize;
  const reasonableGrowth = growth > 0 && growth < 500; // sanity bound — a glued/duplicated document would look wildly different

  const ok = hasNewParam && reasonableGrowth;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${file} (shape=${target.shape}): new param present=${hasNewParam}`);
  if (!ok) {
    console.log(result);
    failures++;
  }
}

console.log("\nadd-parameter simulation (context-aware target + no cursor):");
checkAddParameter("pipeline-typo.yaml", ['- name: new-param', '  type: string', '  description: "added by test"'], "new-param");
checkAddParameter("task-build-image.yaml", ["- name: new-param", "  type: string"], "new-param");
checkAddParameter("pipeline-crossfile.yaml", ["- name: new-param", "  type: string"], "new-param");
checkAddParameter("pipelinerun-ref.yaml", ["- name: new-param", "  value: something"], "new-param");
checkAddParameter("pipelinerun-inline.yaml", ["- name: new-param", "  type: string"], "new-param");
checkAddParameter("taskrun-ref.yaml", ["- name: new-param", "  value: something"], "new-param");
checkAddParameter("taskrun-inline.yaml", ["- name: new-param", "  type: string"], "new-param");

// A blank line the user put there on purpose (between spec.params and the
// next key) must survive appending a new param right before it — regression
// test for trimTrailingNewline() over-trimming a whole run of newlines
// instead of just the one that terminates the last item's own line.
{
  const file = "task-blank-line.yaml";
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const blankLinesBefore = (source.match(/\n\n/g) || []).length;
  const { result } = simulateAddParameter(source, ["- name: new-param", "  type: string"]);
  const blankLinesAfter = (result.match(/\n\n/g) || []).length;
  const ok = blankLinesAfter === blankLinesBefore;
  console.log(
    `  [${ok ? "PASS" : "FAIL"}] ${file}: pre-existing blank line preserved (before=${blankLinesBefore}, after=${blankLinesAfter})`
  );
  if (!ok) {
    console.log(result);
    failures++;
  }
}

// Cross-file completion resolution: tasks.<local>.results.<X> should resolve
// against the Task that taskRef actually points at, in a *different* file.
console.log("\ncross-file tasks.X.results.Y completion resolution:");
const pipeline = parseTektonDocument(fs.readFileSync(path.join(__dirname, "pipeline-crossfile.yaml"), "utf8"));
const task = parseTektonDocument(fs.readFileSync(path.join(__dirname, "task-build-image.yaml"), "utf8"));
const localTask = pipeline.symbols.tasks.find((t) => t.name === "build");
const index = new Map([[task.symbols.metadataName, task.symbols]]);
const resolved = index.get(localTask.taskRefName);
console.log(
  `  tasks.build.taskRef=${localTask.taskRefName} -> results:`,
  resolved.results.map((r) => r.name)
);
if (!resolved || resolved.results.map((r) => r.name).join(",") !== "digest,image-url") {
  console.log("  [FAIL] cross-file result resolution did not return the expected results");
  failures++;
}

/** Splices a set of {range:[start,end], newText} edits into `source`, applied back-to-front so offsets stay valid. */
function applyTextEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.range[0] - a.range[0]);
  let result = source;
  for (const e of sorted) {
    result = result.slice(0, e.range[0]) + e.newText + result.slice(e.range[1]);
  }
  return result;
}

console.log("\nrename: same-document param/workspace/task-alias:");
{
  const file = "pipeline-typo.yaml";
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const parsed = parseTektonDocument(source);

  // Click inside the reference, not the declaration, to prove reference-site detection works too.
  const refOffset = source.indexOf("$(params.deploy-env)") + "$(params.".length + 3;
  const target = resolveRenameTarget(parsed, refOffset);
  const edits = target ? sameDocumentEdits(parsed, target.kind, target.name, "release-env") : [];
  const result = applyTextEdits(source, edits);
  let after;
  try {
    after = parseTektonDocument(result);
  } catch {
    after = undefined;
  }
  const ok =
    target?.kind === "param" &&
    target.name === "deploy-env" &&
    edits.length === 2 && // declaration + the one correctly-spelled reference
    after?.symbols.params.some((p) => p.name === "release-env") &&
    !result.includes("deploy-env");
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${file}: param "deploy-env" -> "release-env" (${edits.length} edits)`);
  if (!ok) {
    console.log({ target, edits });
    failures++;
  }
}

console.log("\nrename: workspace, declaration <-> task-level workspace binding:");
{
  // The task-level `workspaces: [{name, workspace}]` binding is a plain YAML field value, not
  // $(...) syntax -- a separate mechanism from `$(workspaces.NAME...)` refs that both
  // resolveRenameTarget and sameDocumentEdits previously never looked at at all.
  const file = "pipeline-workspace.yaml";
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const parsed = parseTektonDocument(source);

  // From the declaration: must also update the task's `workspace: shared-workspace` binding.
  const declOffset = source.indexOf("shared-workspace") + 3;
  const declTarget = resolveRenameTarget(parsed, declOffset);
  const declEdits = declTarget ? sameDocumentEdits(parsed, declTarget.kind, declTarget.name, "renamed-ws") : [];
  const declResult = applyTextEdits(source, declEdits);
  let declAfter;
  try {
    declAfter = parseTektonDocument(declResult);
  } catch {
    declAfter = undefined;
  }
  const okFromDecl =
    declTarget?.kind === "workspace" &&
    declTarget.name === "shared-workspace" &&
    declEdits.length === 2 && // declaration + the task's workspace: binding
    declAfter?.symbols.workspaces.some((w) => w.name === "renamed-ws") &&
    declAfter?.symbols.tasks.some((t) => t.workspaceBindings.some((wb) => wb.workspaceName === "renamed-ws")) &&
    !declResult.includes("shared-workspace");
  console.log(`  [${okFromDecl ? "PASS" : "FAIL"}] ${file}: from declaration, "shared-workspace" -> "renamed-ws" (${declEdits.length} edits)`);
  if (!okFromDecl) {
    console.log({ declTarget, declEdits });
    failures++;
  }

  // From the point of use (the task's workspace: binding value, not the declaration) -- must
  // resolve to a renameable target at all, and produce the identical edit set.
  const useOffset = source.lastIndexOf("shared-workspace") + 3;
  const useTarget = resolveRenameTarget(parsed, useOffset);
  const useEdits = useTarget ? sameDocumentEdits(parsed, useTarget.kind, useTarget.name, "renamed-ws") : [];
  const okFromUse =
    useOffset !== declOffset &&
    useTarget?.kind === "workspace" &&
    useTarget.name === "shared-workspace" &&
    useEdits.length === 2;
  console.log(`  [${okFromUse ? "PASS" : "FAIL"}] ${file}: rename initiated from the task's workspace: binding (point of use), not just the declaration`);
  if (!okFromUse) {
    console.log({ useTarget, useEdits });
    failures++;
  }
}

console.log("\nrename: workspace, declaration <-> PipelineRun's own workspace binding, cross-file:");
{
  // A PipelineRun binds a Pipeline's declared workspace by providing a spec.workspaces[] entry
  // with the *same name* as a top-level sibling, not through a nested `workspace:` indirection
  // like a Pipeline task entry's binding -- a different shape from the same-document case above,
  // and cross-file (via pipelineRef) on top of that. all-kinds-multidoc.yaml's mdk-pipeline and
  // mdk-pipelinerun (pipelineRef: mdk-pipeline) are both real, in-use fixture resources -- not
  // rename-specific throwaway ones -- exercising this as a same-file cross-document case too.
  const source = fs.readFileSync(path.join(__dirname, "all-kinds-multidoc.yaml"), "utf8");
  const docs = parseTektonFile(source);
  const pipeline = docs.find((d) => d.symbols.metadataName === "mdk-pipeline");
  const run = docs.find((d) => d.symbols.metadataName === "mdk-pipelinerun");

  const declOffset = source.indexOf("name: mdk-workspace") + "name: ".length;
  const target = resolveRenameTarget(pipeline, declOffset);
  const sameDocEdits = target ? sameDocumentEdits(pipeline, "workspace", target.name, "mdk-workspace-renamed") : [];

  // Mirrors rename.ts's addCrossFilePipelineWorkspaceEdits: every PipelineRun whose pipelineRef
  // matches gets its own spec.workspaces[] entry of the same name updated.
  const crossFileEdits = run.symbols.workspaces
    .filter((w) => w.name === "mdk-workspace")
    .map((w) => ({ range: w.range, newText: "mdk-workspace-renamed" }));
  const crossFileApplied = applyTextEdits(source, crossFileEdits);

  const ok =
    target?.kind === "workspace" &&
    target.name === "mdk-workspace" &&
    sameDocEdits.length === 2 && // declaration + the Pipeline task entry's own workspace: binding
    run.symbols.pipelineRefName === "mdk-pipeline" &&
    crossFileEdits.length === 1 &&
    crossFileApplied.includes("name: mdk-workspace-renamed\n      emptyDir: {}");
  console.log(`  [${ok ? "PASS" : "FAIL"}] target resolves(${target?.kind === "workspace"}), same-doc edits(${sameDocEdits.length}), PipelineRun's own binding found and renamed(${crossFileEdits.length} edit(s))`);
  if (!ok) {
    console.log({ target, sameDocEdits, pipelineRefName: run.symbols.pipelineRefName, crossFileEdits });
    failures++;
  }
}

console.log("\nrename: workspace, initiated FROM a PipelineRun's own workspace binding (reverse direction):");
{
  // The declaration-side direction (Pipeline -> its PipelineRuns) is covered above. This is the
  // other direction: renaming from the PipelineRun's own binding must resolve back to the real
  // Pipeline (via pipelineRef) rather than doing an isolated same-document rename of just this
  // one PipelineRun's own entry, leaving the Pipeline's declaration and every other PipelineRun
  // referencing it untouched.
  const source = fs.readFileSync(path.join(__dirname, "all-kinds-multidoc.yaml"), "utf8");
  const docs = parseTektonFile(source);
  const pipeline = docs.find((d) => d.symbols.metadataName === "mdk-pipeline");
  const run = docs.find((d) => d.symbols.metadataName === "mdk-pipelinerun");

  const bindingOffset = source.lastIndexOf("name: mdk-workspace") + "name: ".length; // the PipelineRun's own entry, not the Pipeline's declaration
  const target = resolveRenameTarget(run, bindingOffset);
  const targetOk =
    target?.kind === "pipeline-workspace" && target.workspaceName === "mdk-workspace" && target.pipelineRefName === "mdk-pipeline";

  // Mirrors rename.ts's "pipeline-workspace" case: resolve the real Pipeline, rename its
  // declaration + same-doc bindings there, then propagate to every PipelineRun's own binding
  // (including this one) the same way the declaration-side direction does.
  const sameDocEdits = targetOk ? sameDocumentEdits(pipeline, "workspace", target.workspaceName, "mdk-workspace-renamed") : [];
  const crossFileEdits = run.symbols.workspaces
    .filter((w) => w.name === "mdk-workspace")
    .map((w) => ({ range: w.range, newText: "mdk-workspace-renamed" }));

  // Both edit sets apply to the same source (all-kinds-multidoc.yaml is one file) -- combine and
  // apply together, same as a real WorkspaceEdit spanning multiple ranges in one document.
  const applied = applyTextEdits(source, [...sameDocEdits, ...crossFileEdits]);
  const appliedOk =
    applied.includes("name: mdk-workspace-renamed\n  tasks:") && // Pipeline's own declaration
    applied.includes("workspace: mdk-workspace-renamed") && // Pipeline task entry's own binding
    applied.includes("name: mdk-workspace-renamed\n      emptyDir: {}") && // PipelineRun's own binding
    !applied.includes("mdk-workspace\n"); // old name fully gone

  const ok = targetOk && sameDocEdits.length === 2 && crossFileEdits.length === 1 && appliedOk;
  console.log(`  [${ok ? "PASS" : "FAIL"}] resolves to "pipeline-workspace" against the real Pipeline(${targetOk}), full rename applied consistently(${appliedOk})`);
  if (!ok) {
    console.log({ target, sameDocEdits, crossFileEdits, applied });
    failures++;
  }
}

console.log("\nrename: task alias, declaration <-> other tasks' runAfter entries:");
{
  // A task alias appearing in another task's runAfter: [name, ...] is a plain YAML scalar, not
  // $(...) syntax or a {ref: name} map -- same gap class as the workspace-binding case above.
  const file = "pipeline-missing-runafter.yaml";
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const parsed = parseTektonDocument(source);

  // From the declaration: must update both $(tasks.build.results...) refs (deploy, audit) and
  // the runAfter: [build] entry (audit).
  // "name: build" alone would also match metadata.name ("build-and-deploy-3" starts with "build").
  const declOffset = source.indexOf("- name: build\n") + 8;
  const declTarget = resolveRenameTarget(parsed, declOffset);
  const declEdits = declTarget ? sameDocumentEdits(parsed, declTarget.kind, declTarget.name, "compile") : [];
  const declResult = applyTextEdits(source, declEdits);
  let declAfter;
  try {
    declAfter = parseTektonDocument(declResult);
  } catch {
    declAfter = undefined;
  }
  const okFromDecl =
    declTarget?.kind === "task-alias" &&
    declTarget.name === "build" &&
    declEdits.length === 4 && // declaration + 2x $(tasks.build.results...) + 1x runAfter entry
    declAfter?.symbols.tasks.some((t) => t.name === "compile") &&
    !declAfter?.symbols.tasks.some((t) => t.name === "build") &&
    declAfter?.symbols.tasks.find((t) => t.name === "audit")?.runAfter.some((ra) => ra.name === "compile") &&
    !declAfter?.symbols.tasks.find((t) => t.name === "audit")?.runAfter.some((ra) => ra.name === "build");
  console.log(`  [${okFromDecl ? "PASS" : "FAIL"}] ${file}: from declaration, "build" -> "compile" (${declEdits.length} edits)`);
  if (!okFromDecl) {
    console.log({ declTarget, declEdits });
    failures++;
  }

  // From the point of use (the "audit" task's runAfter: [build] entry, not the declaration).
  const useOffset = source.lastIndexOf("- build") + 2;
  const useTarget = resolveRenameTarget(parsed, useOffset);
  const useEdits = useTarget ? sameDocumentEdits(parsed, useTarget.kind, useTarget.name, "compile") : [];
  const okFromUse = useOffset !== declOffset && useTarget?.kind === "task-alias" && useTarget.name === "build" && useEdits.length === 4;
  console.log(`  [${okFromUse ? "PASS" : "FAIL"}] ${file}: rename initiated from a runAfter entry (point of use), not just the declaration`);
  if (!okFromUse) {
    console.log({ useTarget, useEdits });
    failures++;
  }
}

console.log("\nrename: cross-file result (Task result <-> tasks.X.results.Y):");
{
  const taskSource = fs.readFileSync(path.join(__dirname, "task-build-image.yaml"), "utf8");
  const pipelineSource = fs.readFileSync(path.join(__dirname, "pipeline-uses-result.yaml"), "utf8");
  const taskParsed = parseTektonDocument(taskSource);
  const pipelineParsed = parseTektonDocument(pipelineSource);

  // Invoked FROM the pipeline's $(tasks.build.results.digest) reference, not the declaration.
  const refOffset = pipelineSource.indexOf("results.digest") + "results.".length + 2;
  const target = resolveRenameTarget(pipelineParsed, refOffset);
  const ok1 = target?.kind === "task-result" && target.taskAlias === "build" && target.resultName === "digest";

  // Resolve to the actual Task (mirrors what workspaceIndex.lookupTaskRecord does).
  const taskEdits = sameDocumentResultEdits(taskParsed, "digest", "imageDigest");
  const pipelineEdits = taskResultReferenceEdits(pipelineParsed, "build", "digest", "imageDigest");
  const taskResult = applyTextEdits(taskSource, taskEdits);
  const pipelineResult = applyTextEdits(pipelineSource, pipelineEdits);

  const taskAfter = parseTektonDocument(taskResult);
  const ok2 = taskAfter?.symbols.results.some((r) => r.name === "imageDigest");
  const ok3 = pipelineResult.includes("$(tasks.build.results.imageDigest)");
  const ok = ok1 && ok2 && ok3;
  console.log(`  [${ok ? "PASS" : "FAIL"}] "digest" -> "imageDigest": target=${ok1}, task-file=${!!ok2}, pipeline-file=${ok3}`);
  if (!ok) {
    console.log({ target, taskResult, pipelineResult });
    failures++;
  }
}

console.log("\nrename: cross-file task-param (Task's declared param <-> a taskRef'd binding's name), same-doc and cross-file:");
{
  // Dedicated inline fixtures rather than reusing an existing one -- taskrun-ref.yaml's binding
  // intentionally doesn't match its Task's declared param name, for a different existing test.
  const taskSource = `apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: build-image
spec:
  params:
    - name: image-tag
      type: string
  steps:
    - name: build
      script: echo $(params.image-tag)
`;
  const pipelineSource = `apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: p
spec:
  tasks:
    - name: build
      taskRef:
        name: build-image
      params:
        - name: image-tag
          value: latest
`;
  const taskRunSource = `apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  name: run
spec:
  taskRef:
    name: build-image
  params:
    - name: image-tag
      value: latest
`;
  const taskParsed = parseTektonDocument(taskSource);
  const pipelineParsed = parseTektonDocument(pipelineSource);
  const taskRunParsed = parseTektonDocument(taskRunSource);

  // From the Task's own declaration: same-doc edits cover the decl + its own $(params...) self-ref.
  const declOffset = taskSource.indexOf("name: image-tag") + 6;
  const declTarget = resolveRenameTarget(taskParsed, declOffset);
  const sameDocEdits = declTarget?.kind === "param" ? sameDocumentEdits(taskParsed, "param", declTarget.name, "imageTag") : [];
  const okDecl = declTarget?.kind === "param" && declTarget.name === "image-tag" && sameDocEdits.length === 2;
  console.log(`  [${okDecl ? "PASS" : "FAIL"}] Task declaration resolves as "param"; same-doc edits cover decl + self-ref (${sameDocEdits.length})`);
  if (!okDecl) {
    console.log({ declTarget, sameDocEdits });
    failures++;
  }

  // From the Pipeline task entry's params: [{name: image-tag}] binding (point of use).
  const pipelineOffset = pipelineSource.lastIndexOf("image-tag") + 3;
  const pipelineTarget = resolveRenameTarget(pipelineParsed, pipelineOffset);
  const pipelineEdits =
    pipelineTarget?.kind === "task-param" && pipelineTarget.taskAlias
      ? taskParamReferenceEdits(pipelineParsed, pipelineTarget.taskAlias, pipelineTarget.paramName, "imageTag")
      : [];
  const okPipeline =
    pipelineTarget?.kind === "task-param" &&
    pipelineTarget.paramName === "image-tag" &&
    pipelineTarget.taskRefName === "build-image" &&
    pipelineTarget.taskAlias === "build" &&
    pipelineEdits.length === 1;
  console.log(`  [${okPipeline ? "PASS" : "FAIL"}] Pipeline task entry's params binding resolves as "task-param", scoped edit found (${pipelineEdits.length})`);
  if (!okPipeline) {
    console.log({ pipelineTarget, pipelineEdits });
    failures++;
  }

  // From the TaskRun's own params: [{name: image-tag}] binding -- no taskAlias, whole doc is the binding.
  const taskRunOffset = taskRunSource.lastIndexOf("image-tag") + 3;
  const taskRunTarget = resolveRenameTarget(taskRunParsed, taskRunOffset);
  const okTaskRun =
    taskRunTarget?.kind === "task-param" &&
    taskRunTarget.paramName === "image-tag" &&
    taskRunTarget.taskRefName === "build-image" &&
    taskRunTarget.taskAlias === undefined;
  console.log(`  [${okTaskRun ? "PASS" : "FAIL"}] TaskRun's own params binding resolves as "task-param" with no taskAlias`);
  if (!okTaskRun) {
    console.log({ taskRunTarget });
    failures++;
  }

  // Applying every edit together must leave a consistent result: Task's param renamed, and both
  // bindings pointing at the new name.
  const taskResult = applyTextEdits(taskSource, sameDocEdits);
  const pipelineResult = applyTextEdits(pipelineSource, pipelineEdits);
  const taskRunEdits =
    taskRunTarget?.kind === "task-param"
      ? taskRunParsed.symbols.params.filter((p) => p.name === "image-tag").map((p) => ({ range: p.range, newText: "imageTag" }))
      : [];
  const taskRunResult = applyTextEdits(taskRunSource, taskRunEdits);
  const taskAfter = parseTektonDocument(taskResult);
  const okApplied =
    taskAfter?.symbols.params.some((p) => p.name === "imageTag") &&
    pipelineResult.includes("name: imageTag") &&
    taskRunResult.includes("name: imageTag");
  console.log(`  [${okApplied ? "PASS" : "FAIL"}] applying all edits together: Task decl + both bindings consistently renamed`);
  if (!okApplied) {
    console.log({ taskResult, pipelineResult, taskRunResult });
    failures++;
  }
}

console.log("\nrename: cross-file task identity (metadata.name <-> taskRef.name), multiple taskRefs:");
{
  const pipelineSource = `apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: multi-arch-build
spec:
  tasks:
    - name: build-amd64
      taskRef:
        name: build-image
    - name: build-arm64
      taskRef:
        name: build-image
    - name: unrelated
      taskRef:
        name: something-else
`;
  const parsed = parseTektonDocument(pipelineSource);
  const edits = taskRefIdentityEdits(parsed, "build-image", "compile-image");
  const result = applyTextEdits(pipelineSource, edits);
  const after = parseTektonDocument(result);
  const taskRefNames = after?.symbols.tasks.map((t) => t.taskRefName).sort();
  const ok =
    edits.length === 2 &&
    JSON.stringify(taskRefNames) === JSON.stringify(["compile-image", "compile-image", "something-else"].sort());
  console.log(`  [${ok ? "PASS" : "FAIL"}] both taskRefs to "build-image" updated, "something-else" left alone (${edits.length} edits)`);
  if (!ok) {
    console.log({ edits, taskRefNames });
    failures++;
  }
}

console.log("\nrename: step ref (StepAction identity), same-doc and cross-file:");
{
  // A step's `ref: { name: X }` (pointing at a shared StepAction) shares the same identity
  // namespace as taskRef.name -- TASK_LIKE_KINDS includes StepAction alongside Task/ClusterTask.
  const taskSource = fs.readFileSync(path.join(__dirname, "task-uses-stepaction.yaml"), "utf8");
  const taskParsed = parseTektonDocument(taskSource);

  // Rename initiated from the point of use (the step's ref.name), not a declaration.
  const useOffset = taskSource.indexOf("shared-lint") + 3;
  const useTarget = resolveRenameTarget(taskParsed, useOffset);
  const sameDocEdits = useTarget ? taskRefIdentityEdits(taskParsed, useTarget.name, "shared-linter") : [];
  const okFromUse = useTarget?.kind === "task-identity" && useTarget.name === "shared-lint" && sameDocEdits.length === 1;
  console.log(`  [${okFromUse ? "PASS" : "FAIL"}] task-uses-stepaction.yaml: step ref.name resolves as a rename target and produces a same-doc edit`);
  if (!okFromUse) {
    console.log({ useTarget, sameDocEdits });
    failures++;
  }

  // Rename initiated from the StepAction's own declaration must find the Task's step ref cross-file.
  const stepActionSource = fs.readFileSync(path.join(__dirname, "stepaction-lint.yaml"), "utf8");
  const stepActionParsed = parseTektonDocument(stepActionSource);
  const declOffset = stepActionSource.indexOf("shared-lint") + 3;
  const declTarget = resolveRenameTarget(stepActionParsed, declOffset);
  const crossFileEdits = taskRefIdentityEdits(taskParsed, "shared-lint", "shared-linter");
  const okCrossFile =
    declTarget?.kind === "task-identity" &&
    declTarget.name === "shared-lint" &&
    crossFileEdits.length === 1 &&
    applyTextEdits(taskSource, crossFileEdits).includes("shared-linter");
  console.log(`  [${okCrossFile ? "PASS" : "FAIL"}] stepaction-lint.yaml: declaration resolves as a rename target; cross-file scan finds task-uses-stepaction.yaml's step ref`);
  if (!okCrossFile) {
    console.log({ declTarget, crossFileEdits });
    failures++;
  }
}

console.log("\nmulti-document YAML: every `---`-separated resource in a file is parsed:");
{
  // stepaction-and-task-multidoc.yaml bundles a StepAction and a Task (referencing it via
  // `ref:`) via `---` in one file, a common kubectl-apply/kustomize-build pattern.
  const source = fs.readFileSync(path.join(__dirname, "stepaction-and-task-multidoc.yaml"), "utf8");
  const docs = parseTektonFile(source);
  const stepAction = docs.find((d) => d.symbols.kind === "StepAction");
  const task = docs.find((d) => d.symbols.kind === "Task");
  const bothSeen = docs.length === 2 && stepAction?.symbols.metadataName === "shared-lint1" && task?.symbols.metadataName === "build";

  // Each resource's own offset range is disjoint and doesn't leak the other's -- a cursor
  // anywhere in the StepAction resolves to it, not to the Task, and vice versa.
  const stepActionOffset = source.indexOf("shared-lint1");
  const taskOffset = source.lastIndexOf("shared-lint1"); // the Task's own `ref: name: shared-lint1`
  const resolvedForStepAction = findResourceAt(docs, stepActionOffset);
  const resolvedForTask = findResourceAt(docs, taskOffset);
  const resourcesDisjoint = resolvedForStepAction?.symbols.kind === "StepAction" && resolvedForTask?.symbols.kind === "Task";

  // The Task's step `ref: shared-lint1` is a same-*file*, cross-*document* reference -- exactly
  // the case `findWorkspaceDocs`/rename/references now handle uniformly, since a multi-document
  // file contributes one entry per resource rather than one per file.
  const crossDocEdits = taskRefIdentityEdits(task, "shared-lint1", "shared-lint-renamed");
  const crossDocOk = crossDocEdits.length === 1 && applyTextEdits(source, crossDocEdits).includes("shared-lint-renamed");

  const ok = bothSeen && resourcesDisjoint && crossDocOk;
  console.log(`  [${ok ? "PASS" : "FAIL"}] both resources seen(${bothSeen}), each offset resolves to its own resource(${resourcesDisjoint}), cross-document step ref rename(${crossDocOk})`);
  if (!ok) {
    console.log({ count: docs.length, stepAction: stepAction?.symbols.metadataName, task: task?.symbols.metadataName, crossDocEdits });
    failures++;
  }
}

console.log("\nmulti-document YAML: every recognized TektonKind, one file (all-kinds-multidoc.yaml):");
{
  const source = fs.readFileSync(path.join(__dirname, "all-kinds-multidoc.yaml"), "utf8");
  const docs = parseTektonFile(source);

  const expected = {
    "mdk-stepaction": "StepAction",
    "mdk-task": "Task",
    "mdk-clustertask": "ClusterTask",
    "mdk-pipeline": "Pipeline",
    "mdk-pipelinerun": "PipelineRun",
    "mdk-taskrun": "TaskRun",
    "mdk-template": "TriggerTemplate",
    "mdk-binding": "TriggerBinding",
    "mdk-clusterbinding": "ClusterTriggerBinding",
    "mdk-trigger": "Trigger",
    "mdk-listener": "EventListener",
  };
  const byName = new Map(docs.map((d) => [d.symbols.metadataName, d]));
  const allKindsSeen =
    docs.length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, kind]) => byName.get(name)?.symbols.kind === kind);

  const task = byName.get("mdk-task");
  const pipeline = byName.get("mdk-pipeline");
  const taskRun = byName.get("mdk-taskrun");

  // A cross-document identity reference chain, three different reference shapes all pointing
  // cross-document at "mdk-task" within this one file: a step's own `ref`, a Pipeline task
  // entry's `taskRef`, and a TaskRun's own `taskRef`.
  const stepRefEdits = taskRefIdentityEdits(task, "mdk-stepaction", "mdk-stepaction-renamed");
  const pipelineTaskRefEdits = taskRefIdentityEdits(pipeline, "mdk-task", "mdk-task-renamed");
  const taskRunRefEdits = taskRefIdentityEdits(taskRun, "mdk-task", "mdk-task-renamed");
  const taskChainOk = stepRefEdits.length === 1 && pipelineTaskRefEdits.length === 1 && taskRunRefEdits.length === 1;

  // A PipelineRun's pipelineRef and a Trigger/EventListener's bindings[].ref + template.ref +
  // triggerRef, every one of them a same-file cross-document reference.
  const pipelineRunEdits = pipelineRefIdentityEdits(byName.get("mdk-pipelinerun"), "mdk-pipeline", "mdk-pipeline-renamed");
  const triggerBindingEdits = bindingRefIdentityEdits(byName.get("mdk-trigger"), "mdk-binding", "mdk-binding-renamed");
  const triggerTemplateEdits = templateRefIdentityEdits(byName.get("mdk-trigger"), "mdk-template", "mdk-template-renamed");
  const listenerTriggerEdits = triggerRefIdentityEdits(byName.get("mdk-listener"), "mdk-trigger", "mdk-trigger-renamed");
  const listenerBindingEdits = bindingRefIdentityEdits(byName.get("mdk-listener"), "mdk-clusterbinding", "mdk-clusterbinding-renamed");
  const listenerTemplateEdits = templateRefIdentityEdits(byName.get("mdk-listener"), "mdk-template", "mdk-template-renamed");
  const triggerChainOk =
    pipelineRunEdits.length === 1 &&
    triggerBindingEdits.length === 1 &&
    triggerTemplateEdits.length === 1 &&
    listenerTriggerEdits.length === 1 &&
    listenerBindingEdits.length === 1 &&
    listenerTemplateEdits.length === 1;

  const ok = allKindsSeen && taskChainOk && triggerChainOk;
  console.log(`  [${ok ? "PASS" : "FAIL"}] all 11 kinds recognized(${allKindsSeen}), Task/StepAction ref chain(${taskChainOk}), Pipeline/Trigger ref chain(${triggerChainOk})`);
  if (!ok) {
    console.log({
      count: docs.length,
      kinds: docs.map((d) => `${d.symbols.metadataName}:${d.symbols.kind}`),
      stepRefEdits,
      pipelineTaskRefEdits,
      taskRunRefEdits,
      pipelineRunEdits,
      triggerBindingEdits,
      triggerTemplateEdits,
      listenerTriggerEdits,
      listenerBindingEdits,
      listenerTemplateEdits,
    });
    failures++;
  }
}

console.log("\nrename: TriggerTemplate's own param, $(tt.params.X) references included:");
{
  // $(tt.params.X) is a distinct ParamRef kind ("tt-param") from $(params.X) ("param"), even
  // though both refer to the same spec.params declaration list -- sameDocumentEdits/
  // resolveRenameTarget need to treat them as the same rename target, not just hover/diagnostics.
  const source = fs.readFileSync(path.join(__dirname, "all-kinds-multidoc.yaml"), "utf8");
  const template = parseTektonFile(source).find((d) => d.symbols.metadataName === "mdk-template");

  const declOffset = source.indexOf("name: gitrevision") + "name: ".length;
  const declTarget = resolveRenameTarget(template, declOffset);

  const refOffset = source.indexOf("$(tt.params.gitrevision)") + "$(tt.params.".length;
  const refTarget = resolveRenameTarget(template, refOffset);

  const edits = sameDocumentEdits(template, "param", "gitrevision", "revision");
  const applied = applyTextEdits(source, edits);
  const renamedOk = applied.includes("name: revision") && applied.includes("$(tt.params.revision)");

  const ok =
    declTarget?.kind === "param" &&
    declTarget.name === "gitrevision" &&
    refTarget?.kind === "param" &&
    refTarget.name === "gitrevision" &&
    edits.length === 2 &&
    renamedOk;
  console.log(`  [${ok ? "PASS" : "FAIL"}] declaration(${declTarget?.kind}) and $(tt.params.X) ref(${refTarget?.kind}) resolve to the same target, rename updates both (${edits.length} edit(s))`);
  if (!ok) {
    console.log({ declTarget, refTarget, edits, applied });
    failures++;
  }
}

console.log("\ntask-param binding: hover/go-to-definition/diagnostic all resolve against the referenced Task's declared param:");
{
  // hover.ts/definitions.ts/diagnostics.ts each need real vscode classes (vscode.Hover,
  // vscode.Location, vscode.Diagnostic) this harness doesn't shim -- so, same as the trigger
  // ref-validation blocks above, this mirrors the resolution logic in plain JS against
  // resolveRenameTarget (vscode-free) and a tiny fake index standing in for
  // TektonWorkspaceIndex.lookupTask.
  const source = fs.readFileSync(path.join(__dirname, "all-kinds-multidoc.yaml"), "utf8");
  const docs = parseTektonFile(source);
  const pipeline = docs.find((d) => d.symbols.metadataName === "mdk-pipeline");
  const task = docs.find((d) => d.symbols.metadataName === "mdk-task");
  const fakeIndex = { lookupTask: (name) => (name === "mdk-task" ? task.symbols : undefined) };

  // cursor on the Pipeline task entry's own `params: [{name: greeting, ...}]` binding
  const bindingOffset = source.indexOf("- name: greeting\n          value: $(params.greeting)") + "- name: ".length;
  const target = resolveRenameTarget(pipeline, bindingOffset);
  const targetOk = target?.kind === "task-param" && target.paramName === "greeting" && target.taskRefName === "mdk-task";

  // hover/definition: resolve the binding's paramName against the referenced Task's own declared param
  const resolvedParam = targetOk && fakeIndex.lookupTask(target.taskRefName)?.params.find((p) => p.name === target.paramName);
  const hoverOk = resolvedParam?.type === "string" && resolvedParam?.description === "The very important greeting parameter";

  // diagnostic: an unknown binding name against the same resolved Task should be flagged, a known one shouldn't
  const knownNames = task.symbols.params.map((p) => p.name);
  const flagged = (name) => !knownNames.includes(name);
  const diagnosticOk = flagged("not-a-real-param") === true && flagged("greeting") === false;

  const ok = targetOk && hoverOk && diagnosticOk;
  console.log(`  [${ok ? "PASS" : "FAIL"}] target resolves(${targetOk}), hover/definition resolves the declared param(${hoverOk}), diagnostic flags unknown/accepts known(${diagnosticOk})`);
  if (!ok) {
    console.log({ target, resolvedParam, knownNames });
    failures++;
  }
}

console.log("\nrename: duplicate-name ambiguity trap detection:");
{
  // Two different Task files legitimately declaring the same metadata.name
  // (a vendored/catalog Task present in more than one chart) — the data
  // TektonRenameProvider's ambiguity guard depends on (workspaceIndex
  // grouping by metadataName) must actually show 2 entries here, or the
  // guard has nothing to detect.
  const a = parseTektonDocument(fs.readFileSync(path.join(__dirname, "task-build-image.yaml"), "utf8"));
  const b = parseTektonDocument(fs.readFileSync(path.join(__dirname, "task-build-image-duplicate.yaml"), "utf8"));
  const ok = a.symbols.metadataName === "build-image" && b.symbols.metadataName === "build-image" && a.symbols.metadataName === b.symbols.metadataName;
  console.log(`  [${ok ? "PASS" : "FAIL"}] two Task files share metadata.name "build-image" (ambiguity guard has something to detect)`);
  if (!ok) failures++;
}

console.log("\nrename: pipeline identity (metadata.name <-> pipelineRef.name):");
{
  // pipeline-typo.yaml's Pipeline is named "build-and-deploy"; this PipelineRun references it.
  const pipelineSource = fs.readFileSync(path.join(__dirname, "pipeline-typo.yaml"), "utf8");
  const runSource = fs.readFileSync(path.join(__dirname, "pipelinerun-refs-build.yaml"), "utf8");
  const pipelineParsed = parseTektonDocument(pipelineSource);
  const runParsed = parseTektonDocument(runSource);

  // Invoked FROM the PipelineRun's pipelineRef.name, not the Pipeline's own declaration
  // (or metadata.name: build-and-deploy-run, which also contains this substring).
  const refOffset = runSource.indexOf("name: build-and-deploy\n") + "name: ".length + 3;
  const target = resolveRenameTarget(runParsed, refOffset);
  const ok1 = target?.kind === "pipeline-identity" && target.name === "build-and-deploy";

  const pipelineEdits = target ? [{ range: pipelineParsed.symbols.metadataNameRange, newText: "ship-it" }] : [];
  const runEdits = pipelineRefIdentityEdits(runParsed, "build-and-deploy", "ship-it");
  const pipelineResult = applyTextEdits(pipelineSource, pipelineEdits);
  const runResult = applyTextEdits(runSource, runEdits);

  const ok2 = parseTektonDocument(pipelineResult)?.symbols.metadataName === "ship-it";
  const ok3 = parseTektonDocument(runResult)?.symbols.pipelineRefName === "ship-it";
  const ok = ok1 && ok2 && ok3;
  console.log(`  [${ok ? "PASS" : "FAIL"}] "build-and-deploy" -> "ship-it": target=${ok1}, pipeline-file=${!!ok2}, run-file=${!!ok3}`);
  if (!ok) {
    console.log({ target, pipelineResult, runResult });
    failures++;
  }
}

console.log("\nrename: TaskRun's own taskRef (structurally different field from a Pipeline task entry's taskRef):");
{
  const taskRunSource = fs.readFileSync(path.join(__dirname, "taskrun-ref.yaml"), "utf8");
  const taskRunParsed = parseTektonDocument(taskRunSource);

  const refOffset = taskRunSource.indexOf("build-image") + 3;
  const target = resolveRenameTarget(taskRunParsed, refOffset);
  const ok1 = target?.kind === "task-identity" && target.name === "build-image";

  const edits = taskRefIdentityEdits(taskRunParsed, "build-image", "compile-image");
  const result = applyTextEdits(taskRunSource, edits);
  const ok2 = parseTektonDocument(result)?.symbols.taskRefName === "compile-image";
  const ok = ok1 && ok2 && edits.length === 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] taskrun-ref.yaml: "build-image" -> "compile-image" (${edits.length} edit(s))`);
  if (!ok) {
    console.log({ target, edits, result });
    failures++;
  }
}

console.log("\nrename: reject (not guess) when resolving an ambiguous name FROM a reference:");
{
  // rename.ts's TektonRenameProvider itself can't run under plain Node (it
  // imports "vscode"), so this mirrors its resolveIdentityRecord() /
  // resolveUnambiguous() decision logic exactly, to lock in the fix for a
  // real reported bug: renaming a Pipeline from a PipelineRun's
  // pipelineRef.name, when that name is ambiguous (two Pipeline files
  // share it), used to silently rename one arbitrary candidate while
  // leaving the actual clicked reference untouched. The fix rejects
  // outright instead of guessing whenever resolution starts from a
  // reference (not the declaration itself).
  function resolveIdentity(invokedOnOwnDeclaration, name, allCandidateUris) {
    if (invokedOnOwnDeclaration) return { ok: true, uri: "CURRENT_DOCUMENT" };
    if (allCandidateUris.length === 0) return { ok: false, reason: "not-found" };
    if (allCandidateUris.length > 1) return { ok: false, reason: "ambiguous" };
    return { ok: true, uri: allCandidateUris[0] };
  }

  // Invoked FROM a PipelineRun's pipelineRef.name (not the declaration), name is ambiguous.
  const fromReference = resolveIdentity(false, "build-and-deploy", ["fileA.yaml", "fileB.yaml"]);
  const ok1 = fromReference.ok === false && fromReference.reason === "ambiguous";

  // Invoked directly ON one of the two same-named declarations — must still succeed (case is unambiguous by construction).
  const fromDeclaration = resolveIdentity(true, "build-and-deploy", ["fileA.yaml", "fileB.yaml"]);
  const ok2 = fromDeclaration.ok === true && fromDeclaration.uri === "CURRENT_DOCUMENT";

  // Invoked from a reference where the name is NOT ambiguous — must still succeed normally.
  const unambiguous = resolveIdentity(false, "build-and-deploy", ["fileA.yaml"]);
  const ok3 = unambiguous.ok === true && unambiguous.uri === "fileA.yaml";

  const ok = ok1 && ok2 && ok3;
  console.log(`  [${ok ? "PASS" : "FAIL"}] from-reference+ambiguous=reject(${ok1}), from-declaration=always-ok(${ok2}), from-reference+unambiguous=ok(${ok3})`);
  if (!ok) failures++;
}

// --- addTask / addConditional / bindParamToEnv: precise container detection ---
//
// The old implementations used findEnclosingMap() (innermost map at the
// cursor, full stop) plus an ad-hoc ".get('name') truthy" check to decide
// "is this a task/step entry?". A params-list item (`- name: repo`) inside
// a task, or an env-list item inside a step, also has a `name` key —
// cursor positioned there would be silently misidentified as the task/step
// itself, corrupting the insert. pipelineTaskEntryMaps/
// stepAndSidecarEntryMaps only ever consider actual list entries, so
// membership is correct regardless of what's nested inside them.

console.log("\naddConditional: precise task-entry detection (not just \"innermost map with a name field\"):");
{
  const source = fs.readFileSync(path.join(__dirname, "pipeline-typo.yaml"), "utf8");
  const parsed = parseTektonDocument(source);

  // Offset deep inside the "build" task's OWN params list item (name: repo).
  const paramItemOffset = source.indexOf("name: repo") + 3;
  const entry = findEnclosingTaskEntry(parsed, paramItemOffset);
  const ok = entry?.get("name") === "build";
  console.log(`  [${ok ? "PASS" : "FAIL"}] cursor inside task's own params item resolves to the task ("build"), not the params item`);
  if (!ok) {
    console.log({ resolvedName: entry?.get("name") });
    failures++;
  }
}

console.log("\nbindParamToEnv: precise step-entry detection:");
{
  const source = fs.readFileSync(path.join(__dirname, "task-two-steps.yaml"), "utf8");
  const parsed = parseTektonDocument(source);

  // Offset inside the "push" step's OWN existing env list item (name: EXISTING).
  const envItemOffset = source.indexOf("name: EXISTING") + 3;
  const entry = findEnclosingStepEntry(parsed, envItemOffset);
  const ok = entry?.get("name") === "push";
  console.log(`  [${ok ? "PASS" : "FAIL"}] cursor inside step's own env item resolves to the step ("push"), not the env item`);
  if (!ok) {
    console.log({ resolvedName: entry?.get("name") });
    failures++;
  }
}

console.log("\nresolvePipelineSpecOwner / resolveTaskSpecOwner: Run-inline-spec awareness:");
{
  const pipelineRunInline = parseTektonDocument(fs.readFileSync(path.join(__dirname, "pipelinerun-inline.yaml"), "utf8"));
  const pipelineOwner = resolvePipelineSpecOwner(pipelineRunInline);
  const ok1 = pipelineOwner !== undefined && findSeqIn(pipelineOwner.ownerMap, "tasks")?.items.length === 1;

  const pipelineRunRef = parseTektonDocument(fs.readFileSync(path.join(__dirname, "pipelinerun-ref.yaml"), "utf8"));
  const ok2 = resolvePipelineSpecOwner(pipelineRunRef) === undefined; // no inline pipelineSpec — nothing to add tasks to

  const taskRunInline = parseTektonDocument(fs.readFileSync(path.join(__dirname, "taskrun-inline.yaml"), "utf8"));
  const taskOwner = resolveTaskSpecOwner(taskRunInline);
  const ok3 = taskOwner !== undefined && findSeqIn(taskOwner.ownerMap, "steps")?.items.length === 1;

  const ok = ok1 && ok2 && ok3;
  console.log(
    `  [${ok ? "PASS" : "FAIL"}] pipelineRun+inline finds tasks(${ok1}), pipelineRun+ref finds nothing(${ok2}), taskRun+inline finds steps(${ok3})`
  );
  if (!ok) failures++;
}

/** Mirrors addTask.ts's own splicing logic (minus vscode calls). */
function simulateAddTask(source, itemLines) {
  const parsed = parseTektonDocument(source);
  const owner = resolvePipelineSpecOwner(parsed);
  if (!owner) return { owner: undefined };

  const seq = findSeqIn(owner.ownerMap, "tasks");
  let text, offset;
  if (seq?.range) {
    const lastItem = seq.items[seq.items.length - 1];
    const rawAnchor = lastItem?.range ? lastItem.range[1] : seq.range[1];
    offset = trimTrailingNewline(parsed.text, rawAnchor);
    const lineStart = parsed.text.lastIndexOf("\n", seq.range[0] - 1) + 1;
    const itemIndent = lastItem ? parsed.text.slice(lineStart, seq.range[0]) : owner.keyIndent + "  ";
    text = blockAfterText(itemLines, itemIndent);
  } else {
    offset = trimTrailingNewline(parsed.text, owner.ownerMapEnd);
    text = blockAfterText(["tasks:", ...itemLines.map((l) => "  " + l)], owner.keyIndent);
  }
  return { owner, result: source.slice(0, offset) + text + source.slice(offset) };
}

console.log("\naddTask simulation (context-aware target + no cursor):");
{
  const itemLines = ["- name: new-task", "  taskRef:", "    name: new-task-ref", "  runAfter: []", "  params: []"];

  for (const file of ["pipeline-typo.yaml", "pipelinerun-inline.yaml"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    const { owner, result } = simulateAddTask(source, itemLines);
    const ok = owner !== undefined && (() => {
      try {
        const after = YAML.parse(result);
        return containsNamedEntry(after, "new-task");
      } catch {
        return false;
      }
    })();
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${file} (append to existing tasks list)`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }

  // No spec.tasks list at all yet — must create it fresh, still cursor-independent.
  {
    const file = "pipeline-empty.yaml";
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    const { owner, result } = simulateAddTask(source, itemLines);
    let after, ok;
    try {
      after = YAML.parse(result);
      ok = owner !== undefined && containsNamedEntry(after, "new-task") && Array.isArray(after.spec.tasks);
    } catch {
      ok = false;
    }
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${file} (fresh tasks: list created)`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }
}

/** Mirrors editUtils.ts's indentAt() — leading whitespace only, stopping before any "- " sequence marker. */
function indentAtOffset(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", lineStart);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return /^[ \t]*/.exec(line)[0];
}

/** Mirrors bindParamToEnv.ts's own splicing logic for both branches (append to existing env:, or create fresh). */
function simulateBindParamToEnv(source, stepName, envName, paramName) {
  const parsed = parseTektonDocument(source);
  const container = stepAndSidecarEntryMaps(parsed).find((m) => m.get("name") === stepName);
  if (!container?.range) return { container: undefined };

  const existingEnv = container.get("env", true);
  let text, offset;
  if (existingEnv && existingEnv.range && Array.isArray(existingEnv.items)) {
    const lastItem = existingEnv.items[existingEnv.items.length - 1];
    const rawAnchor = lastItem?.range ? lastItem.range[1] : existingEnv.range[1];
    offset = trimTrailingNewline(parsed.text, rawAnchor);
    const indent = indentAtOffset(parsed.text, existingEnv.range[0]);
    text = blockAfterText([`- name: ${envName}`, `  value: $(params.${paramName})`], indent);
  } else {
    const indent = indentAtOffset(parsed.text, container.range[0]);
    offset = trimTrailingNewline(parsed.text, container.range[1]);
    text = blockAfterText(["env:", `  - name: ${envName}`, `    value: $(params.${paramName})`], indent + "  ");
  }
  return { container, result: source.slice(0, offset) + text + source.slice(offset) };
}

console.log("\nbindParamToEnv simulation:");
{
  const source = fs.readFileSync(path.join(__dirname, "task-two-steps.yaml"), "utf8");

  // "build" has no env: list yet — must create one.
  {
    const { container, result } = simulateBindParamToEnv(source, "build", "TARGET", "target");
    let after, ok;
    try {
      after = YAML.parse(result);
      const buildStep = after.spec.steps.find((s) => s.name === "build");
      ok = container !== undefined && buildStep?.env?.some((e) => e.name === "TARGET");
    } catch {
      ok = false;
    }
    console.log(`  [${ok ? "PASS" : "FAIL"}] "build" step: fresh env: list created`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }

  // "push" already has an env: list — must append, not clobber EXISTING.
  {
    const { container, result } = simulateBindParamToEnv(source, "push", "TARGET", "target");
    let after, ok;
    try {
      after = YAML.parse(result);
      const pushStep = after.spec.steps.find((s) => s.name === "push");
      ok =
        container !== undefined &&
        pushStep?.env?.some((e) => e.name === "TARGET") &&
        pushStep?.env?.some((e) => e.name === "EXISTING");
    } catch {
      ok = false;
    }
    console.log(`  [${ok ? "PASS" : "FAIL"}] "push" step: appended to existing env: list, EXISTING entry preserved`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }
}

/** Mirrors editUtils.ts's toEnvVarName(). */
function simToEnvVarName(name) {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+|_+$/g, "");
  return snake || "VALUE";
}

/** Mirrors editUtils.ts's alreadyBoundParamNames(). */
function simAlreadyBoundParamNames(container) {
  const bound = new Set();
  const env = container.get("env", true);
  if (!env || !Array.isArray(env.items)) return bound;
  for (const item of env.items) {
    const valueNode = item.get && item.get("value", true);
    const value = valueNode && typeof valueNode.value === "string" ? valueNode.value : undefined;
    const m = value && /^\$\(params\.([^.)]+)\)$/.exec(value.trim());
    if (m) bound.add(m[1]);
  }
  return bound;
}

/** Mirrors editUtils.ts's existingEnvNames(). */
function simExistingEnvNames(container) {
  const names = new Set();
  const env = container.get("env", true);
  if (!env || !Array.isArray(env.items)) return names;
  for (const item of env.items) {
    const nameNode = item.get && item.get("name", true);
    if (nameNode && typeof nameNode.value === "string") names.add(nameNode.value);
  }
  return names;
}

/** Mirrors editUtils.ts's uniqueEnvName(). */
function simUniqueEnvName(base, used) {
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}_${n++}`;
  used.add(candidate);
  return candidate;
}

/** Mirrors editUtils.ts's insertEnvBindings() generalized to N bindings. */
function simulateInsertEnvBindings(source, stepName, bindings) {
  const parsed = parseTektonDocument(source);
  const container = stepAndSidecarEntryMaps(parsed).find((m) => m.get("name") === stepName);
  if (!container?.range) return { container: undefined };

  const entryLines = bindings.flatMap(({ envName, paramName }) => [`- name: ${envName}`, `  value: $(params.${paramName})`]);
  const existingEnv = container.get("env", true);
  let text, offset;
  if (existingEnv && existingEnv.range && Array.isArray(existingEnv.items)) {
    const lastItem = existingEnv.items[existingEnv.items.length - 1];
    const rawAnchor = lastItem?.range ? lastItem.range[1] : existingEnv.range[1];
    offset = trimTrailingNewline(parsed.text, rawAnchor);
    const indent = indentAtOffset(parsed.text, existingEnv.range[0]);
    text = blockAfterText(entryLines, indent);
  } else {
    const indent = indentAtOffset(parsed.text, container.range[0]);
    offset = trimTrailingNewline(parsed.text, container.range[1]);
    text = blockAfterText(["env:", ...entryLines.map((l) => "  " + l)], indent + "  ");
  }
  return { container, result: source.slice(0, offset) + text + source.slice(offset) };
}

console.log("\nbindAllParamsToEnv simulation:");
{
  const source = fs.readFileSync(path.join(__dirname, "task-multi-param.yaml"), "utf8");
  const parsed = parseTektonDocument(source);
  const params = parsed.symbols.params.map((p) => p.name);

  // "build": no existing env, no params bound yet -- all 3 candidates offered, and the
  // image-tag/imageTag name collision (both derive to IMAGE_TAG) gets disambiguated.
  {
    const container = stepAndSidecarEntryMaps(parsed).find((m) => m.get("name") === "build");
    const alreadyBound = simAlreadyBoundParamNames(container);
    const candidates = params.filter((p) => !alreadyBound.has(p));
    const usedNames = simExistingEnvNames(container);
    const bindings = candidates.map((p) => ({ envName: simUniqueEnvName(simToEnvVarName(p), usedNames), paramName: p }));

    const okCandidates = candidates.length === 3;
    const okCollision =
      bindings.find((b) => b.paramName === "image-tag")?.envName === "IMAGE_TAG" &&
      bindings.find((b) => b.paramName === "imageTag")?.envName === "IMAGE_TAG_2";
    console.log(
      `  [${okCandidates && okCollision ? "PASS" : "FAIL"}] "build": all 3 params candidates, image-tag/imageTag collision disambiguated (${JSON.stringify(bindings)})`
    );
    if (!(okCandidates && okCollision)) failures++;

    const { result } = simulateInsertEnvBindings(source, "build", bindings);
    let ok;
    try {
      const after = YAML.parse(result);
      const buildStep = after.spec.steps.find((s) => s.name === "build");
      ok = buildStep?.env?.length === 3 && new Set(buildStep.env.map((e) => e.name)).size === 3;
    } catch {
      ok = false;
    }
    console.log(`  [${ok ? "PASS" : "FAIL"}] "build": all 3 bindings inserted with distinct env var names`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }

  // "deploy": "region" is already bound via $(params.region) -- excluded from candidates.
  {
    const container = stepAndSidecarEntryMaps(parsed).find((m) => m.get("name") === "deploy");
    const alreadyBound = simAlreadyBoundParamNames(container);
    const candidates = params.filter((p) => !alreadyBound.has(p));
    const ok = alreadyBound.has("region") && !candidates.includes("region") && candidates.length === 2;
    console.log(`  [${ok ? "PASS" : "FAIL"}] "deploy": already-bound "region" excluded from candidates (${JSON.stringify(candidates)})`);
    if (!ok) failures++;
  }
}

/** Mirrors addConditional.ts's own splicing logic for both branches (append to existing when:, or create fresh). */
function simulateAddConditional(source, taskName, inputExpr, values) {
  const parsed = parseTektonDocument(source);
  const taskEntry = pipelineTaskEntryMaps(parsed).find((m) => m.get("name") === taskName);
  if (!taskEntry?.range) return { taskEntry: undefined };

  const itemLines = [
    `- input: ${quoteYamlString(inputExpr)}`,
    `  operator: in`,
    `  values: [${values.map((v) => quoteYamlString(v)).join(", ")}]`,
  ];

  const existingWhen = taskEntry.get("when", true);
  let text, offset;
  if (existingWhen && existingWhen.range && Array.isArray(existingWhen.items)) {
    const lastItem = existingWhen.items[existingWhen.items.length - 1];
    const rawAnchor = lastItem?.range ? lastItem.range[1] : existingWhen.range[1];
    offset = trimTrailingNewline(parsed.text, rawAnchor);
    const itemIndent = indentAtOffset(parsed.text, existingWhen.range[0]);
    text = blockAfterText(itemLines, itemIndent);
  } else {
    const nameNode = taskEntry.get("name", true);
    offset = trimTrailingNewline(parsed.text, nameNode?.range ? nameNode.range[1] : taskEntry.range[0]);
    const taskIndent = indentAtOffset(parsed.text, taskEntry.range[0]);
    text = blockAfterText(["when:", ...itemLines.map((l) => "  " + l)], taskIndent + "  ");
  }
  return { taskEntry, result: source.slice(0, offset) + text + source.slice(offset) };
}

console.log("\naddConditional simulation:");
{
  const source = fs.readFileSync(path.join(__dirname, "pipeline-typo.yaml"), "utf8");

  // "build" has no when: yet.
  {
    const { taskEntry, result } = simulateAddConditional(source, "build", "$(params.deploy-env)", ["production"]);
    let after, ok;
    try {
      after = YAML.parse(result);
      const buildTask = after.spec.tasks.find((t) => t.name === "build");
      ok = taskEntry !== undefined && buildTask?.when?.[0]?.values?.includes("production");
    } catch {
      ok = false;
    }
    console.log(`  [${ok ? "PASS" : "FAIL"}] "build" task: fresh when: added`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }

  // "deploy" already has a when: — must append, not clobber the existing condition.
  {
    const { taskEntry, result } = simulateAddConditional(source, "deploy", "$(params.image-repo)", ["ghcr.io"]);
    let after, ok;
    try {
      after = YAML.parse(result);
      const deployTask = after.spec.tasks.find((t) => t.name === "deploy");
      ok =
        taskEntry !== undefined &&
        deployTask?.when?.length === 2 &&
        deployTask.when.some((w) => w.values.includes("production")) &&
        deployTask.when.some((w) => w.values.includes("ghcr.io"));
    } catch {
      ok = false;
    }
    console.log(`  [${ok ? "PASS" : "FAIL"}] "deploy" task: appended to existing when:, original condition preserved`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }
}

// --- Find All References: cross-file, and permissive on ambiguity ---
//
// references.ts's TektonReferenceProvider itself needs vscode (workspace
// scanning, Location objects) and can't run under plain Node. What's tested
// here is its one piece of decision logic that differs from rename: unlike
// rename (which must reject an ambiguous name outright — silently picking
// one candidate to rewrite risks corrupting the wrong file), find-
// references is read-only, so on an ambiguous name it searches every
// matching candidate and merges the results.

console.log("\nFind All References: cross-file result, merges every ambiguous candidate:");
{
  // task-build-image.yaml and task-build-image-duplicate.yaml both declare
  // metadata.name: build-image (the same fixture pair the rename ambiguity
  // tests use) — simulates workspaceIndex.lookupAllTaskRecords("build-image")
  // returning both, and references.ts iterating all of them rather than
  // rejecting.
  const candidateFiles = ["task-build-image.yaml", "task-build-image-duplicate.yaml"];
  const pipelineFile = "pipeline-uses-result.yaml"; // references $(tasks.build.results.digest), taskRef: build-image

  const found = []; // { file, kind: "decl"|"self-ref"|"cross-ref" }
  for (const file of candidateFiles) {
    const parsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, file), "utf8"));
    for (const range of sameDocumentResultEdits(parsed, "digest", "digest").map((e) => e.range)) {
      found.push({ file, range });
    }
  }
  const pipelineParsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, pipelineFile), "utf8"));
  for (const taskEntry of pipelineParsed.symbols.tasks) {
    if (taskEntry.taskRefName !== "build-image") continue;
    for (const range of taskResultReferenceEdits(pipelineParsed, taskEntry.name, "digest", "digest").map((e) => e.range)) {
      found.push({ file: pipelineFile, range });
    }
  }

  const ok =
    found.some((f) => f.file === "task-build-image.yaml") &&
    found.some((f) => f.file === "task-build-image-duplicate.yaml") &&
    found.some((f) => f.file === pipelineFile);
  console.log(`  [${ok ? "PASS" : "FAIL"}] references found across both ambiguous Task files and the referencing Pipeline (${found.length} total)`);
  if (!ok) {
    console.log(found);
    failures++;
  }
}

console.log("\nFind All References: cross-file task identity (taskRef.name, both a Pipeline task entry and a TaskRun's own taskRef):");
{
  const pipelineSource = fs.readFileSync(path.join(__dirname, "pipeline-crossfile.yaml"), "utf8");
  const taskRunSource = fs.readFileSync(path.join(__dirname, "taskrun-ref.yaml"), "utf8");
  const pipelineParsed = parseTektonDocument(pipelineSource);
  const taskRunParsed = parseTektonDocument(taskRunSource);

  const pipelineRefs = taskRefIdentityEdits(pipelineParsed, "build-image", "build-image");
  const taskRunRefs = taskRefIdentityEdits(taskRunParsed, "build-image", "build-image");

  const ok = pipelineRefs.length === 1 && taskRunRefs.length === 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] found in both the Pipeline task entry (${pipelineRefs.length}) and the TaskRun's own taskRef (${taskRunRefs.length})`);
  if (!ok) failures++;
}

console.log("\nFind All References: cross-file pipeline identity (pipelineRef.name):");
{
  const runSource = fs.readFileSync(path.join(__dirname, "pipelinerun-refs-build.yaml"), "utf8");
  const runParsed = parseTektonDocument(runSource);
  const refs = pipelineRefIdentityEdits(runParsed, "build-and-deploy", "build-and-deploy");
  const ok = refs.length === 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] found the PipelineRun's pipelineRef.name (${refs.length} match(es))`);
  if (!ok) failures++;
}

// --- Missing runAfter: detection + quick fix ---

console.log("\nmissing-runAfter detection:");
{
  const source = fs.readFileSync(path.join(__dirname, "pipeline-missing-runafter.yaml"), "utf8");
  const parsed = parseTektonDocument(source);
  const found = findMissingRunAfter(parsed);
  console.log("  found:", found.map((f) => `${f.taskName} -> ${f.missingTaskRef}`));

  const ok =
    found.length === 2 &&
    found.some((f) => f.taskName === "deploy" && f.missingTaskRef === "build") &&
    found.some((f) => f.taskName === "audit" && f.missingTaskRef === "deploy") &&
    // "notify" has runAfter but references no task result — must NOT be flagged.
    !found.some((f) => f.taskName === "notify") &&
    // "audit" already lists "build" in runAfter (and references it) — must NOT be (re-)flagged for build.
    !found.some((f) => f.taskName === "audit" && f.missingTaskRef === "build");
  console.log(`  [${ok ? "PASS" : "FAIL"}] flags "deploy"->build (fresh runAfter case) and "audit"->deploy (append case) only`);
  if (!ok) failures++;
}

/** Mirrors codeActions.ts's addRunAfterFix logic exactly (minus the vscode.CodeAction wrapper). */
function simulateAddRunAfter(source, taskName, missingTaskRef) {
  const parsed = parseTektonDocument(source);
  const taskEntry = pipelineTaskEntryMaps(parsed).find((m) => m.get("name") === taskName);
  if (!taskEntry?.range) return { taskEntry: undefined };

  const runAfterNode = taskEntry.get("runAfter", true);
  let text, offset;
  if (runAfterNode && runAfterNode.range && Array.isArray(runAfterNode.items)) {
    const lastItem = runAfterNode.items[runAfterNode.items.length - 1];
    const rawAnchor = lastItem?.range ? lastItem.range[1] : runAfterNode.range[1];
    offset = trimTrailingNewline(parsed.text, rawAnchor);
    const itemIndent = indentAtOffset(parsed.text, runAfterNode.range[0]);
    text = blockAfterText([`- ${missingTaskRef}`], itemIndent);
  } else {
    offset = trimTrailingNewline(parsed.text, taskEntry.range[1]);
    const taskIndent = indentAtOffset(parsed.text, taskEntry.range[0]);
    text = blockAfterText(["runAfter:", `  - ${missingTaskRef}`], taskIndent + "  ");
  }
  return { taskEntry, result: source.slice(0, offset) + text + source.slice(offset) };
}

console.log("\nmissing-runAfter quick fix simulation:");
{
  const source = fs.readFileSync(path.join(__dirname, "pipeline-missing-runafter.yaml"), "utf8");

  // "deploy" has no runAfter yet — must create it.
  {
    const { taskEntry, result } = simulateAddRunAfter(source, "deploy", "build");
    let after, ok;
    try {
      after = YAML.parse(result);
      const deployTask = after.spec.tasks.find((t) => t.name === "deploy");
      ok = taskEntry !== undefined && Array.isArray(deployTask?.runAfter) && deployTask.runAfter.includes("build");
    } catch {
      ok = false;
    }
    console.log(`  [${ok ? "PASS" : "FAIL"}] "deploy": fresh runAfter: [build] created`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }

  // "audit" already has runAfter: [build] — must append "deploy", not clobber "build".
  {
    const { taskEntry, result } = simulateAddRunAfter(source, "audit", "deploy");
    let after, ok;
    try {
      after = YAML.parse(result);
      const auditTask = after.spec.tasks.find((t) => t.name === "audit");
      ok =
        taskEntry !== undefined &&
        auditTask?.runAfter?.length === 2 &&
        auditTask.runAfter.includes("build") &&
        auditTask.runAfter.includes("deploy");
    } catch {
      ok = false;
    }
    console.log(`  [${ok ? "PASS" : "FAIL"}] "audit": appended "deploy" to existing runAfter: [build]`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }
}

// --- Tekton Triggers: parsing, unknown-ref detection, cross-file identity rename ---

console.log("\nTrigger domain model parsing:");
{
  const files = [
    ["triggerbinding.yaml", "TriggerBinding"],
    ["clustertriggerbinding.yaml", "ClusterTriggerBinding"],
    ["triggertemplate.yaml", "TriggerTemplate"],
    ["eventlistener-crossfile.yaml", "EventListener"],
    ["trigger.yaml", "Trigger"],
    ["eventlistener.yaml", "EventListener"],
  ];
  let ok = true;
  for (const [file, expectedKind] of files) {
    const parsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, file), "utf8"));
    const kindOk = parsed && parsed.symbols.kind === expectedKind;
    console.log(`  ${file}: kind=${parsed && parsed.symbols.kind} (expected ${expectedKind})`);
    if (!kindOk) ok = false;
  }
  console.log(`  [${ok ? "PASS" : "FAIL"}] every trigger fixture recognized as its expected kind`);
  if (!ok) failures++;
}

console.log("\nTriggerBinding params (name/value, not name/type/default):");
{
  const parsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, "triggerbinding.yaml"), "utf8"));
  const names = parsed.symbols.bindingParams.map((p) => p.name);
  const values = parsed.symbols.bindingParams.map((p) => p.value);
  const ok =
    JSON.stringify(names) === JSON.stringify(["gitrevision", "gitrepositoryurl", "contenttype"]) &&
    values[0] === "$(body.head_commit.id)";
  console.log(`  [${ok ? "PASS" : "FAIL"}] triggerbinding.yaml: bindingParams = ${JSON.stringify(names)}`);
  if (!ok) failures++;
}

console.log("\nEventListener trigger entries (bindings[].ref, template.ref, triggerRef):");
{
  const crossfile = parseTektonDocument(fs.readFileSync(path.join(__dirname, "eventlistener-crossfile.yaml"), "utf8"));
  const t1 = crossfile.symbols.triggers[0];
  const ok1 =
    t1 &&
    t1.bindingRefs.map((r) => r.name).join(",") === "github-binding" &&
    t1.templateRefName === "build-template" &&
    t1.interceptorNames.join(",") === "github";

  const delegated = parseTektonDocument(fs.readFileSync(path.join(__dirname, "eventlistener.yaml"), "utf8"));
  const t2 = delegated.symbols.triggers[0];
  const ok2 = t2 && t2.triggerRefName === "build-trigger";

  const standalone = parseTektonDocument(fs.readFileSync(path.join(__dirname, "trigger.yaml"), "utf8"));
  const ok3 =
    standalone.symbols.bindingRefs.map((r) => r.name).join(",") === "github-binding" &&
    standalone.symbols.templateRefName === "build-template";

  const ok = ok1 && ok2 && ok3;
  console.log(
    `  [${ok ? "PASS" : "FAIL"}] EventListener entries (${!!ok1}), triggerRef (${!!ok2}), standalone Trigger's own refs (${!!ok3})`
  );
  if (!ok) failures++;
}

console.log("\nunknown $(tt.params.X) reference detection:");
{
  const file = "triggertemplate-typo.yaml";
  const parsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, file), "utf8"));
  const names = parsed.symbols.params.map((p) => p.name);
  const ttRefs = findParamRefs(parsed.text).filter((r) => r.kind === "tt-param");
  const unknown = ttRefs.filter((r) => r.name && !names.includes(r.name));
  const suggestion = unknown.length === 1 ? closestMatch(unknown[0].name, names) : undefined;
  const ok = unknown.length === 1 && unknown[0].name === "gitrevisionn" && suggestion === "gitrevision";
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${file}: 1 unknown $(tt.params.X) ref ("gitrevisionn"), suggests "gitrevision"`);
  if (!ok) {
    console.log({ unknown, suggestion });
    failures++;
  }
}

// Mirrors checkTriggerRefs in diagnostics.ts (which can't be called directly
// from Node; it needs vscode.Diagnostic/vscode.Range and a live
// TektonWorkspaceIndex) — builds the same "does this ref resolve" check
// against a small in-memory index of the trigger fixtures above.
console.log("\nEventListener/Trigger ref validation (simulated workspace index):");
{
  function buildNameIndex(files) {
    const names = [];
    for (const file of files) {
      const parsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, file), "utf8"));
      if (parsed.symbols.metadataName) names.push(parsed.symbols.metadataName);
    }
    return names;
  }
  const bindingNames = buildNameIndex(["triggerbinding.yaml", "clustertriggerbinding.yaml"]);
  const templateNames = buildNameIndex(["triggertemplate.yaml"]);
  const triggerNames = buildNameIndex(["trigger.yaml"]);

  function checkFile(file) {
    const parsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, file), "utf8"));
    const unknown = [];
    const check = (name, known, label) => {
      if (name && !known.includes(name)) unknown.push({ label, name, suggestion: closestMatch(name, known) });
    };
    const checkTrigger = (t) => {
      for (const ref of t.bindingRefs || []) check(ref.name, bindingNames, "TriggerBinding");
      check(t.templateRefName, templateNames, "TriggerTemplate");
      check(t.triggerRefName, triggerNames, "Trigger");
    };
    if (parsed.symbols.kind === "EventListener") parsed.symbols.triggers.forEach(checkTrigger);
    else if (parsed.symbols.kind === "Trigger") checkTrigger(parsed.symbols);
    return unknown;
  }

  const validCrossfile = checkFile("eventlistener-crossfile.yaml");
  const validDelegated = checkFile("eventlistener.yaml");
  const validStandalone = checkFile("trigger.yaml");
  const typoResult = checkFile("eventlistener-typo.yaml");

  const ok =
    validCrossfile.length === 0 &&
    validDelegated.length === 0 &&
    validStandalone.length === 0 &&
    typoResult.length === 1 &&
    typoResult[0].label === "TriggerBinding" &&
    typoResult[0].name === "github-bindin" &&
    typoResult[0].suggestion === "github-binding";
  console.log(
    `  [${ok ? "PASS" : "FAIL"}] valid cross-file refs resolve clean; eventlistener-typo.yaml flags "github-bindin" -> "github-binding"`
  );
  if (!ok) {
    console.log({ validCrossfile, validDelegated, validStandalone, typoResult });
    failures++;
  }
}

// Mirrors checkTaskAndPipelineRefs in diagnostics.ts (same vscode-free
// constraint as the trigger-ref-validation block above) -- previously there
// was no check at all for an unresolved taskRef/pipelineRef (only completion
// and the separately-gated param-wiring checks touched them), so this covers
// the gap directly: a typo'd taskRef.name or pipelineRef.name should be
// flagged with a "did you mean" suggestion, the same as trigger-family refs
// already are.
console.log("\nTask/Pipeline ref validation (simulated workspace index):");
{
  const taskNames = ["git-clone", "build-image"];
  const pipelineNames = ["build-and-test"];

  function unresolvedRefs(parsed) {
    const unknown = [];
    for (const task of parsed.symbols.tasks) {
      if (task.taskRefName && !taskNames.includes(task.taskRefName)) {
        unknown.push({ label: "Task", name: task.taskRefName, suggestion: closestMatch(task.taskRefName, taskNames) });
      }
    }
    if (parsed.symbols.kind === "TaskRun" && parsed.symbols.taskRefName && !taskNames.includes(parsed.symbols.taskRefName)) {
      unknown.push({ label: "Task", name: parsed.symbols.taskRefName, suggestion: closestMatch(parsed.symbols.taskRefName, taskNames) });
    }
    if (
      parsed.symbols.kind === "PipelineRun" &&
      parsed.symbols.pipelineRefName &&
      !pipelineNames.includes(parsed.symbols.pipelineRefName)
    ) {
      unknown.push({ label: "Pipeline", name: parsed.symbols.pipelineRefName, suggestion: closestMatch(parsed.symbols.pipelineRefName, pipelineNames) });
    }
    return unknown;
  }

  const validPipeline = parseTektonDocument(`apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: uses-known-tasks
spec:
  tasks:
    - name: clone
      taskRef:
        name: git-clone
    - name: build
      taskRef:
        name: build-image
      runAfter:
        - clone
`);
  const okValid = unresolvedRefs(validPipeline).length === 0;
  console.log(`  [${okValid ? "PASS" : "FAIL"}] Pipeline referencing known Tasks: no unresolved refs`);
  if (!okValid) {
    console.log(unresolvedRefs(validPipeline));
    failures++;
  }

  const typoPipeline = parseTektonDocument(`apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: uses-typoed-task
spec:
  tasks:
    - name: clone
      taskRef:
        name: git-clonne
`);
  const typoResult = unresolvedRefs(typoPipeline);
  const okTypo = typoResult.length === 1 && typoResult[0].label === "Task" && typoResult[0].name === "git-clonne" && typoResult[0].suggestion === "git-clone";
  console.log(`  [${okTypo ? "PASS" : "FAIL"}] Pipeline task entry taskRef "git-clonne" flagged, suggests "git-clone" (${JSON.stringify(typoResult)})`);
  if (!okTypo) failures++;

  // Inline taskSpec: no taskRef.name to check at all -- correctly not flagged, not skipped by
  // coincidence.
  const inlineSpecPipeline = parseTektonDocument(`apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: uses-inline-taskspec
spec:
  tasks:
    - name: inline
      taskSpec:
        steps:
          - name: run
            image: alpine
            script: echo hi
`);
  const okInlineSpec = unresolvedRefs(inlineSpecPipeline).length === 0;
  console.log(`  [${okInlineSpec ? "PASS" : "FAIL"}] Pipeline task entry using inline taskSpec (no taskRef): not flagged`);
  if (!okInlineSpec) failures++;

  const typoPipelineRun = parseTektonDocument(`apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: run-it
spec:
  pipelineRef:
    name: build-and-tset
`);
  const runResult = unresolvedRefs(typoPipelineRun);
  const okRun = runResult.length === 1 && runResult[0].label === "Pipeline" && runResult[0].name === "build-and-tset" && runResult[0].suggestion === "build-and-test";
  console.log(`  [${okRun ? "PASS" : "FAIL"}] PipelineRun pipelineRef "build-and-tset" flagged, suggests "build-and-test" (${JSON.stringify(runResult)})`);
  if (!okRun) failures++;
}

// Mirrors checkTriggerTemplateParamWiring in diagnostics.ts (same vscode-free
// constraint as the ref-validation block above) -- builds the same "does the
// bound TriggerBinding set actually cover every required param" check
// against a small in-memory index of the trigger fixtures.
console.log("\nTriggerTemplate param-wiring check (simulated workspace index):");
{
  function buildRecordIndex(files) {
    const byName = new Map();
    for (const file of files) {
      const parsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, file), "utf8"));
      if (parsed.symbols.metadataName) byName.set(parsed.symbols.metadataName, parsed);
    }
    return byName;
  }
  const templates = buildRecordIndex(["triggertemplate.yaml"]);
  const bindings = buildRecordIndex(["triggerbinding.yaml", "triggerbinding-incomplete.yaml", "clustertriggerbinding.yaml"]);

  // Returns the list of missing required param names, or undefined if the template/a binding
  // doesn't resolve at all (not this check's job -- see checkTriggerRefs above).
  function missingParams(bindingRefs, inlineParamNames, templateRefName) {
    const template = templateRefName && templates.get(templateRefName);
    if (!template) return undefined;
    const provided = new Set(inlineParamNames);
    for (const ref of bindingRefs || []) {
      const binding = bindings.get(ref.name);
      if (!binding) return undefined;
      for (const p of binding.symbols.bindingParams) provided.add(p.name);
    }
    return template.symbols.params.filter((p) => p.default === undefined && !provided.has(p.name)).map((p) => p.name);
  }

  const elParsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, "eventlistener-missing-param.yaml"), "utf8"));
  const byTriggerName = Object.fromEntries(
    elParsed.symbols.triggers.map((t) => [t.name, missingParams(t.bindingRefs, t.inlineParamNames, t.templateRefName)])
  );

  const okMissing = JSON.stringify(byTriggerName.incomplete) === JSON.stringify(["gitrepositoryurl"]);
  console.log(
    `  [${okMissing ? "PASS" : "FAIL"}] "incomplete" trigger: flags missing required param "gitrepositoryurl" (${JSON.stringify(byTriggerName.incomplete)})`
  );
  if (!okMissing) failures++;

  const okInline = JSON.stringify(byTriggerName["inline-satisfied"]) === JSON.stringify([]);
  console.log(
    `  [${okInline ? "PASS" : "FAIL"}] "inline-satisfied" trigger: inline {name,value} binding entry covers the otherwise-missing param (${JSON.stringify(byTriggerName["inline-satisfied"])})`
  );
  if (!okInline) failures++;

  const crossfileParsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, "eventlistener-crossfile.yaml"), "utf8"));
  const crossfileMissing = crossfileParsed.symbols.triggers.map((t) => missingParams(t.bindingRefs, t.inlineParamNames, t.templateRefName));
  const okCrossfile = crossfileMissing.every((m) => m === undefined || m.length === 0);
  console.log(`  [${okCrossfile ? "PASS" : "FAIL"}] eventlistener-crossfile.yaml: fully-bound trigger reports no missing params (${JSON.stringify(crossfileMissing)})`);
  if (!okCrossfile) failures++;

  const unresolvedMissing = missingParams([{ name: "no-such-binding" }], [], "build-template");
  const okUnresolved = unresolvedMissing === undefined;
  console.log(`  [${okUnresolved ? "PASS" : "FAIL"}] unresolved binding ref -> skipped (undefined), not a false "missing" report`);
  if (!okUnresolved) failures++;
}

console.log("\nTask param-wiring check: missing required params on a taskRef (simulated workspace index):");
{
  // Mirrors checkTaskParamWiring in diagnostics.ts, same vscode-free constraint as the
  // TriggerTemplate param-wiring block above. Dedicated inline fixtures, since this needs a Task
  // with a genuinely *required* (no-default) param -- all-kinds-multidoc.yaml's mdk-task declares
  // "greeting" with a default, so it's never required and can't exercise the "missing" case.
  const taskSource = `apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: needs-two-params
spec:
  params:
    - name: image-tag
      type: string
    - name: region
      type: string
      default: us-east-1
  steps:
    - name: build
      script: echo $(params.image-tag) $(params.region)
`;
  const pipelineSource = `apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: p
spec:
  tasks:
    - name: incomplete
      taskRef:
        name: needs-two-params
      params:
        - name: region
          value: eu-west-1
    - name: complete
      taskRef:
        name: needs-two-params
      params:
        - name: image-tag
          value: latest
`;
  const taskRunSource = `apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  name: run
spec:
  taskRef:
    name: needs-two-params
`;
  const task = parseTektonDocument(taskSource);
  const pipeline = parseTektonDocument(pipelineSource);
  const taskRun = parseTektonDocument(taskRunSource);
  const tasksByName = new Map([[task.symbols.metadataName, task]]);

  // Returns the list of missing required param names, or undefined if the taskRef doesn't resolve
  // at all (not this check's job -- see checkTaskParamBindings above).
  function missingParams(taskRefName, providedNames) {
    const resolved = taskRefName && tasksByName.get(taskRefName);
    if (!resolved) return undefined;
    const provided = new Set(providedNames);
    return resolved.symbols.params.filter((p) => p.default === undefined && !provided.has(p.name)).map((p) => p.name);
  }

  const byTaskAlias = Object.fromEntries(
    pipeline.symbols.tasks.map((t) => [t.name, missingParams(t.taskRefName, t.paramBindings.map((pb) => pb.name))])
  );
  const okIncomplete = JSON.stringify(byTaskAlias.incomplete) === JSON.stringify(["image-tag"]);
  console.log(`  [${okIncomplete ? "PASS" : "FAIL"}] "incomplete" task entry: flags missing required param "image-tag" (${JSON.stringify(byTaskAlias.incomplete)})`);
  if (!okIncomplete) failures++;

  const okComplete = JSON.stringify(byTaskAlias.complete) === JSON.stringify([]);
  console.log(`  [${okComplete ? "PASS" : "FAIL"}] "complete" task entry: image-tag provided, region falls back to its default (${JSON.stringify(byTaskAlias.complete)})`);
  if (!okComplete) failures++;

  const taskRunMissing = missingParams(taskRun.symbols.taskRefName, taskRun.symbols.params.map((p) => p.name));
  const okTaskRun = JSON.stringify(taskRunMissing) === JSON.stringify(["image-tag"]);
  console.log(`  [${okTaskRun ? "PASS" : "FAIL"}] TaskRun with no params at all: flags missing required param "image-tag" (${JSON.stringify(taskRunMissing)})`);
  if (!okTaskRun) failures++;

  const unresolvedMissing = missingParams("no-such-task", []);
  const okUnresolved = unresolvedMissing === undefined;
  console.log(`  [${okUnresolved ? "PASS" : "FAIL"}] unresolved taskRef -> skipped (undefined), not a false "missing" report`);
  if (!okUnresolved) failures++;
}

/** Mirrors codeActions.ts's addTaskParamBindingFix/addAllTaskParamsFix (both go through insertParamBindingsEdit): adds every name in `paramNames` to a Pipeline task entry's or TaskRun's own params: binding, in one edit. */
function simulateAddTaskParamBinding(source, taskAlias, paramNames) {
  const parsed = parseTektonDocument(source);
  const owner =
    parsed.symbols.kind === "TaskRun"
      ? (() => {
          const target = resolveParamsTarget(parsed);
          return target?.shape === "binding" ? target : undefined;
        })()
      : (() => {
          const entryMap = pipelineTaskEntryMaps(parsed).find((m) => m.get("name") === taskAlias);
          if (!entryMap?.range) return undefined;
          return { ownerMap: entryMap, ownerMapEnd: entryMap.range[1], keyIndent: indentAtOffset(source, entryMap.range[0]) + "  " };
        })();
  if (!owner) return { owner: undefined };

  const itemLines = paramNames.flatMap((name) => [`- name: ${name}`, `  value: ""`]);
  const seq = findSeqIn(owner.ownerMap, "params");
  let offset, text;
  if (seq?.range) {
    const lastItem = seq.items[seq.items.length - 1];
    offset = trimTrailingNewline(parsed.text, lastItem?.range ? lastItem.range[1] : seq.range[1]);
    const itemIndent = lastItem ? indentAtOffset(source, seq.range[0]) : owner.keyIndent + "  ";
    text = blockAfterText(itemLines, itemIndent);
  } else {
    offset = trimTrailingNewline(parsed.text, owner.ownerMapEnd);
    text = blockAfterText(["params:", ...itemLines.map((l) => "  " + l)], owner.keyIndent);
  }
  return { owner, result: source.slice(0, offset) + text + source.slice(offset) };
}

/** Mirrors codeActions.ts's addTaskParamDefaultFix: adds `default: ""` to a Task's own declaration of `paramName`. */
function simulateAddTaskParamDefault(taskSource, paramName) {
  const parsed = parseTektonDocument(taskSource);
  const specMap = findSpecMap(parsed.doc);
  const paramsSeq = specMap && findSeqIn(specMap, "params");
  const paramItem = paramsSeq?.items.find((item) => YAML.isMap(item) && YAML.isScalar(item.get("name", true)) && item.get("name", true).value === paramName);
  if (!paramItem?.range) return { paramItem: undefined };

  const offset = trimTrailingNewline(parsed.text, paramItem.range[1]);
  // paramItem's own range starts on its "name:" key, not its "- " marker -- indentAtOffset (whole
  // line's leading whitespace) would stop short by the marker's width, same gotcha model.ts's own
  // indentAtOffset doc comment calls out. Column padding instead, mirroring codeActions.ts's columnIndent.
  const lineStart = parsed.text.lastIndexOf("\n", paramItem.range[0] - 1) + 1;
  const indent = " ".repeat(paramItem.range[0] - lineStart);
  const text = blockAfterText([`default: ""`], indent);
  return { paramItem, result: taskSource.slice(0, offset) + text + taskSource.slice(offset) };
}

console.log("\nmissing-task-param quick fix simulation (add binding, or add a default on the Task):");
{
  const taskSource = `apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: needs-two-params
spec:
  params:
    - name: image-tag
      type: string
    - name: region
      type: string
      default: us-east-1
  steps:
    - name: build
      script: echo $(params.image-tag) $(params.region)
`;
  const pipelineSource = `apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: p
spec:
  tasks:
    - name: incomplete
      taskRef:
        name: needs-two-params
      params:
        - name: region
          value: eu-west-1
`;
  const taskRunSource = `apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  name: run
spec:
  taskRef:
    name: needs-two-params
`;

  // "Add the binding" fix: Pipeline task entry already has a params: list -- append to it.
  {
    const { owner, result } = simulateAddTaskParamBinding(pipelineSource, "incomplete", ["image-tag"]);
    const after = owner && YAML.parse(result);
    const task = after?.spec.tasks.find((t) => t.name === "incomplete");
    const ok = owner !== undefined && task?.params?.length === 2 && task.params.some((p) => p.name === "image-tag" && p.value === "");
    console.log(`  [${ok ? "PASS" : "FAIL"}] Pipeline task entry: "image-tag" appended to its existing params: list`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }

  // Same fix, but the TaskRun has no params: list at all yet -- must create it.
  {
    const { owner, result } = simulateAddTaskParamBinding(taskRunSource, undefined, ["image-tag"]);
    const after = owner && YAML.parse(result);
    const ok = owner !== undefined && after?.spec.params?.length === 1 && after.spec.params[0].name === "image-tag";
    console.log(`  [${ok ? "PASS" : "FAIL"}] TaskRun with no params: yet: fresh params: [image-tag] created`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }

  // "Add a default" fix: edits the Task's own declaration instead, leaving the binding untouched.
  {
    const { paramItem, result } = simulateAddTaskParamDefault(taskSource, "image-tag");
    const after = paramItem && YAML.parse(result);
    const param = after?.spec.params.find((p) => p.name === "image-tag");
    const ok = paramItem !== undefined && param?.default === "" && after.spec.params.find((p) => p.name === "region").default === "us-east-1";
    console.log(`  [${ok ? "PASS" : "FAIL"}] Task's own declaration: default: "" added to "image-tag", "region"'s own default untouched`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }

  // "Add all missing parameters" fix: both required params missing at once, fixed in a single edit.
  {
    const taskSourceThree = `apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: needs-three-params
spec:
  params:
    - name: image-tag
      type: string
    - name: region
      type: string
    - name: registry
      type: string
      default: docker.io
  steps:
    - name: build
      script: echo $(params.image-tag) $(params.region) $(params.registry)
`;
    const pipelineSourceThree = `apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: p
spec:
  tasks:
    - name: incomplete
      taskRef:
        name: needs-three-params
`;
    const task = parseTektonDocument(taskSourceThree);
    const requiredNames = task.symbols.params.filter((p) => p.default === undefined).map((p) => p.name);

    const { owner, result } = simulateAddTaskParamBinding(pipelineSourceThree, "incomplete", requiredNames);
    const after = owner && YAML.parse(result);
    const taskEntry = after?.spec.tasks.find((t) => t.name === "incomplete");
    const ok =
      JSON.stringify(requiredNames) === JSON.stringify(["image-tag", "region"]) &&
      owner !== undefined &&
      taskEntry?.params?.length === 2 &&
      taskEntry.params.every((p) => p.value === "") &&
      taskEntry.params.map((p) => p.name).sort().join(",") === "image-tag,region";
    console.log(`  [${ok ? "PASS" : "FAIL"}] both missing params ("image-tag", "region") added in one edit, "registry" (has a default) untouched (${JSON.stringify(requiredNames)})`);
    if (!ok) {
      console.log(result);
      failures++;
    }
  }
}

console.log("\nrename: cross-file TriggerTemplate identity (template.ref, EventListener + standalone Trigger):");
{
  const elSource = fs.readFileSync(path.join(__dirname, "eventlistener-crossfile.yaml"), "utf8");
  const triggerSource = fs.readFileSync(path.join(__dirname, "trigger.yaml"), "utf8");
  const elParsed = parseTektonDocument(elSource);
  const triggerParsed = parseTektonDocument(triggerSource);

  const elEdits = templateRefIdentityEdits(elParsed, "build-template", "build-template-v2");
  const triggerEdits = templateRefIdentityEdits(triggerParsed, "build-template", "build-template-v2");
  const elResult = applyTextEdits(elSource, elEdits);
  const triggerResult = applyTextEdits(triggerSource, triggerEdits);

  const ok1 = parseTektonDocument(elResult)?.symbols.triggers[0]?.templateRefName === "build-template-v2";
  const ok2 = parseTektonDocument(triggerResult)?.symbols.templateRefName === "build-template-v2";
  const ok = elEdits.length === 1 && triggerEdits.length === 1 && ok1 && ok2;
  console.log(`  [${ok ? "PASS" : "FAIL"}] "build-template" -> "build-template-v2": EventListener (${!!ok1}), Trigger (${!!ok2})`);
  if (!ok) {
    console.log({ elEdits, triggerEdits, elResult, triggerResult });
    failures++;
  }
}

console.log("\nrename: cross-file TriggerBinding identity (bindings[].ref, EventListener + standalone Trigger):");
{
  const elSource = fs.readFileSync(path.join(__dirname, "eventlistener-crossfile.yaml"), "utf8");
  const triggerSource = fs.readFileSync(path.join(__dirname, "trigger.yaml"), "utf8");
  const elParsed = parseTektonDocument(elSource);
  const triggerParsed = parseTektonDocument(triggerSource);

  const elEdits = bindingRefIdentityEdits(elParsed, "github-binding", "github-binding-v2");
  const triggerEdits = bindingRefIdentityEdits(triggerParsed, "github-binding", "github-binding-v2");
  const elResult = applyTextEdits(elSource, elEdits);
  const triggerResult = applyTextEdits(triggerSource, triggerEdits);

  const ok1 = parseTektonDocument(elResult)?.symbols.triggers[0]?.bindingRefs[0]?.name === "github-binding-v2";
  const ok2 = parseTektonDocument(triggerResult)?.symbols.bindingRefs[0]?.name === "github-binding-v2";
  const ok = elEdits.length === 1 && triggerEdits.length === 1 && ok1 && ok2;
  console.log(`  [${ok ? "PASS" : "FAIL"}] "github-binding" -> "github-binding-v2": EventListener (${!!ok1}), Trigger (${!!ok2})`);
  if (!ok) {
    console.log({ elEdits, triggerEdits, elResult, triggerResult });
    failures++;
  }
}

console.log("\nrename: cross-file Trigger identity (triggerRef):");
{
  const source = fs.readFileSync(path.join(__dirname, "eventlistener.yaml"), "utf8");
  const parsed = parseTektonDocument(source);
  const edits = triggerRefIdentityEdits(parsed, "build-trigger", "build-trigger-v2");
  const result = applyTextEdits(source, edits);
  const ok = edits.length === 1 && parseTektonDocument(result)?.symbols.triggers[0]?.triggerRefName === "build-trigger-v2";
  console.log(`  [${ok ? "PASS" : "FAIL"}] eventlistener.yaml: "build-trigger" -> "build-trigger-v2" (${edits.length} edit(s))`);
  if (!ok) {
    console.log({ edits, result });
    failures++;
  }
}

console.log("\nrename target resolution: cursor on an EventListener's bindings[].ref / template.ref / triggerRef:");
{
  const elSource = fs.readFileSync(path.join(__dirname, "eventlistener-crossfile.yaml"), "utf8");
  const elParsed = parseTektonDocument(elSource);
  const bindingOffset = elSource.indexOf("github-binding") + 3;
  const templateOffset = elSource.indexOf("build-template") + 3;
  const bindingTarget = resolveRenameTarget(elParsed, bindingOffset);
  const templateTarget = resolveRenameTarget(elParsed, templateOffset);

  const delegatedSource = fs.readFileSync(path.join(__dirname, "eventlistener.yaml"), "utf8");
  const delegatedParsed = parseTektonDocument(delegatedSource);
  const triggerRefOffset = delegatedSource.indexOf("build-trigger") + 3;
  const triggerTarget = resolveRenameTarget(delegatedParsed, triggerRefOffset);

  const ok =
    bindingTarget?.kind === "binding-identity" &&
    bindingTarget.name === "github-binding" &&
    templateTarget?.kind === "template-identity" &&
    templateTarget.name === "build-template" &&
    triggerTarget?.kind === "trigger-identity" &&
    triggerTarget.name === "build-trigger";
  console.log(
    `  [${ok ? "PASS" : "FAIL"}] binding-identity(${bindingTarget?.kind}), template-identity(${templateTarget?.kind}), trigger-identity(${triggerTarget?.kind})`
  );
  if (!ok) failures++;
}

console.log("\nCompletion provider: $(...) trigger refs and identity ref-name fields:");
{
  // completions.ts imports "vscode" (for Range/Position/CompletionItem) but the logic under
  // test doesn't touch anything else from the API, so a minimal in-process shim is enough to
  // load and drive the real provider class here, same as everywhere else in this harness.
  class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  }
  class Range {
    constructor(a, b, c, d) {
      if (typeof a === "number") {
        this.start = new Position(a, b);
        this.end = new Position(c, d);
      } else {
        this.start = a;
        this.end = b;
      }
    }
  }
  class CompletionItem {
    constructor(label, kind) {
      this.label = label;
      this.kind = kind;
    }
  }
  class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  }
  class SnippetString {
    constructor() {
      this.value = "";
    }
    appendText(text) {
      this.value += text;
      return this;
    }
    appendTabstop(n) {
      this.value += `\${${n}}`;
      return this;
    }
    appendChoice(choices) {
      this.value += `\${1|${choices.join(",")}|}`;
      return this;
    }
  }
  const vscodeShim = {
    Position,
    Range,
    CompletionItem,
    MarkdownString,
    SnippetString,
    CompletionItemKind: new Proxy({}, { get: () => 0 }),
  };

  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return vscodeShim;
    return originalLoad.call(this, request, ...rest);
  };
  const { TektonRefCompletionProvider } = require("../out/tekton/completions");
  Module._load = originalLoad;

  function makeDocument(text) {
    const lines = text.split("\n");
    const lineOffsets = [0];
    for (const l of lines.slice(0, -1)) lineOffsets.push(lineOffsets[lineOffsets.length - 1] + l.length + 1);
    return {
      getText: () => text,
      lineAt: (line) => ({ text: lines[line] }),
      offsetAt: (pos) => lineOffsets[pos.line] + pos.character,
      positionAt: (offset) => {
        let line = 0;
        while (line + 1 < lineOffsets.length && lineOffsets[line + 1] <= offset) line++;
        return new Position(line, offset - lineOffsets[line]);
      },
    };
  }

  /** Completes at the end of the first line containing `needle`. */
  function completeAt(text, needle, workspaceIndex) {
    const doc = makeDocument(text);
    const lineIdx = text.split("\n").findIndex((l) => l.includes(needle));
    if (lineIdx === -1) throw new Error(`fixture line containing ${JSON.stringify(needle)} not found`);
    const line = text.split("\n")[lineIdx];
    const position = new Position(lineIdx, line.length);
    const provider = new TektonRefCompletionProvider(workspaceIndex ?? {}, SCHEMAS_DIR);
    return (provider.provideCompletionItems(doc, position) ?? []).map((i) => i.label);
  }

  /** Same as completeAt, but returns the full CompletionItem objects (label + insertText/documentation), for schema-key completion assertions that need more than just the label. */
  function completeItemsAt(text, needle, workspaceIndex) {
    const doc = makeDocument(text);
    const lineIdx = text.split("\n").findIndex((l) => l.includes(needle));
    if (lineIdx === -1) throw new Error(`fixture line containing ${JSON.stringify(needle)} not found`);
    const line = text.split("\n")[lineIdx];
    const position = new Position(lineIdx, line.length);
    const provider = new TektonRefCompletionProvider(workspaceIndex ?? {}, SCHEMAS_DIR);
    return provider.provideCompletionItems(doc, position) ?? [];
  }

  const noopIndex = {
    allTaskNames: () => [],
    allPipelineNames: () => [],
    allTriggerTemplateNames: () => [],
    allTriggerBindingNames: () => [],
    allTriggerNames: () => [],
  };

  const ttSource = fs.readFileSync(path.join(__dirname, "triggertemplate.yaml"), "utf8");
  const ttTop = completeAt(ttSource.replace("$(uid)", "$("), "generateName", noopIndex);
  const ttParamsPartial = completeAt(ttSource.replace("$(tt.params.gitrevision)", "$(tt.params."), "$(tt.params.", noopIndex);

  const okTt = ttTop.includes("tt") && ttTop.includes("uid") && ttParamsPartial.includes("gitrevision") && ttParamsPartial.includes("gitrepositoryurl");
  console.log(`  [${okTt ? "PASS" : "FAIL"}] TriggerTemplate: top-level offers tt/uid (${JSON.stringify(ttTop)}), $(tt.params. offers declared params (${JSON.stringify(ttParamsPartial)})`);
  if (!okTt) failures++;

  const tbSource = fs.readFileSync(path.join(__dirname, "triggerbinding.yaml"), "utf8");
  const tbTop = completeAt(tbSource.replace("$(body.head_commit.id)", "$("), "$(", noopIndex);
  const okTb = ["body", "header", "extensions", "context"].every((k) => tbTop.includes(k));
  console.log(`  [${okTb ? "PASS" : "FAIL"}] TriggerBinding: top-level offers body/header/extensions/context (${JSON.stringify(tbTop)})`);
  if (!okTb) failures++;

  const namedIndex = {
    ...noopIndex,
    allTriggerBindingNames: () => ["github-binding", "other-binding"],
    allTriggerTemplateNames: () => ["build-template", "other-template"],
    allTriggerNames: () => ["build-trigger", "other-trigger"],
    allTaskNames: () => ["build-image", "other-task"],
    allPipelineNames: () => ["build-and-deploy", "other-pipeline"],
  };

  const elSource = fs.readFileSync(path.join(__dirname, "eventlistener-crossfile.yaml"), "utf8");
  const bindingCompletions = completeAt(elSource.replace("github-binding", "github-b"), "github-b", namedIndex);
  const templateCompletions = completeAt(elSource.replace("build-template", "build-t"), "build-t", namedIndex);
  const okIdentityEl =
    bindingCompletions.includes("github-binding") &&
    bindingCompletions.includes("other-binding") &&
    templateCompletions.includes("build-template");
  console.log(
    `  [${okIdentityEl ? "PASS" : "FAIL"}] EventListener: bindings[].ref completion (${JSON.stringify(bindingCompletions)}), template.ref completion (${JSON.stringify(templateCompletions)})`
  );
  if (!okIdentityEl) failures++;

  const triggerRefSource = fs.readFileSync(path.join(__dirname, "eventlistener.yaml"), "utf8");
  const triggerRefCompletions = completeAt(triggerRefSource.replace("build-trigger", "build-t"), "build-t", namedIndex);
  const okTriggerRef = triggerRefCompletions.includes("build-trigger") && triggerRefCompletions.includes("other-trigger");
  console.log(`  [${okTriggerRef ? "PASS" : "FAIL"}] EventListener: triggerRef completion (${JSON.stringify(triggerRefCompletions)})`);
  if (!okTriggerRef) failures++;

  // Minimal Pipeline + PipelineRun snippets, rather than relying on fixture internals matching exactly.
  const pipelineSnippet = [
    "apiVersion: tekton.dev/v1",
    "kind: Pipeline",
    "metadata:",
    "  name: p",
    "spec:",
    "  tasks:",
    "    - name: build",
    "      taskRef:",
    "        name: build-i",
  ].join("\n");
  const taskRefCompletions = completeAt(pipelineSnippet, "build-i", namedIndex);

  const pipelineRunSnippet = [
    "apiVersion: tekton.dev/v1",
    "kind: PipelineRun",
    "metadata:",
    "  name: pr",
    "spec:",
    "  pipelineRef:",
    "    name: build-a",
  ].join("\n");
  const pipelineRefCompletions = completeAt(pipelineRunSnippet, "build-a", namedIndex);

  const okIdentityTask =
    taskRefCompletions.includes("build-image") &&
    taskRefCompletions.includes("other-task") &&
    pipelineRefCompletions.includes("build-and-deploy");
  console.log(
    `  [${okIdentityTask ? "PASS" : "FAIL"}] Pipeline: taskRef.name completion (${JSON.stringify(taskRefCompletions)}), PipelineRun: pipelineRef.name completion (${JSON.stringify(pipelineRefCompletions)})`
  );
  if (!okIdentityTask) failures++;

  // Schema-key completion: falls through here whenever the cursor is inside neither a $(...) ref
  // nor an identity ref-name field -- e.g. a fresh line within a step's own map.
  const stepSnippet = [
    "apiVersion: tekton.dev/v1",
    "kind: Task",
    "metadata:",
    "  name: t",
    "spec:",
    "  steps:",
    "    - name: build",
    "      ",
  ].join("\n");
  const stepKeyLabels = completeAt(stepSnippet, "      ", noopIndex);
  const okStepKey = stepKeyLabels.includes("script") && stepKeyLabels.includes("image") && !stepKeyLabels.includes("name");
  console.log(`  [${okStepKey ? "PASS" : "FAIL"}] Task: step-level key completion offers "script"/"image", already-present "name" excluded (${stepKeyLabels.length} total)`);
  if (!okStepKey) {
    console.log(stepKeyLabels);
    failures++;
  }

  const scriptItem = completeItemsAt(stepSnippet, "      ", noopIndex).find((i) => i.label === "script");
  const okScriptSnippet = scriptItem?.insertText?.value === "script: ${0}";
  console.log(`  [${okScriptSnippet ? "PASS" : "FAIL"}] "script" (a plain string field) inserts as "script: " with a trailing tabstop (${JSON.stringify(scriptItem?.insertText?.value)})`);
  if (!okScriptSnippet) failures++;

  const envItem = completeItemsAt(stepSnippet, "      ", noopIndex).find((i) => i.label === "env");
  const okEnvSnippet = envItem?.insertText?.value === "env: \n  - ${0}";
  console.log(`  [${okEnvSnippet ? "PASS" : "FAIL"}] "env" (an array field) inserts a fresh list item line (${JSON.stringify(envItem?.insertText?.value)})`);
  if (!okEnvSnippet) failures++;

  const computeResourcesItem = completeItemsAt(stepSnippet, "      ", noopIndex).find((i) => i.label === "computeResources");
  const okObjectSnippet = computeResourcesItem?.insertText?.value === "computeResources: \n  ${0}";
  console.log(`  [${okObjectSnippet ? "PASS" : "FAIL"}] "computeResources" (an object field) inserts a fresh indented line (${JSON.stringify(computeResourcesItem?.insertText?.value)})`);
  if (!okObjectSnippet) failures++;

  // A blank line right after a *parent* key ("spec:"), not just a trailing one at the end of a
  // block -- findEnclosingMap alone resolves this to the wrong (grandparent) map, since a blank
  // line has no committed structure of its own yet for the AST to place correctly.
  const specCompletionSnippet = [
    "apiVersion: tekton.dev/v1",
    "kind: Pipeline",
    "metadata:",
    "  name: p",
    "spec:",
    "  ",
    "  workspaces:",
    "    - name: mdk-workspace",
    "  tasks:",
    "    - name: build",
  ].join("\n");
  const specBlankLine = specCompletionSnippet.split("\n").findIndex((l) => l === "  ");
  const specBlankDoc = makeDocument(specCompletionSnippet);
  const specBlankProvider = new TektonRefCompletionProvider(noopIndex, SCHEMAS_DIR);
  const specBlankLabels = (
    specBlankProvider.provideCompletionItems(specBlankDoc, new Position(specBlankLine, 2)) ?? []
  ).map((i) => i.label);
  const okSpecBlank =
    specBlankLabels.includes("params") && specBlankLabels.includes("results") && !specBlankLabels.includes("status");
  console.log(`  [${okSpecBlank ? "PASS" : "FAIL"}] Pipeline: blank line right after "spec:" completes at spec level, not root (${JSON.stringify(specBlankLabels)})`);
  if (!okSpecBlank) failures++;

  // Same spot, but with "p" already typed: existing sibling keys ("workspaces") must still be
  // excluded (typing corrupts the AST here -- "p" with no colon, immediately above "workspaces:",
  // is valid YAML plain-scalar line-folding into one "p workspaces" key -- this has to work from
  // indentation, not the parsed structure), and the completion must replace "p", not insert
  // alongside it.
  const specCompletionWithP = specCompletionSnippet.replace("\n  \n  workspaces:", "\n  p\n  workspaces:");
  const pItems = completeItemsAt(specCompletionWithP, "  p", noopIndex);
  const pLabels = pItems.map((i) => i.label);
  const okPExcludesExisting = pLabels.includes("params") && !pLabels.includes("workspaces") && !pLabels.includes("tasks");
  console.log(`  [${okPExcludesExisting ? "PASS" : "FAIL"}] typed "p": already-present "workspaces"/"tasks" excluded despite the AST-corrupting fold (${JSON.stringify(pLabels)})`);
  if (!okPExcludesExisting) failures++;

  const paramsItem = pItems.find((i) => i.label === "params");
  const withPDoc = makeDocument(specCompletionWithP);
  const pLineStart = specCompletionWithP.indexOf("  p\n");
  const expectedRange = new Range(withPDoc.positionAt(pLineStart + 2), withPDoc.positionAt(pLineStart + 3)); // just the "p"
  const okReplaceRange =
    paramsItem?.range &&
    paramsItem.range.start.line === expectedRange.start.line &&
    paramsItem.range.start.character === expectedRange.start.character &&
    paramsItem.range.end.line === expectedRange.end.line &&
    paramsItem.range.end.character === expectedRange.end.character;
  console.log(`  [${okReplaceRange ? "PASS" : "FAIL"}] typed "p": completion replaces just the typed prefix, not inserted alongside it`);
  if (!okReplaceRange) {
    console.log({ actual: paramsItem?.range, expected: expectedRange });
    failures++;
  }
}

console.log("\nEmbedded script block detection (scriptEmbed.ts):");
{
  const source = fs.readFileSync(path.join(__dirname, "task-scripts.yaml"), "utf8");
  const parsed = parseTektonDocument(source);
  const blocks = findEmbeddedScriptBlocks(parsed);

  const byLang = blocks.map((b) => b.languageId);
  const okCount = blocks.length === 5;
  console.log(
    `  [${okCount ? "PASS" : "FAIL"}] 5 of 7 step/sidecar scripts recognized (no-shebang and unknown-shebang skipped): got ${blocks.length} -> ${JSON.stringify(byLang)}`
  );
  if (!okCount) failures++;

  const bash = blocks.find((b) => b.interpreter === "bash" && b.containerName === "bash-step");
  const python = blocks.find((b) => b.languageId === "python");
  const node = blocks.find((b) => b.languageId === "javascript");
  const shellBlocks = blocks.filter((b) => b.languageId === "shellscript");

  const okLang = !!bash && !!python && !!node && shellBlocks.length === 3;
  console.log(
    `  [${okLang ? "PASS" : "FAIL"}] language ids: bash-step/sidecar-like-indent-step/bash-sidecar=shellscript (${shellBlocks.length}), python-step=python, node-step=javascript`
  );
  if (!okLang) failures++;

  const okContainerNames = bash?.containerName === "bash-step" && python?.containerName === "python-step";
  console.log(`  [${okContainerNames ? "PASS" : "FAIL"}] containerName carries the step's own name (bash-step="${bash?.containerName}", python-step="${python?.containerName}")`);
  if (!okContainerNames) failures++;

  const okDedent = bash?.rawContent.startsWith("#!/usr/bin/env bash\nset -e\necho $(params.image)\nif true; then\n  echo nested\nfi");
  console.log(`  [${okDedent ? "PASS" : "FAIL"}] bash-step rawContent dedented, nested "if" body keeps its relative 2-space indent`);
  if (!okDedent) {
    console.log({ rawContent: bash?.rawContent });
    failures++;
  }

  const okBashUnmasked = !!bash && bash.content.includes("$(params.image)") && bash.rawContent.includes("$(params.image)");
  const okPythonMasked =
    !!python &&
    !python.content.includes("$(params.image)") &&
    python.content.includes("_".repeat("$(params.image)".length)) &&
    python.rawContent.includes("$(params.image)"); // rawContent must stay unmasked -- it's what gets written back on save
  console.log(`  [${okBashUnmasked && okPythonMasked ? "PASS" : "FAIL"}] shellscript leaves $(...) unmasked in both content/rawContent, python masks only content (rawContent stays intact for writeback)`);
  if (!(okBashUnmasked && okPythonMasked)) failures++;

  const vOffset = bash.rawContent.indexOf("params.image");
  const hOffset = bash.toHostOffset(vOffset);
  const okVirtualToHost = source.slice(hOffset, hOffset + "params.image".length) === "params.image";
  console.log(`  [${okVirtualToHost ? "PASS" : "FAIL"}] bash-step: virtual->host offset round-trip for "params.image"`);
  if (!okVirtualToHost) failures++;

  const deepIndentBlock = blocks.find((b) => b.languageId === "shellscript" && b.rawContent.includes("deeper indent"));
  const deepHOffset = source.indexOf("deeper indent");
  const deepVOffset = deepIndentBlock?.toVirtualOffset(deepHOffset);
  const okHostToVirtual =
    deepVOffset !== undefined && deepIndentBlock.rawContent.slice(deepVOffset, deepVOffset + "deeper indent".length) === "deeper indent";
  console.log(`  [${okHostToVirtual ? "PASS" : "FAIL"}] deep-indent step: host->virtual offset round-trip for "deeper indent", indent=${deepIndentBlock?.indent}`);
  if (!okHostToVirtual) failures++;

  const okUnknown = detectShebangLanguage("#!/usr/bin/env made-up-lang\necho hi") === undefined;
  console.log(`  [${okUnknown ? "PASS" : "FAIL"}] unrecognized shebang interpreter yields no language`);
  if (!okUnknown) failures++;

  const okNoShebang = detectShebangLanguage("echo no shebang here") === undefined;
  console.log(`  [${okNoShebang ? "PASS" : "FAIL"}] missing shebang yields no language`);
  if (!okNoShebang) failures++;

  // Round-trip: dedent (via rawContent) then reindent should reproduce the original indented block exactly.
  const reindented = reindentScriptContent(bash.rawContent, bash.indent);
  const originalIndentedContent = source.slice(bash.hostRange[0], bash.hostRange[1]);
  const okRoundTrip = reindented === originalIndentedContent;
  console.log(`  [${okRoundTrip ? "PASS" : "FAIL"}] reindentScriptContent(rawContent, indent) reproduces the original indented block exactly`);
  if (!okRoundTrip) {
    console.log({ reindented, originalIndentedContent });
    failures++;
  }

  const deepReindented = reindentScriptContent(deepIndentBlock.rawContent, deepIndentBlock.indent);
  const deepOriginal = source.slice(deepIndentBlock.hostRange[0], deepIndentBlock.hostRange[1]);
  const okDeepRoundTrip = deepReindented === deepOriginal;
  console.log(`  [${okDeepRoundTrip ? "PASS" : "FAIL"}] reindentScriptContent round-trips the deeper-indented block too`);
  if (!okDeepRoundTrip) failures++;

  const okReindentEdited = reindentScriptContent("echo hi\n\necho bye", 4) === "    echo hi\n\n    echo bye\n";
  console.log(`  [${okReindentEdited ? "PASS" : "FAIL"}] reindentScriptContent leaves blank lines blank (no trailing whitespace) and always ends with one newline`);
  if (!okReindentEdited) failures++;
}

console.log("\nEmbedded script block with mid-block Helm templates (helmMask.ts reindent + scriptEmbed.ts templateGaps):");
{
  const source = fs.readFileSync(path.join(__dirname, "helm-script-embedded-template.yaml"), "utf8");
  const parsed = parseTektonDocument(source);
  const okHelmTemplated = parsed.isHelmTemplated;
  const blocks = findEmbeddedScriptBlocks(parsed);
  const okOneBlock = blocks.length === 1;
  console.log(`  [${okHelmTemplated && okOneBlock ? "PASS" : "FAIL"}] recognized as Helm-templated, 1 script block found (not cut off at the first template line)`);
  if (!okHelmTemplated || !okOneBlock) failures++;

  const block = blocks[0];
  const okFullContent =
    block &&
    block.rawContent.includes('thisis = "someline"') &&
    block.rawContent.includes('coolio = "Qqweeewq"') &&
    block.rawContent.includes("def somefunction():") &&
    block.rawContent.includes('print("debug")') &&
    block.rawContent.includes("# This is a fine comment");
  console.log(`  [${okFullContent ? "PASS" : "FAIL"}] script content spans past every template line, all the way to the end of the block`);
  if (!okFullContent) {
    console.log({ rawContent: block && block.rawContent });
    failures++;
  }

  const okGapCount = block && block.templateGaps.length === 3;
  const okGapText =
    block &&
    block.templateGaps.map((g) => g.original).join("|") ===
      ["{{ some kind of helm template }}", "{{- if .Values.debug }}", "{{- end }}"].join("|");
  console.log(
    `  [${okGapCount && okGapText ? "PASS" : "FAIL"}] 3 template gaps found, in document order, original text captured verbatim (${JSON.stringify(block && block.templateGaps.map((g) => g.original))})`
  );
  if (!okGapCount || !okGapText) failures++;

  // Each gap's marker shows the *real* template text (for context), not a generic placeholder --
  // the id that write-back actually keys off is invisible, so it doesn't show up in a plain
  // substring check for the visible content.
  const okNoRawFiller = block && !block.content.includes("xxxx") && !block.rawContent.includes("xxxx");
  const okVisibleText =
    block &&
    block.content.includes("{{ some kind of helm template }}") &&
    block.content.includes("{{- if .Values.debug }}") &&
    block.content.includes("{{- end }}");
  // The invisible id sits between "# " and the visible "{{" text, so this can't be a simple
  // anchored regex -- just check the line starts with a Python comment and contains the template.
  const okMarkerIsPythonComment =
    block &&
    block.content.split("\n").filter((l) => l.startsWith("#") && l.includes("{{")).length === 3;
  console.log(
    `  [${okNoRawFiller && okVisibleText && okMarkerIsPythonComment ? "PASS" : "FAIL"}] each gap shown as a "#"-commented marker with the real template text visible (Python's line-comment syntax), not raw "xxxx" filler`
  );
  if (!okNoRawFiller || !okVisibleText || !okMarkerIsPythonComment) {
    console.log({ content: block && block.content });
    failures++;
  }

  // Round-trip: saving the scratch content completely unedited must reconstruct the exact
  // original host block, byte-for-byte -- each template's own original indentation (column 0 in
  // this fixture, deliberately different from the script's) is untouched, not normalized to the
  // block's indent. Restoring a gap is supposed to be a no-op on that text.
  const restoredUnedited = restoreTemplateGaps(block.content, block.indent, block.templateGaps);
  const originalHostBlock = source.slice(block.hostRange[0], block.hostRange[1]);
  const okRoundTrip = restoredUnedited === originalHostBlock;
  console.log(`  [${okRoundTrip ? "PASS" : "FAIL"}] unedited scratch content round-trips back to the exact original host block, template indentation untouched`);
  if (!okRoundTrip) {
    console.log({ restoredUnedited, originalHostBlock });
    failures++;
  }

  // Editing real script content, AND the visible template text shown on a marker line, still
  // restores every gap to its true original -- only the invisible id has to survive, so a user
  // annotating or lightly editing what they see doesn't corrupt what actually gets written back.
  const edited = block.content
    .replace('coolio = "Qqweeewq"', 'coolio = "EDITED"')
    .replace("{{ some kind of helm template }}", "{{ some kind of helm template }} (looks like a conditional?)");
  const restoredEdited = restoreTemplateGaps(edited, block.indent, block.templateGaps);
  const okEditedRestore =
    restoredEdited.includes('coolio = "EDITED"') &&
    restoredEdited.includes("{{ some kind of helm template }}") &&
    !restoredEdited.includes("(looks like a conditional?)") &&
    restoredEdited.includes("{{- if .Values.debug }}") &&
    restoredEdited.includes("{{- end }}");
  console.log(`  [${okEditedRestore ? "PASS" : "FAIL"}] editing real content, or even a marker's own visible text, still restores every gap's true original`);
  if (!okEditedRestore) {
    console.log({ restoredEdited });
    failures++;
  }

  // Deleting one marker line entirely (as if the user removed that section) drops only that one
  // gap's template -- the other two still restore normally.
  const lines = block.content.split("\n");
  const firstMarkerIdx = lines.findIndex((l) => l.startsWith("#") && l.includes("{{"));
  const withOneMarkerRemoved = [...lines.slice(0, firstMarkerIdx), ...lines.slice(firstMarkerIdx + 1)].join("\n");
  const restoredPartial = restoreTemplateGaps(withOneMarkerRemoved, block.indent, block.templateGaps);
  const okPartialRestore =
    !restoredPartial.includes("{{ some kind of helm template }}") &&
    restoredPartial.includes("{{- if .Values.debug }}") &&
    restoredPartial.includes("{{- end }}");
  console.log(`  [${okPartialRestore ? "PASS" : "FAIL"}] deleting one marker's whole line drops only that gap's template, the rest still restore`);
  if (!okPartialRestore) {
    console.log({ restoredPartial });
    failures++;
  }

  // refreshTemplateGapMarkers is what the "Edit Task Script" save handler applies to the scratch
  // file itself right after write-back, so an edit to a marker's visible text (which never
  // affects the host document) doesn't sit around indefinitely looking like it did something.
  const editedMarkerContent = block.content.replace(
    "{{ some kind of helm template }}",
    "{{ some kind of helm template }} <- I added a note here"
  );
  const refreshed = refreshTemplateGapMarkers(editedMarkerContent, block.languageId, block.templateGaps);
  const okRefreshedClean = refreshed.includes("{{ some kind of helm template }}") && !refreshed.includes("I added a note here");
  const okRefreshedStillRestores = restoreTemplateGaps(refreshed, block.indent, block.templateGaps) === originalHostBlock;
  const okRefreshedOtherLinesUntouched = refreshed.split("\n").length === editedMarkerContent.split("\n").length;
  console.log(
    `  [${okRefreshedClean && okRefreshedStillRestores && okRefreshedOtherLinesUntouched ? "PASS" : "FAIL"}] refreshTemplateGapMarkers snaps an edited marker's visible text back to the truth, without touching line count or other lines`
  );
  if (!okRefreshedClean || !okRefreshedStillRestores || !okRefreshedOtherLinesUntouched) {
    console.log({ refreshed });
    failures++;
  }
}

console.log("\nPipeline task entry's inline taskSpec: steps/sidecars recognized (not just standalone Task/TaskRun):");
{
  const source = fs.readFileSync(path.join(__dirname, "pipeline-inline-taskspec.yaml"), "utf8");
  const parsed = parseTektonDocument(source);

  const entries = stepAndSidecarEntryMaps(parsed);
  const okEntries = entries.length === 2 && entries.map((e) => e.get("name")).join(",") === "build-step,report";
  console.log(`  [${okEntries ? "PASS" : "FAIL"}] stepAndSidecarEntryMaps finds both inline-taskSpec steps: ${JSON.stringify(entries.map((e) => e.get("name")))}`);
  if (!okEntries) failures++;

  const scriptOffset = source.indexOf("script: echo");
  const okFind = !!findEnclosingStepEntry(parsed, scriptOffset);
  console.log(`  [${okFind ? "PASS" : "FAIL"}] findEnclosingStepEntry resolves a cursor inside an inline-taskSpec step`);
  if (!okFind) failures++;

  const blocks = findEmbeddedScriptBlocks(parsed);
  const okBlocks = blocks.length === 1 && blocks[0].languageId === "python" && blocks[0].containerName === "build-step";
  console.log(`  [${okBlocks ? "PASS" : "FAIL"}] findEmbeddedScriptBlocks finds the python shebang inside an inline-taskSpec step: ${JSON.stringify(blocks.map((b) => ({ lang: b.languageId, name: b.containerName })))}`);
  if (!okBlocks) failures++;
}

console.log("\nStandalone StepAction: its own spec *is* the one step (no steps:/sidecars: list of its own):");
{
  // A StepAction's script/image/env/... live directly on spec, unlike Task/ClusterTask/
  // TaskRun-inline-taskSpec, which nest those under a steps:/sidecars: list entry.
  // all-kinds-multidoc.yaml's mdk-stepaction is the very first document in the file.
  const source = fs.readFileSync(path.join(__dirname, "all-kinds-multidoc.yaml"), "utf8");
  const stepAction = parseTektonFile(source).find((d) => d.symbols.metadataName === "mdk-stepaction");

  const entries = stepAndSidecarEntryMaps(stepAction);
  const okEntry = entries.length === 1;
  console.log(`  [${okEntry ? "PASS" : "FAIL"}] stepAndSidecarEntryMaps treats the StepAction's own spec as its one step (${entries.length} entr(y/ies))`);
  if (!okEntry) failures++;

  const scriptOffset = source.indexOf('echo "linting..."');
  const okFind = !!findEnclosingStepEntry(stepAction, scriptOffset);
  console.log(`  [${okFind ? "PASS" : "FAIL"}] findEnclosingStepEntry resolves a cursor inside the StepAction's own script`);
  if (!okFind) failures++;

  const blocks = findEmbeddedScriptBlocks(stepAction);
  // No `name:` field of its own to label it with -- falls back to the StepAction's own metadata.name.
  const okBlocks = blocks.length === 1 && blocks[0].languageId === "shellscript" && blocks[0].containerName === "mdk-stepaction";
  console.log(`  [${okBlocks ? "PASS" : "FAIL"}] findEmbeddedScriptBlocks finds the shebang, containerName falls back to metadata.name: ${JSON.stringify(blocks.map((b) => ({ lang: b.languageId, name: b.containerName })))}`);
  if (!okBlocks) failures++;
}

console.log("\nHighlighting: identity system + plain-scalar bindings decorated same as $(...) refs:");
{
  // decorations.ts imports "vscode" for Range/Position/ThemeColor and to create decoration types
  // at module load -- same minimal in-process shim approach as the completion-provider tests above.
  class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  }
  class Range {
    constructor(a, b, c, d) {
      if (typeof a === "number") {
        this.start = new Position(a, b);
        this.end = new Position(c, d);
      } else {
        this.start = a;
        this.end = b;
      }
    }
  }
  class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  }
  const vscodeShim = {
    Position,
    Range,
    ThemeColor,
    window: { createTextEditorDecorationType: (opts) => ({ opts, dispose() {} }) },
  };

  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return vscodeShim;
    return originalLoad.call(this, request, ...rest);
  };
  const { updateDecorations } = require("../out/tekton/decorations");
  Module._load = originalLoad;

  function makeDocument(text) {
    const lines = text.split("\n");
    const lineOffsets = [0];
    for (const l of lines.slice(0, -1)) lineOffsets.push(lineOffsets[lineOffsets.length - 1] + l.length + 1);
    return {
      getText: () => text,
      offsetAt: (pos) => lineOffsets[pos.line] + pos.character,
      positionAt: (offset) => {
        let line = 0;
        while (line + 1 < lineOffsets.length && lineOffsets[line + 1] <= offset) line++;
        return new Position(line, offset - lineOffsets[line]);
      },
    };
  }

  /** Runs updateDecorations against `file` and returns the decorated substrings (not ranges) -- decl (1st setDecorations call) and ref (2nd), matching updateDecorations' fixed call order. */
  function decorate(file) {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    const document = makeDocument(text);
    const calls = [];
    const editor = { document, setDecorations: (_type, ranges) => calls.push(ranges) };
    updateDecorations(editor, parseTektonFile(text));
    const textOf = (range) => text.slice(document.offsetAt(range.start), document.offsetAt(range.end));
    return { decl: (calls[0] ?? []).map(textOf), ref: (calls[1] ?? []).map(textOf) };
  }

  const pipeline = decorate("pipeline-workspace.yaml");
  const okWorkspace =
    pipeline.decl.includes("shared-workspace") && // spec.workspaces[] declaration
    pipeline.decl.includes("build") && // pipeline task alias declaration
    pipeline.ref.includes("build-image") && // taskRef.name
    pipeline.ref.includes("shared-workspace"); // task's own workspace: binding
  console.log(`  [${okWorkspace ? "PASS" : "FAIL"}] pipeline-workspace.yaml: taskRef.name and workspace: binding decorated as references`);
  if (!okWorkspace) {
    console.log(pipeline);
    failures++;
  }

  const runAfter = decorate("pipeline-missing-runafter.yaml");
  const okRunAfter = runAfter.ref.filter((t) => t === "build").length >= 1; // audit's runAfter: [build] entry
  console.log(`  [${okRunAfter ? "PASS" : "FAIL"}] pipeline-missing-runafter.yaml: runAfter: [build] entry decorated as a reference`);
  if (!okRunAfter) {
    console.log(runAfter);
    failures++;
  }

  const stepRef = decorate("task-uses-stepaction.yaml");
  const okStepRef = stepRef.ref.includes("shared-lint");
  console.log(`  [${okStepRef ? "PASS" : "FAIL"}] task-uses-stepaction.yaml: step's ref.name decorated as a reference`);
  if (!okStepRef) {
    console.log(stepRef);
    failures++;
  }

  const stepDecl = decorate("stepaction-lint.yaml");
  const okStepDecl = stepDecl.decl.includes("shared-lint");
  console.log(`  [${okStepDecl ? "PASS" : "FAIL"}] stepaction-lint.yaml: StepAction's own metadata.name decorated as a declaration`);
  if (!okStepDecl) {
    console.log(stepDecl);
    failures++;
  }

  const taskRun = decorate("taskrun-ref.yaml");
  const okTaskRunBinding = taskRun.ref.includes("image") && !taskRun.decl.includes("image");
  console.log(`  [${okTaskRunBinding ? "PASS" : "FAIL"}] taskrun-ref.yaml: own params: binding (using taskRef) decorated as a reference, not a declaration`);
  if (!okTaskRunBinding) {
    console.log(taskRun);
    failures++;
  }

  const eventListener = decorate("eventlistener-crossfile.yaml");
  const okTrigger =
    eventListener.ref.includes("github-binding") && eventListener.ref.includes("build-template") && eventListener.decl.includes("github-push");
  console.log(`  [${okTrigger ? "PASS" : "FAIL"}] eventlistener-crossfile.yaml: bindings[].ref/template.ref decorated as references, trigger entry name as a declaration`);
  if (!okTrigger) {
    console.log(eventListener);
    failures++;
  }
}

console.log("\nSchema validation: structural checks against schemas/ (unknown/missing keys, wrong types/enums):");
{
  // Every real fixture in this directory should validate clean -- a failure here means either a
  // real bug in the extracted schemas, or a fixture that's (legitimately or not) using something
  // schemas/ doesn't know about yet.
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const unexpected = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    let docs;
    try {
      docs = parseTektonFile(text);
    } catch {
      continue;
    }
    for (const parsed of docs) {
      for (const issue of validateAgainstSchema(SCHEMAS_DIR, parsed)) {
        unexpected.push({ file, kind: parsed.symbols.kind, name: parsed.symbols.metadataName, ...issue });
      }
    }
  }
  const okFixtures = unexpected.length === 0;
  console.log(`  [${okFixtures ? "PASS" : "FAIL"}] every real fixture validates clean (${unexpected.length} unexpected issue(s))`);
  if (!okFixtures) {
    console.log(unexpected);
    failures++;
  }

  // Unknown key: additionalProperties isn't set by the Kubernetes-generated schemas this extracts
  // from (see jsonSchemas.ts's tightenAdditionalProperties) -- this is the whole point of adding it.
  const typoTask = `apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: bad-task
spec:
  steps:
    - name: build
      scirpt: echo hi
`;
  const typoIssues = validateAgainstSchema(SCHEMAS_DIR, parseTektonDocument(typoTask));
  const okTypo = typoIssues.length === 1 && typoIssues[0].message.includes('"scirpt"') && typoTask.slice(...typoIssues[0].range) === "scirpt";
  console.log(`  [${okTypo ? "PASS" : "FAIL"}] unknown key "scirpt" flagged, anchored at the key itself (${JSON.stringify(typoIssues)})`);
  if (!okTypo) failures++;

  // Missing required key: anchored at the enclosing object, since there's no node for a key that
  // isn't there.
  const missingReqTask = `apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: bad-task
spec:
  params:
    - type: string
  steps:
    - name: build
      script: echo hi
`;
  const missingIssues = validateAgainstSchema(SCHEMAS_DIR, parseTektonDocument(missingReqTask));
  const okMissing = missingIssues.length === 1 && missingIssues[0].message.includes('"name"');
  console.log(`  [${okMissing ? "PASS" : "FAIL"}] missing required key "name" flagged (${JSON.stringify(missingIssues)})`);
  if (!okMissing) failures++;

  // Bad enum value.
  const badEnumTrigger = `apiVersion: triggers.tekton.dev/v1beta1
kind: Trigger
metadata:
  name: t
spec:
  bindings:
    - ref: b
      kind: NotAKind
  template:
    ref: tmpl
`;
  const enumIssues = validateAgainstSchema(SCHEMAS_DIR, parseTektonDocument(badEnumTrigger));
  const okEnum = enumIssues.length === 1 && badEnumTrigger.slice(...enumIssues[0].range) === "NotAKind";
  console.log(`  [${okEnum ? "PASS" : "FAIL"}] bad enum value flagged, anchored at the offending value (${JSON.stringify(enumIssues)})`);
  if (!okEnum) failures++;

  // Helm-masked values (a standalone directive collapsing to null, or an inline one masking to a
  // same-length run of x's) must not produce false positives -- this extension can't know what a
  // template will actually render to, so it shouldn't guess.
  const helmTask = `apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: {{ include "mychart.fullname" . }}-build
  labels:
    {{- include "mychart.labels" . | nindent 4 }}
spec:
  steps:
    - name: build
      script: echo hi
`;
  const helmIssues = validateAgainstSchema(SCHEMAS_DIR, parseTektonDocument(helmTask));
  const okHelm = helmIssues.length === 0;
  console.log(`  [${okHelm ? "PASS" : "FAIL"}] Helm-masked values (collapsed-to-null and inline x-run) don't produce false positives (${JSON.stringify(helmIssues)})`);
  if (!okHelm) failures++;

  // No schema known for this (kind, apiVersion) pair (ClusterTask has none at all) -- empty, not
  // an error.
  const clusterTask = `apiVersion: tekton.dev/v1
kind: ClusterTask
metadata:
  name: whatever-goes
spec:
  whateverKeyAtAll: true
`;
  const noSchemaIssues = validateAgainstSchema(SCHEMAS_DIR, parseTektonDocument(clusterTask));
  const okNoSchema = noSchemaIssues.length === 0;
  console.log(`  [${okNoSchema ? "PASS" : "FAIL"}] no schema for this kind -- silently skipped, not guessed at (${JSON.stringify(noSchemaIssues)})`);
  if (!okNoSchema) failures++;
}

console.log("\nCEL expression tokenizer (celExpr.ts): balanced input, no false positives:");
{
  const cases = [
    "body.matches('push')",
    "header.match('X-GitHub-Event', 'push')",
    "1 + 2.5e-3 * body.count",
    "truncate(body.head_commit.id, 7)",
    "body.labels.exists(x, x.name == 'test-b')",
    "'has escaped \\' quote'",
    "!body.draft",
    "-body.count == 0",
    "body.repository.owner in ['tektoncd', 'other-org']",
    "0x1A + 2",
    "has(body.head_commit) ? body.head_commit.id : 'none'",
    "{a: 1, b: 2}",
    "body.draft == true",
    "body.count == null",
    "1 >= 2 ? 'a' : 'b'", // same-kind literal branches: not a mismatch
    "1 >= 2 ? true : body.draft", // one branch unknown-typed: can't tell, must not guess
  ];
  let ok = true;
  for (const expr of cases) {
    const issues = checkCelExpression(expr);
    if (issues.length !== 0) {
      ok = false;
      console.log(`  unexpected issues for ${JSON.stringify(expr)}: ${JSON.stringify(issues)}`);
    }
  }
  console.log(`  [${ok ? "PASS" : "FAIL"}] every valid expression produces zero issues`);
  if (!ok) failures++;
}

console.log("\nCEL expression tokenizer: catches unbalanced delimiters, unterminated strings, empty input:");
{
  const cases = [
    ["body.matches('push'", 'Expected ")"'],
    ["'unterminated", "Unterminated string literal"],
    ["body.count)", 'Unexpected token ")"'],
    ["   ", "Empty CEL expression"],
    // trailing/leading dangling operator -- the case a live user ran into (a comparison typed
    // halfway through)
    ["'$(body.somevalue)' ==", "expression ended"],
    ["body.count &&", "expression ended"],
    ["== body.count", 'Unexpected token "=="'],
    // two operands with nothing joining them -- the old character-level heuristic deliberately
    // never checked this (false-positive risk against the "in" operator), a real parser rejects
    // it for free
    ["foo bar", 'Unexpected token "bar"'],
    ["1 2", 'Unexpected token "2"'],
    // "true"/"false"/"null" are literal tokens, not identifiers -- a member name has to be a
    // real one, so this is rejected the same way "2.5.foo" would be, no type-checking involved
    ["1 >= 2 . true", 'Expected a field/method name after "."'],
    // ternary branches with directly-visible, differing literal types -- caught without any
    // general type inference, since both sides reduce to exactly one literal token
    ["1 >= 2 ? true : 234", 'different types ("bool" vs "number")'],
    ["1 >= 2 ? 'a' : 234", 'different types ("string" vs "number")'],
  ];
  let ok = true;
  for (const [expr, expectedSubstring] of cases) {
    const issues = checkCelExpression(expr);
    const found = issues.some((i) => i.message.includes(expectedSubstring));
    if (!found) {
      ok = false;
      console.log(`  ${JSON.stringify(expr)}: expected an issue containing ${JSON.stringify(expectedSubstring)}, got ${JSON.stringify(issues)}`);
    }
  }
  console.log(`  [${ok ? "PASS" : "FAIL"}] every broken expression flagged`);
  if (!ok) failures++;
}

console.log("\nCEL expression extraction + source mapping (model.ts findCelExpressions / celExpr.ts celIssuesInSource):");
{
  const validParsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, "trigger.yaml"), "utf8"));
  const validLocs = findCelExpressions(validParsed);
  const validIssues = validLocs.flatMap((loc) => celIssuesInSource(validParsed.text, loc.range, loc.value, loc.style));
  const okValid = validLocs.length === 1 && validLocs[0].value === "header.match('X-GitHub-Event', 'push')" && validIssues.length === 0;
  console.log(`  [${okValid ? "PASS" : "FAIL"}] trigger.yaml: 1 filter expression found, no issues (${JSON.stringify(validLocs)})`);
  if (!okValid) failures++;

  // filter is valid CEL; the overlay expression has a real bug -- "true" is a literal token, not
  // an identifier, so it can't be a member name (the exact case a live user ran into). Inline
  // rather than reading test-fixtures/trigger-cel-invalid.yaml, since that file doubles as a
  // scratch pad for manual testing and its content shifts underneath automated assertions.
  const brokenYaml = `apiVersion: triggers.tekton.dev/v1beta1
kind: Trigger
metadata:
  name: broken-cel-trigger
spec:
  interceptors:
    - ref:
        name: cel
      params:
        - name: filter
          value: "body.matches('push')"
        - name: overlays
          value:
            - key: broken_sha
              expression: "1 >= 2 . true"
  bindings:
    - ref: github-binding
  template:
    ref: build-template
`;
  const brokenParsed = parseTektonDocument(brokenYaml);
  const brokenLocs = findCelExpressions(brokenParsed);
  const brokenIssues = brokenLocs.flatMap((loc) => celIssuesInSource(brokenParsed.text, loc.range, loc.value, loc.style));
  const okBroken =
    brokenLocs.length === 2 &&
    brokenIssues.length === 1 &&
    brokenIssues[0].message.includes('field/method name after "."');
  // The reported range must land within the overlay expression's quoted value in the source, not
  // fall back to the whole-scalar range -- this fixture has no escapes, so precise mapping
  // should always succeed.
  const overlayLoc = brokenLocs[1];
  const precise =
    overlayLoc && brokenIssues[0] && brokenIssues[0].range[0] >= overlayLoc.range[0] && brokenIssues[0].range[1] <= overlayLoc.range[1];
  console.log(`  [${okBroken && precise ? "PASS" : "FAIL"}] broken cel interceptor: 2 expressions, 1 issue (bad member name), precisely positioned (${JSON.stringify(brokenIssues)})`);
  if (!okBroken || !precise) failures++;
}

console.log("\nCEL highlighting classification (celExpr.ts tokenizeCelForHighlighting):");
{
  const tokenTypesFor = (expr) => tokenizeCelForHighlighting(expr).map((t) => t.type);
  const cases = [
    ["body.matches('push')", ["variable", "function", "string"]], // body=variable, matches=function (before "("), 'push'=string; "." isn't tokenized
    ["1 + 2.5", ["number", "operator", "number"]],
    ["body.draft == true", ["variable", "property", "operator", "keyword"]],
    ["body.repository.owner in ['tektoncd']", ["variable", "property", "property", "keyword", "string"]],
    ["!body.draft", ["operator", "variable", "property"]],
  ];
  let ok = true;
  for (const [expr, expectedTypes] of cases) {
    const got = tokenTypesFor(expr);
    if (JSON.stringify(got) !== JSON.stringify(expectedTypes)) {
      ok = false;
      console.log(`  ${JSON.stringify(expr)}: expected ${JSON.stringify(expectedTypes)}, got ${JSON.stringify(got)}`);
    }
  }
  console.log(`  [${ok ? "PASS" : "FAIL"}] identifiers classified as variable/property/function by position, keywords/operators recognized`);
  if (!ok) failures++;
}

console.log("\nCEL highlighting source mapping (celExpr.ts celHighlightTokensInSource):");
{
  const parsed = parseTektonDocument(fs.readFileSync(path.join(__dirname, "trigger.yaml"), "utf8"));
  const loc = findCelExpressions(parsed)[0]; // header.match('X-GitHub-Event', 'push')
  const tokens = celHighlightTokensInSource(parsed.text, loc.range, loc.value, loc.style);
  const everyTokenWithinScalar = tokens.every(({ range }) => range[0] >= loc.range[0] && range[1] <= loc.range[1]);
  const everyTokenTextMatches = tokens.every(({ range, type }) => {
    const text = parsed.text.slice(range[0], range[1]);
    // spot-check a couple of concrete token texts land where expected
    if (type === "string") return text === "'X-GitHub-Event'" || text === "'push'";
    if (type === "function") return text === "match";
    return true;
  });
  const ok = tokens.length > 0 && everyTokenWithinScalar && everyTokenTextMatches;
  console.log(`  [${ok ? "PASS" : "FAIL"}] trigger.yaml filter expression: ${tokens.length} tokens, all within the scalar's own range (${JSON.stringify(tokens.map((t) => ({ type: t.type, text: parsed.text.slice(...t.range) })))})`);
  if (!ok) failures++;
}

console.log("\nCEL expressions in block scalars (`expression: |` / `expression: >`) -- validation and highlighting both need per-line source mapping, not just the plain/quoted-scalar substring shortcut:");
{
  const literalYaml = `apiVersion: triggers.tekton.dev/v1beta1
kind: Trigger
metadata:
  name: block-literal-cel
spec:
  interceptors:
    - ref:
        name: cel
      params:
        - name: overlays
          value:
            - key: broken
              expression: |
                1 >= 2 . true
  bindings:
    - ref: github-binding
  template:
    ref: build-template
`;
  const literalParsed = parseTektonDocument(literalYaml);
  const literalLoc = findCelExpressions(literalParsed)[0];
  const literalIssues = celIssuesInSource(literalParsed.text, literalLoc.range, literalLoc.value, literalLoc.style);
  // A precise mapping lands strictly inside the content line, not spanning the whole scalar
  // (which would also cover the "expression: |" header line above it).
  const literalPrecise =
    literalIssues.length === 1 &&
    literalIssues[0].range[0] > literalLoc.range[0] &&
    literalParsed.text.slice(...literalIssues[0].range) === "true";
  console.log(
    `  [${literalPrecise ? "PASS" : "FAIL"}] block literal (|): 1 issue, positioned at the offending token, not the whole scalar (${JSON.stringify(literalIssues.map((i) => ({ ...i, text: literalParsed.text.slice(...i.range) })))})`
  );
  if (!literalPrecise) failures++;

  const literalTokens = celHighlightTokensInSource(literalParsed.text, literalLoc.range, literalLoc.value, literalLoc.style);
  const literalHighlighted = literalTokens.length > 0 && literalTokens.every(({ range }) => literalParsed.text.slice(...range).length > 0);
  console.log(`  [${literalHighlighted ? "PASS" : "FAIL"}] block literal (|): ${literalTokens.length} highlight tokens produced (used to be silently skipped)`);
  if (!literalHighlighted) failures++;

  const foldedYaml = `apiVersion: triggers.tekton.dev/v1beta1
kind: Trigger
metadata:
  name: block-folded-cel
spec:
  interceptors:
    - ref:
        name: cel
      params:
        - name: filter
          value: >
            body.matches('push')
            && body.count > 0
  bindings:
    - ref: github-binding
  template:
    ref: build-template
`;
  const foldedParsed = parseTektonDocument(foldedYaml);
  const foldedLoc = findCelExpressions(foldedParsed)[0];
  const foldedIssues = celIssuesInSource(foldedParsed.text, foldedLoc.range, foldedLoc.value, foldedLoc.style);
  const foldedTokens = celHighlightTokensInSource(foldedParsed.text, foldedLoc.range, foldedLoc.value, foldedLoc.style);
  // valid expression (just folded across two source lines) -- no false positives, and tokens
  // from the second source line ("&& body.count > 0") should map onto that second line, not
  // collapse onto the first.
  const secondLineStart = foldedParsed.text.indexOf("&& body.count");
  const someTokenOnSecondLine = foldedTokens.some(({ range }) => range[0] >= secondLineStart);
  const foldedOk = foldedIssues.length === 0 && foldedTokens.length > 0 && someTokenOnSecondLine;
  console.log(
    `  [${foldedOk ? "PASS" : "FAIL"}] block folded (>): valid expression across 2 source lines, 0 issues, ${foldedTokens.length} highlight tokens, correctly spanning both lines`
  );
  if (!foldedOk) failures++;
}

// Everything above is synchronous; fetchClusterResources is the one async piece of logic in this
// whole file (it issues concurrent fake "kubectl" calls), so the final summary/exit is deferred
// until this resolves rather than converting the rest of the file to async.
async function runAsyncChecks() {
  console.log("\nCluster resource fetching (clusterResources.ts):");
  {
    const okKindCheck =
      isClusterResourceKind("Task") &&
      isClusterResourceKind("ClusterTask") &&
      isClusterResourceKind("StepAction") &&
      !isClusterResourceKind("PipelineRun") &&
      !isClusterResourceKind("Unknown") &&
      !isClusterResourceKind(42);
    console.log(`  [${okKindCheck ? "PASS" : "FAIL"}] isClusterResourceKind recognizes the 7 fetchable kinds, rejects everything else`);
    if (!okKindCheck) failures++;
  }

  {
    const calls = [];
    const runner = async (command, args) => {
      calls.push({ command, args });
      if (args.includes("tasks.tekton.dev")) {
        return JSON.stringify({
          items: [
            {
              apiVersion: "tekton.dev/v1",
              kind: "Task",
              metadata: { name: "shared-build", namespace: "shared-tasks", uid: "abc-123", resourceVersion: "999" },
              spec: { params: [{ name: "image", type: "string" }], steps: [{ name: "build", image: "alpine" }] },
              status: { conditions: [] },
            },
          ],
        });
      }
      return JSON.stringify({ items: [] });
    };

    const config = { command: "kubectl", sources: [{ namespace: "shared-tasks", kinds: ["Task"] }] };
    const result = await fetchClusterResources(config, { runner });

    const call = calls.find((c) => c.args.includes("tasks.tekton.dev"));
    const okNamespacedArgs = !!call && call.command === "kubectl" && call.args.includes("-n") && call.args.includes("shared-tasks");
    console.log(`  [${okNamespacedArgs ? "PASS" : "FAIL"}] namespaced kind fetched with "-n <namespace>" (${JSON.stringify(call && call.args)})`);
    if (!okNamespacedArgs) failures++;

    const okResource =
      result.resources.length === 1 &&
      result.resources[0].kind === "Task" &&
      result.resources[0].name === "shared-build" &&
      result.resources[0].namespace === "shared-tasks";
    console.log(`  [${okResource ? "PASS" : "FAIL"}] fetched resource shape correct (${JSON.stringify(result.resources)})`);
    if (!okResource) failures++;

    const yamlText = result.resources[0].yamlText;
    const okNoServerNoise = !yamlText.includes("uid:") && !yamlText.includes("resourceVersion:") && !yamlText.includes("status:");
    const reparsed = parseTektonDocument(yamlText);
    const okReparse =
      reparsed &&
      reparsed.symbols.kind === "Task" &&
      reparsed.symbols.metadataName === "shared-build" &&
      reparsed.symbols.params.map((p) => p.name).join(",") === "image";
    console.log(
      `  [${okNoServerNoise && okReparse ? "PASS" : "FAIL"}] server-bookkeeping fields stripped, re-serialized YAML round-trips through parseTektonDocument`
    );
    if (!okNoServerNoise || !okReparse) {
      console.log({ yamlText });
      failures++;
    }

    console.log(`  [${result.errors.length === 0 ? "PASS" : "FAIL"}] no errors reported for a clean fetch`);
    if (result.errors.length !== 0) failures++;
  }

  {
    // ClusterTask is cluster-scoped: no "-n" flag, and fetched only once even though two source
    // entries both ask for it.
    const calls = [];
    const runner = async (command, args) => {
      calls.push(args);
      return JSON.stringify({ items: [] });
    };
    const config = {
      command: "kubectl",
      sources: [
        { namespace: "team-a", kinds: ["ClusterTask"] },
        { namespace: "team-b", kinds: ["ClusterTask"] },
      ],
    };
    await fetchClusterResources(config, { runner });
    // One "version --client" pre-flight call always happens first (see below); only the real
    // "get" calls are what dedup applies to.
    const getCalls = calls.filter((c) => c[0] === "get");
    const okDeduped = getCalls.length === 1;
    const okNoNamespaceFlag = getCalls[0] && !getCalls[0].includes("-n");
    console.log(`  [${okDeduped && okNoNamespaceFlag ? "PASS" : "FAIL"}] cluster-scoped kind (ClusterTask) fetched once, without "-n", even when two sources request it`);
    if (!okDeduped || !okNoNamespaceFlag) {
      console.log({ calls });
      failures++;
    }
  }

  {
    // One source failing doesn't block another from succeeding, and the failure is reported
    // rather than silently swallowed.
    const runner = async (command, args) => {
      if (args.includes("shared-tasks")) throw new Error("namespaces \"shared-tasks\" not found");
      return JSON.stringify({
        items: [{ apiVersion: "tekton.dev/v1", kind: "Task", metadata: { name: "other-task", namespace: "other-ns" }, spec: {} }],
      });
    };
    const config = {
      command: "kubectl",
      sources: [
        { namespace: "shared-tasks", kinds: ["Task"] },
        { namespace: "other-ns", kinds: ["Pipeline"] },
      ],
    };
    const result = await fetchClusterResources(config, { runner });
    const okPartialSuccess = result.resources.length === 1 && result.resources[0].name === "other-task";
    const okErrorReported = result.errors.length === 1 && result.errors[0].namespace === "shared-tasks" && /not found/.test(result.errors[0].message);
    console.log(`  [${okPartialSuccess && okErrorReported ? "PASS" : "FAIL"}] one source failing doesn't block another from succeeding, and is reported in errors`);
    if (!okPartialSuccess || !okErrorReported) {
      console.log({ result });
      failures++;
    }
  }

  {
    // The configured command doesn't exist at all (e.g. it's really only a shell alias, which
    // execFile -- never going through a shell -- can't see) -- one clear, actionable message
    // instead of the same raw ENOENT repeated once per (namespace, kind) pair.
    const calls = [];
    const runner = async (command, args) => {
      calls.push(args);
      const err = new Error(`spawn ${command} ENOENT`);
      err.code = "ENOENT";
      throw err;
    };
    const config = {
      command: "kubectl",
      sources: [
        { namespace: "shared-tasks", kinds: ["Task"] },
        { namespace: "shared-tasks", kinds: ["Pipeline"] },
      ],
    };
    const result = await fetchClusterResources(config, { runner });
    const okOneAttempt = calls.length === 1; // short-circuits before ever attempting a real fetch
    const okCommandError =
      typeof result.commandError === "string" &&
      /kubectl.*not.*runnable|not found on PATH/i.test(result.commandError) &&
      /alias|function/i.test(result.commandError);
    const okNoResourcesOrErrors = result.resources.length === 0 && result.errors.length === 0;
    console.log(
      `  [${okOneAttempt && okCommandError && okNoResourcesOrErrors ? "PASS" : "FAIL"}] ENOENT on the configured command short-circuits to one commandError mentioning the shell-alias possibility, not per-source noise (${JSON.stringify(result.commandError)})`
    );
    if (!okOneAttempt || !okCommandError || !okNoResourcesOrErrors) {
      console.log({ calls, result });
      failures++;
    }
  }

  {
    // A command that exists but fails "version --client" for some unrelated reason (e.g. an old
    // client, a wrapper script with its own exit code) must NOT be treated as "not found" -- only
    // an actual ENOENT short-circuits. Real per-source fetches still get a chance to run.
    const runner = async (command, args) => {
      if (args[0] === "version") throw new Error("unknown flag: --client");
      return JSON.stringify({
        items: [{ apiVersion: "tekton.dev/v1", kind: "Task", metadata: { name: "shared-build", namespace: "shared-tasks" }, spec: {} }],
      });
    };
    const config = { command: "kubectl", sources: [{ namespace: "shared-tasks", kinds: ["Task"] }] };
    const result = await fetchClusterResources(config, { runner });
    const okNoCommandError = result.commandError === undefined;
    const okStillFetched = result.resources.length === 1 && result.resources[0].name === "shared-build";
    console.log(`  [${okNoCommandError && okStillFetched ? "PASS" : "FAIL"}] a non-ENOENT failure on the pre-flight check doesn't block the real fetch`);
    if (!okNoCommandError || !okStillFetched) {
      console.log({ result });
      failures++;
    }
  }

  {
    const okSimple = JSON.stringify(splitCommandLine("kubectl")) === JSON.stringify(["kubectl"]);
    const okWrapper = JSON.stringify(splitCommandLine("microk8s kubectl")) === JSON.stringify(["microk8s", "kubectl"]);
    const okQuotedPath =
      JSON.stringify(splitCommandLine('"C:\\Program Files\\bin\\kubectl.exe" --context foo')) ===
      JSON.stringify(["C:\\Program Files\\bin\\kubectl.exe", "--context", "foo"]);
    console.log(
      `  [${okSimple && okWrapper && okQuotedPath ? "PASS" : "FAIL"}] splitCommandLine: plain command, wrapper+subcommand, and a quoted path-with-spaces all tokenize correctly`
    );
    if (!okSimple || !okWrapper || !okQuotedPath) {
      console.log({ simple: splitCommandLine("kubectl"), wrapper: splitCommandLine("microk8s kubectl"), quoted: splitCommandLine('"C:\\Program Files\\bin\\kubectl.exe" --context foo') });
      failures++;
    }
  }

  {
    // "microk8s kubectl" -- a wrapper binary plus a fixed subcommand -- should invoke the real
    // executable ("microk8s") with "kubectl" prepended to every call's own args, not try (and
    // fail) to spawn a single file literally named "microk8s kubectl".
    const calls = [];
    const runner = async (executable, args) => {
      calls.push({ executable, args });
      if (args.includes("tasks.tekton.dev")) {
        return JSON.stringify({
          items: [{ apiVersion: "tekton.dev/v1", kind: "Task", metadata: { name: "shared-build", namespace: "shared-tasks" }, spec: {} }],
        });
      }
      return JSON.stringify({ items: [] });
    };
    const config = { command: "microk8s kubectl", sources: [{ namespace: "shared-tasks", kinds: ["Task"] }] };
    const result = await fetchClusterResources(config, { runner });

    const okExecutable = calls.every((c) => c.executable === "microk8s");
    const okPrefixed = calls.every((c) => c.args[0] === "kubectl");
    const getCall = calls.find((c) => c.args.includes("get"));
    const okGetArgs = getCall && getCall.args.join(" ") === "kubectl get tasks.tekton.dev -o json -n shared-tasks";
    const okFetched = result.resources.length === 1 && result.resources[0].name === "shared-build";
    console.log(
      `  [${okExecutable && okPrefixed && okGetArgs && okFetched ? "PASS" : "FAIL"}] command "microk8s kubectl": every call spawns "microk8s" with "kubectl" prepended (${JSON.stringify(calls)})`
    );
    if (!okExecutable || !okPrefixed || !okGetArgs || !okFetched) {
      console.log({ calls, result });
      failures++;
    }
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void runAsyncChecks();
