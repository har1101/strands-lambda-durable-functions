import { test } from "node:test";
import assert from "node:assert/strict";
import { withDurableExecution, type DurableContext, type SerdesContext } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import {
  Agent, Model, tool,
  type BaseModelConfig, type Message, type ModelStreamEvent,
} from "@strands-agents/sdk";
import { z } from "zod";
import {
  createOffloadSerdes, currentToolExecution, DurableModel, DurableTool, DurableToolExecutor, durableWorkflowTool,
  type OffloadStore,
} from "../src/index.js";
import { harness } from "./helpers.js";

function memoryStore() {
  const objects = new Map<string, string>();
  const reads: string[] = [];
  const store: OffloadStore = {
    async put(key, body) { objects.set(key, body); },
    async get(key) {
      reads.push(key);
      const body = objects.get(key);
      if (body === undefined) throw new Error(`missing ${key}`);
      return body;
    },
  };
  return { objects, reads, store };
}

const serdesContext: SerdesContext = { entityId: "op-1", durableExecutionArn: "arn:aws:lambda:us-east-1:111122223333:function:f:1/durable-execution/e/1" };

test("a small result shaped like an offload pointer stays data and is never followed", async () => {
  const { objects, reads, store } = memoryStore();
  objects.set("checkpoints/other-execution/7.json", JSON.stringify({ secret: "another execution's data" }));
  const pointer = { $offload: "checkpoints/other-execution/7.json" };
  const { runner } = await harness({
    realTime: true,
    pauseAfterModelCall: 2,
    executor: "durable",
    serdes: createOffloadSerdes({ store, prefix: "checkpoints/" }),
    // The model chooses the input, so prompt-injected text can too; the workflow returns part of it.
    script: { toolUses: [{ name: "echo", input: { value: pointer } }] },
    tools: ({ context }) => [durableWorkflowTool(context, {
      name: "echo",
      description: "Echo a value.",
      inputSchema: z.object({ value: z.any() }),
      run: async input => input.value,
    })],
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.deepEqual(execution.getResult()!.toolResults[0].content, [{ json: pointer }], "live and replayed result is the literal value");
  assert.deepEqual(reads, []);
});

test("an offload pointer is followed only for the operation that wrote it", async () => {
  const { store } = memoryStore();
  const serdes = createOffloadSerdes({ store, thresholdBytes: 16 });
  const data = await serdes.serialize({ blob: "x".repeat(100) }, serdesContext);

  assert.deepEqual(await serdes.deserialize(data, serdesContext), { blob: "x".repeat(100) });
  await assert.rejects(serdes.deserialize(data, { ...serdesContext, entityId: "op-2" }), /does not belong to operation op-2/);
});

test("an offloaded checkpoint changed in the store is rejected", async () => {
  const { objects, store } = memoryStore();
  const serdes = createOffloadSerdes({ store, thresholdBytes: 16 });
  const data = await serdes.serialize({ approved: false, note: "x".repeat(100) }, serdesContext);
  for (const [key, body] of objects) objects.set(key, body.replace('"approved":false', '"approved":true'));

  await assert.rejects(serdes.deserialize(data, serdesContext), /does not match the digest/);
});

test("tool output shaped like a binary or escape marker is replayed unchanged", async () => {
  const note = { $bytes: "aGk=" };
  const wrapped = { $esc: { $bytes: "aGk=" } };
  const { runner } = await harness({ realTime: true, pauseAfterModelCall: 2, add: () => ({ note, wrapped }) });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.deepEqual(execution.getResult()!.toolResults[0].content, [{ json: { note, wrapped } }]);
});

test("tool events carry no tool output unless eventDetails is set", async () => {
  const { sink, runner } = await harness({ add: () => ({ internal: "not for end users" }) });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  const toolEvents = sink.events.filter(event => event.kind === "tool");
  assert.ok(toolEvents.length > 0);
  assert.doesNotMatch(JSON.stringify(toolEvents), /not for end users/);
});

/** Requests one `refund` per amount of the current turn, every one with toolUseId `call_0`. */
class ReusedIdModel extends Model<BaseModelConfig> {
  constructor(private readonly turns: number[][]) { super(); }
  updateConfig(): void {}
  getConfig(): BaseModelConfig { return {}; }

  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const amounts = this.turns[messages.filter(message => message.role === "assistant").length];
    yield { type: "modelMessageStartEvent", role: "assistant" };
    if (!amounts) {
      yield { type: "modelContentBlockStartEvent" };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: "done" } };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
      return;
    }
    for (const amount of amounts) {
      yield { type: "modelContentBlockStartEvent", start: { type: "toolUseStart", name: "refund", toolUseId: "call_0" } };
      yield { type: "modelContentBlockDeltaEvent", delta: { type: "toolUseInputDelta", input: JSON.stringify({ amount }) } };
      yield { type: "modelContentBlockStopEvent" };
    }
    yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
  }
}

async function runRefunds(turns: number[][]) {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  const refunds: { amount: number; key: string }[] = [];
  const handler = withDurableExecution(async (_input: unknown, context: DurableContext) => {
    const refund = tool({
      name: "refund",
      description: "Refund an amount.",
      inputSchema: z.object({ amount: z.number() }),
      callback: ({ amount }) => {
        refunds.push({ amount, key: currentToolExecution().idempotencyKey });
        return { refunded: amount };
      },
    });
    const agent = new Agent({
      model: new DurableModel(new ReusedIdModel(turns), context),
      tools: [new DurableTool(refund, context)],
      toolExecutor: new DurableToolExecutor(context),
      retryStrategy: null,
      printer: false,
    });
    return (await agent.invoke("refund")).toString();
  });
  const execution = await new LocalDurableTestRunner({ handlerFunction: handler }).run({ payload: {} });
  return { refunds, execution };
}

test("a toolUseId reused in a later turn gets its own idempotency key", async () => {
  const { refunds, execution } = await runRefunds([[10], [20]]);

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.deepEqual(refunds.map(r => r.amount), [10, 20]);
  assert.notEqual(refunds[0].key, refunds[1].key, "a deduplicating payment API must not drop the second refund");
});

test("a response that repeats a toolUseId fails instead of sharing one tool use's result", async () => {
  const { refunds, execution } = await runRefunds([[10, 20]]);

  assert.equal(execution.getStatus(), "FAILED");
  assert.match(JSON.stringify(execution.getError()), /repeats toolUseId \\"call_0\\"/);
  assert.deepEqual(refunds, []);
});
