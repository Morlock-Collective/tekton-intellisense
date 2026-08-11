// Standalone sanity check (no vscode API) exercising the core parsing/validation logic
// against the fixtures in this directory. Run with: node test-fixtures/check.js
const fs = require("fs");
const path = require("path");
const { parseTektonDocument, resolveParamsTarget, findSeqIn, trimTrailingNewline } = require("../out/tekton/model");
const { findParamRefs } = require("../out/tekton/paramRefs");
const { closestMatch } = require("../out/tekton/levenshtein");
const { findDuplicateGroups } = require("../out/tekton/duplicates");
const { blockAfterText, quoteYamlString } = require("../out/commands/snippetText");
const {
  resolveRenameTarget,
  sameDocumentEdits,
  sameDocumentResultEdits,
  taskResultReferenceEdits,
  taskRefIdentityEdits,
  pipelineRefIdentityEdits,
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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
