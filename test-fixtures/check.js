// Standalone sanity check (no vscode API) exercising the core parsing/validation logic
// against the fixtures in this directory. Run with: node test-fixtures/check.js
const fs = require("fs");
const path = require("path");
const { parseTektonDocument } = require("../out/tekton/model");
const { findParamRefs } = require("../out/tekton/paramRefs");
const { closestMatch } = require("../out/tekton/levenshtein");

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
