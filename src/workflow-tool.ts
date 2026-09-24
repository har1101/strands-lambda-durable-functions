import type { DurableContext } from "@aws/durable-execution-sdk-js";
import { tool, type JSONValue } from "@strands-agents/sdk";
import type { z } from "zod";
import { coordinators, enclosingToolUse, toolUseKey } from "./scope.js";

export type DurableWorkflowToolConfig<S extends z.ZodType> = {
  name: string;
  description: string;
  inputSchema: S;
  /**
   * Runs in its own child context, so it may use any durable operation: steps, waits, callbacks,
   * invokes, or a sub-agent built with DurableModel/DurableTool over `child`. The return value is checkpointed.
   */
  run: (input: z.infer<S>, child: DurableContext, meta: { toolUseId: string }) => Promise<JSONValue>;
};

/** A tool whose body is a durable workflow. Do not wrap it in DurableTool: a step cannot contain durable operations. */
export function durableWorkflowTool<S extends z.ZodType>(context: DurableContext, config: DurableWorkflowToolConfig<S>) {
  return tool({
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    // DurablePromise is a lazy thenable, not a Promise; FunctionTool would serialize it unless awaited here.
    callback: async (input, toolContext) => {
      const toolUseId = toolContext!.toolUse.toolUseId;
      // Tool uses of agents inside `run` are keyed under this tool use, so their idempotency keys stay distinct
      // even if their model reuses toolUseIds that this agent's model also issued.
      const key = toolUseKey(context, toolUseId);
      const run = (child: DurableContext) => enclosingToolUse.run(key, () => config.run(input, child, { toolUseId }));
      const coordinator = coordinators.get(toolContext!.agent);
      if (coordinator) return await coordinator.claim(toolUseId, run) as JSONValue;
      return await context.runInChildContext(`workflow-${config.name}-${toolUseId}`, run);
    },
  });
}
