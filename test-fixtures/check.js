// Standalone sanity check (no vscode API) exercising the core parsing/validation logic
// against the fixtures in this directory. Run with: node test-fixtures/check.js
const fs = require("fs");
const path = require("path");
const {
  parseTektonDocument,
  resolveParamsTarget,
  resolvePipelineSpecOwner,
  resolveTaskSpecOwner,
  pipelineTaskEntryMaps,
  findEnclosingTaskEntry,
  stepAndSidecarEntryMaps,
  findEnclosingStepEntry,
  findSeqIn,
  trimTrailingNewline,
} = require("../out/tekton/model");
const { findParamRefs } = require("../out/tekton/paramRefs");
const { closestMatch } = require("../out/tekton/levenshtein");
const { findDuplicateGroups } = require("../out/tekton/duplicates");
const { findMissingRunAfter } = require("../out/tekton/runAfterCheck");
const { blockAfterText, quoteYamlString } = require("../out/commands/snippetText");
const { findEmbeddedScriptBlocks, detectShebangLanguage, reindentScriptContent } = require("../out/tekton/scriptEmbed");
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
const YAML = require("yaml");

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

console.log("\nmulti-document YAML: known limitation, only the first document in a file is recognized:");
{
  // Pinned deliberately, not celebrated -- stepaction-and-task-multidoc.yaml bundles a StepAction
  // and a Task (referencing it) via `---` in one file, a common kubectl-apply pattern. parseDocument
  // (not parseAllDocuments) means the Task is entirely invisible; this documents that boundary so a
  // future change to it is a deliberate decision, not an unnoticed regression either way.
  const source = fs.readFileSync(path.join(__dirname, "stepaction-and-task-multidoc.yaml"), "utf8");
  const parsed = parseTektonDocument(source);
  const ok = parsed?.symbols.kind === "StepAction" && parsed?.symbols.metadataName === "shared-lint1";
  console.log(`  [${ok ? "PASS" : "FAIL"}] only the first document (StepAction "shared-lint1") is seen; the second (Task "build") is not`);
  if (!ok) {
    console.log({ kind: parsed?.symbols.kind, metadataName: parsed?.symbols.metadataName });
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
  const vscodeShim = { Position, Range, CompletionItem, CompletionItemKind: new Proxy({}, { get: () => 0 }) };

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
    const provider = new TektonRefCompletionProvider(workspaceIndex ?? {});
    return (provider.provideCompletionItems(doc, position) ?? []).map((i) => i.label);
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
    updateDecorations(editor, parseTektonDocument(text));
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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
