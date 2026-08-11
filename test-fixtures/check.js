// Standalone sanity check (no vscode API) exercising the core parsing/validation logic
// against the fixtures in this directory. Run with: node test-fixtures/check.js
const fs = require("fs");
const path = require("path");
const { parseTektonDocument, resolveParamsTarget, findSeqIn, trimTrailingNewline } = require("../out/tekton/model");
const { findParamRefs } = require("../out/tekton/paramRefs");
const { closestMatch } = require("../out/tekton/levenshtein");
const { findDuplicateGroups } = require("../out/tekton/duplicates");
const { blockAfterText } = require("../out/commands/snippetText");
const YAML = require("yaml");

function check(file) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const parsed = parseTektonDocument(source);
  if (!parsed) {
    console.log(`${file}: NOT recognized as a Tekton document`);
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

  const refs = findParamRefs(parsed.text);
  for (const ref of refs) {
    let names;
    if (ref.kind === "param") names = parsed.symbols.params.map((p) => p.name);
    else if (ref.kind === "workspace") names = parsed.symbols.workspaces.map((w) => w.name);
    else if (ref.kind === "result") names = parsed.symbols.results.map((r) => r.name);
    else if (ref.kind === "task-result") names = parsed.symbols.tasks.map((t) => t.name);
    else continue;

    if (ref.name && !names.includes(ref.name)) {
      const suggestion = closestMatch(ref.name, names);
      console.log(
        `  [WARN] ${ref.kind} "${ref.name}" not declared.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`
      );
    }
  }
}

check("pipeline-typo.yaml");
check("helm-templated-task.yaml");

console.log("\nduplicate-name check:");
const dup = parseTektonDocument(fs.readFileSync(path.join(__dirname, "pipeline-duplicates.yaml"), "utf8"));
for (const [list, label] of [
  [dup.symbols.params, "parameter"],
  [dup.symbols.workspaces, "workspace"],
  [dup.symbols.results, "result"],
  [dup.symbols.tasks, "task"],
]) {
  for (const [name, occurrences] of findDuplicateGroups(list)) {
    console.log(`  [ERROR] duplicate ${label} name "${name}" — declared ${occurrences.length} times`);
  }
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
    return;
  }

  let after;
  try {
    after = YAML.parse(result);
  } catch (err) {
    console.log(`  [FAIL] ${file}: result is no longer valid YAML (${err.message})`);
    console.log(result);
    return;
  }

  const hasNewParam = containsNamedEntry(after, expectedName);
  const beforeSize = JSON.stringify(before).length;
  const growth = JSON.stringify(after).length - beforeSize;
  const reasonableGrowth = growth > 0 && growth < 500; // sanity bound — a glued/duplicated document would look wildly different

  const ok = hasNewParam && reasonableGrowth;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${file} (shape=${target.shape}): new param present=${hasNewParam}`);
  if (!ok) console.log(result);
}

console.log("\nadd-parameter simulation (context-aware target + no cursor):");
checkAddParameter("pipeline-typo.yaml", ['- name: new-param', '  type: string', '  description: "added by test"'], "new-param");
checkAddParameter("task-build-image.yaml", ["- name: new-param", "  type: string"], "new-param");
checkAddParameter("pipeline-crossfile.yaml", ["- name: new-param", "  type: string"], "new-param");
checkAddParameter("pipelinerun-ref.yaml", ["- name: new-param", "  value: something"], "new-param");
checkAddParameter("pipelinerun-inline.yaml", ["- name: new-param", "  type: string"], "new-param");
checkAddParameter("taskrun-ref.yaml", ["- name: new-param", "  value: something"], "new-param");
checkAddParameter("taskrun-inline.yaml", ["- name: new-param", "  type: string"], "new-param");

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
