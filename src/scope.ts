import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { DurableContext, Serdes } from "@aws/durable-execution-sdk-js";

export type DurableToolExecution = {
  /**
   * Same value on every retry and replay of this tool use, and after an interrupt is resumed. Distinct for every
   * tool use of the execution, even if the model provider reuses a `toolUseId`. A SHA-256 hex digest, so the
   * execution ARN is not passed on to the APIs that receive it.
   */
  idempotencyKey: string;
  /** Step attempt, starting at 1. */
  attempt: number;
};

export const toolScope = new AsyncLocalStorage<DurableToolExecution>();

/** Key of the durable workflow tool use whose body is running; nested agents' tool uses are scoped under it. */
export const enclosingToolUse = new AsyncLocalStorage<string>();

/**
 * Per durable context: how many recorded model responses issued each `toolUseId`. `DurableModel` counts, tools read.
 * A resumed interrupt re-runs a tool use without a new model response, so it keeps its count and its key.
 */
export const toolUseOccurrences = new WeakMap<DurableContext, Map<string, number>>();

/** Idempotency key of the current use of `toolUseId` by the agent built over `context`. */
export function toolUseKey(context: DurableContext, toolUseId: string): string {
  const occurrence = toolUseOccurrences.get(context)?.get(toolUseId) ?? 0;
  return createHash("sha256")
    .update([context.executionContext.durableExecutionArn, enclosingToolUse.getStore() ?? "", toolUseId, occurrence].join("\0"))
    .digest("hex");
}

/** Returns the current durable tool execution. Call it from a tool callback wrapped by `DurableTool`. */
export function currentToolExecution(): DurableToolExecution {
  const execution = toolScope.getStore();
  if (!execution) throw new Error("currentToolExecution() must be called inside a DurableTool");
  return execution;
}

/** Durable work a tool runs for one tool use, given the context it must use. */
export type ToolRun = (context: DurableContext) => Promise<unknown>;

type Slot = { claim: (run: ToolRun | undefined) => void; result: Promise<unknown> };

/**
 * Fixes the durable operation order of one model turn's tool uses before any of them starts.
 *
 * Durable operation IDs come from call order. Tools that run concurrently would otherwise create their steps in
 * whatever order their hooks and I/O happen to finish, and a replay could match results to the wrong tool use.
 * The coordinator opens one child context per tool use, in `toolUse` order, synchronously. Each durable tool then
 * claims its slot by `toolUseId` and runs inside that child context. On replay, a completed child context returns
 * its recorded result without waiting for the claim.
 */
export class TurnCoordinator {
  private readonly slots = new Map<string, Slot>();

  constructor(context: DurableContext, turn: number, toolUseIds: readonly string[], serdes: Serdes<any> | undefined) {
    toolUseIds.forEach((toolUseId, index) => {
      const { promise: claimed, resolve: claim } = Promise.withResolvers<ToolRun | undefined>();
      const durable = context.runInChildContext(
        `tools-${turn}-${index}`,
        async child => {
          const run = await claimed;
          // `null` marks a tool use that no durable tool claimed (unknown tool, cancelled by a hook, plain tool).
          return run ? await run(child) : null;
        },
        serdes ? { serdes } : undefined,
      );
      // DurablePromise is lazy; adopting it into a native promise starts it now. Failures surface to the claimer.
      const result = Promise.resolve(durable);
      result.catch(() => {});
      this.slots.set(toolUseId, { claim, result });
    });
  }

  /** Runs `run` in the tool use's child context and returns the child context's (recorded) result. */
  claim(toolUseId: string, run: ToolRun): Promise<unknown> {
    const slot = this.slots.get(toolUseId);
    if (!slot) throw new Error(`Tool use ${toolUseId} is not part of the current durable turn`);
    slot.claim(run);
    return slot.result;
  }

  /** Releases unclaimed slots and waits until every child context of the turn is settled. */
  async finish(): Promise<void> {
    for (const slot of this.slots.values()) slot.claim(undefined);
    await Promise.allSettled([...this.slots.values()].map(slot => slot.result));
  }
}

/** Active coordinator per agent; set by `DurableToolExecutor` while a turn's tools run. */
export const coordinators = new WeakMap<object, TurnCoordinator>();
