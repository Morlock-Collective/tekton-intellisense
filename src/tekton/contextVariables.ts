/**
 * Built-in `$(context.*)` variables. Shared between completions and hover so
 * the two never drift apart.
 * Reference: https://tekton.dev/docs/pipelines/variables/#variables-available-in-a-taskrun
 */
export interface ContextVar {
  key: string;
  description: string;
}

export const CONTEXT_TREE: Record<string, ContextVar[]> = {
  pipeline: [{ key: "name", description: "Name of the Pipeline." }],
  pipelineRun: [
    { key: "name", description: "Name of the PipelineRun." },
    { key: "namespace", description: "Namespace the PipelineRun executes in." },
    { key: "uid", description: "UID of the PipelineRun." },
  ],
  pipelineTask: [
    { key: "retries", description: "Number of retries configured for this PipelineTask." },
  ],
  task: [{ key: "name", description: "Name of the Task." }],
  taskRun: [
    { key: "name", description: "Name of the TaskRun." },
    { key: "namespace", description: "Namespace the TaskRun executes in." },
    { key: "uid", description: "UID of the TaskRun." },
  ],
};

export const CONTEXT_GROUP_DESCRIPTIONS: Record<string, string> = {
  pipeline: "The Pipeline definition running this PipelineRun.",
  pipelineRun: "The PipelineRun executing this Pipeline.",
  pipelineTask: "The PipelineTask entry for the task currently executing.",
  task: "The Task definition running this TaskRun.",
  taskRun: "The TaskRun executing this Task.",
};
