# strands-lambda-durable-functions

[![CI](https://github.com/har1101/strands-lambda-durable-functions/actions/workflows/ci.yml/badge.svg)](https://github.com/har1101/strands-lambda-durable-functions/actions/workflows/ci.yml)

English | [日本語](./README.ja.md)

An **unofficial community extension for [Strands Agents](https://strandsagents.com) (TypeScript)** that runs agents on [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html). Each model request and each tool use becomes its own durable step. If a Lambda invocation stops, the next one replays completed steps from the journal instead of calling the model or the tool again.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by the Strands Agents project or Amazon Web Services. It is an add-on, not a fork: you keep using `@strands-agents/sdk` and its agent loop as they are. The package wraps Strands' public `Model` and `Tool` extension points and adds a tool executor. Strands and the durable execution SDK are peer dependencies.

> Status: pre-1.0. The API may change between minor versions. Supported: `@strands-agents/sdk` >= 1.18 < 2, `@aws/durable-execution-sdk-js` >= 2.4 < 3, Node.js 22+.

## Install

```bash
npm install strands-lambda-durable-functions @strands-agents/sdk @aws/durable-execution-sdk-js zod
# for S3 offloading of large checkpoints
npm install @aws-sdk/client-s3
```

Until the package is published to npm, install the tarball from the [GitHub release](https://github.com/har1101/strands-lambda-durable-functions/releases) instead. Releases after 0.2.0 also carry `SHA256SUMS` and a GitHub build provenance attestation; verify the tarball before installing it:

```bash
curl -fLO https://github.com/har1101/strands-lambda-durable-functions/releases/download/v<version>/strands-lambda-durable-functions-<version>.tgz
gh attestation verify strands-lambda-durable-functions-<version>.tgz --repo har1101/strands-lambda-durable-functions
npm install ./strands-lambda-durable-functions-<version>.tgz
```

## Quick start

```ts
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  DurableModel, DurableTool, DurableToolExecutor, currentToolExecution, invokeDurably,
} from "strands-lambda-durable-functions";

export const handler = withDurableExecution(async (event: { prompt: string }, context) => {
  // Build a fresh agent on every invocation; the durable journal, not memory, carries progress.
  const refund = tool({
    name: "issue_refund",
    description: "Refund an order. A human must approve.",
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    callback: async ({ orderId, amount }, toolContext) => {
      const decision = toolContext!.interrupt({ name: "approval", reason: { orderId, amount } });
      // Accept only an explicit approval: "false", "yes", or a missing field all reject.
      if (!z.object({ approved: z.literal(true) }).safeParse(decision).success) return { status: "rejected" };
      // Stable across retries, replays and the resumed interrupt: pass it to the payment API.
      const { idempotencyKey } = currentToolExecution();
      return await payments.refund({ orderId, amount, idempotencyKey });
    },
  });

  const agent = new Agent({
    model: new DurableModel(new BedrockModel({ modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }), context),
    tools: [new DurableTool(refund, context)],
    toolExecutor: new DurableToolExecutor(context),
    retryStrategy: null, // retries belong to the durable steps
  });

  const result = await invokeDurably(agent, context, event.prompt, {
    // Send the callback ID to your approval backend, not to the user who asked. The Lambda invocation ends while it waits.
    onInterrupt: async ({ callbackId, interrupt }) => notifyApprover(callbackId, interrupt),
    interruptTimeout: { hours: 24 },
  });
  return result.toString();
});
```

The approval backend answers with `aws lambda send-durable-execution-callback-success --callback-id ... --result '{"approved":true}'` (or the SDK). A new invocation replays the journal and resumes the same tool use with that answer. Anyone who holds the callback ID and may call `lambda:SendDurableExecutionCallbackSuccess` can answer; see [Security](#security).

## API

| Export | What it does |
| --- | --- |
| `DurableModel(source, context, options?)` | One step per model request (`model-<n>`). Records the full event stream and replays it without calling the provider. Options: `events` (live `model_start`/`text` events, text coalesced every `textFlushMs`, default 100 ms), `retryStrategy` (default `modelRetryStrategy`: throttling, 5xx, and timeouts, up to 4 attempts; validation errors fail at once), `serdes`. Restores `modelState` for stateful providers. |
| `DurableTool(source, context, options?)` | One step per tool use. An exception from the tool is a business outcome: it is checkpointed as an error result for the model. `RetryableToolError` retries only that step (`toolRetryStrategy`, 3 attempts); once retries are exhausted it becomes an error result. Restores `agent.appState` changes. Options: `events`, `eventDetails` (include tool output in `tool` events; default `false`), `retryStrategy`, `serdes`. |
| `DurableToolExecutor(context, options?)` | Parallel tools with a deterministic journal. Before a turn's tools start, it opens one child context per tool use, in `toolUse` order (`tools-<turn>-<index>`); each durable tool runs in its own child context. The order in which tools start or finish does not change operation IDs. Without it, use `toolExecutor: "sequential"`: overlapping `DurableTool` steps are rejected. |
| `invokeDurably(agent, context, input, options)` | `agent.invoke` that turns every Strands interrupt (tool `interrupt()`, hook interrupts) into `context.waitForCallback`. The callback's JSON result becomes the interrupt response. `onInterrupt` runs as a durable step. |
| `durableWorkflowTool(context, config)` | A tool whose body runs in a child context and may use any durable operation: waits, callbacks, invokes, or a sub-agent built with `DurableModel` over the child context. |
| `durableMcpTools(context, mcpClient, { id, filter? })` | Lists an MCP server's tools once per execution (`mcp-tools-<id>` step) and wraps them in `DurableTool`. Later invocations of that execution keep the recorded list; new executions see the current one. `filter` limits the tools offered to the agent. A recorded tool whose input schema has changed on the server is not called; the model gets an error result. |
| `createOffloadSerdes({ store, thresholdBytes?, prefix? })` | JSON serdes that stores checkpoint payloads above the threshold (default 64 KiB) in an `OffloadStore` and keeps a pointer with the payload's SHA-256 digest in the journal. A pointer is followed only to the object its own operation wrote, and replay fails if that object has changed. Pass it as `serdes` to the model, the tools, and the executor. |
| `s3OffloadStore({ client, bucket, prefix?, expectedBucketOwner?, serverSideEncryption?, sseKmsKeyId?, maxBytes? })` (from `strands-lambda-durable-functions/s3`) | `OffloadStore` on Amazon S3. `expectedBucketOwner` pins the bucket's account, `serverSideEncryption`/`sseKmsKeyId` select SSE-KMS, and `maxBytes` (default 64 MiB) bounds each checkpoint written or read. Give the bucket a lifecycle rule longer than the durable retention period. |
| `currentToolExecution()` | Inside a durable tool: `{ idempotencyKey, attempt }`. The key is a SHA-256 hex digest. It stays the same across retries, replays, and the resumed interrupt, differs for every tool use even if the provider reuses a `toolUseId`, and does not contain the execution ARN. |
| `modelRetryStrategy`, `toolRetryStrategy`, `RetryableToolError` | Default retry policies and the retry signal. |
| `EventSink`, `DurableLiveEvent` | Receives provisional live events. A new `attempt` on `model_start` replaces that call's earlier text. |

## Guarantees and limits

- **What is replayed.** Completed model calls and tool uses are replayed from the journal, not executed again. This includes error results, interrupts, `appState` changes, and `modelState`. Binary content (`Uint8Array`) is kept. Each tool use records only the `appState` keys it set or deleted, so parallel tools do not overwrite each other's changes. If two parallel tools write the same key, the final value depends on completion order; use distinct keys. A tool use that fails permanently or raises an interrupt keeps no `appState` changes. Checkpoints are versioned: `schemaVersion` 4, and versions 1 to 3 are still read.
- **Tool use IDs.** Tool uses in one model response need distinct `toolUseId`s; a response that repeats one fails the execution, because Strands and the journal match results and interrupt answers by ID. Providers that reuse IDs across responses are fine: each use gets its own idempotency key.
- **Not exactly-once.** A step can run again if the process stops after its side effect and before its checkpoint. Pass `idempotencyKey` to an API that deduplicates on it.
- **Determinism is your part.** Build the agent the same way on every invocation. Keep work that is not durable (hooks with I/O, clocks, random values) out of decisions, or move it into a durable tool. Tools that are not wrapped run again on every replay.
- **Live events are provisional.** They are side effects of a running step. Retried attempts emit new events with a new `attempt`. Use the journal (or your own store written in a step) as the source of truth.
- **Quotas.** Lambda allows 3,000 operations and 100 MB of checkpoint data per execution. Use `createOffloadSerdes` for large tool results. Split very long conversations into several executions, for example one execution per user message, with history kept in your own store.
- **Versions.** Invoke a published version or alias, so that a running execution keeps the code that matches its journal.

## Security

- **Approvals.** A callback ID lets anyone allowed to call `lambda:SendDurableExecutionCallbackSuccess` on the function answer that interrupt, and the library does not know who answered. Send callback IDs only to your approval backend, never to the user who asked for the action, and do not log them. The backend must authenticate the approver, check that this person may approve this interrupt (store the callback ID with the interrupt and its allowed approvers), and send the answer itself. Validate the answer in the tool, as in the quick start, and set `interruptTimeout`. The `reason` values that approvers see come from the model's tool input: show them as data, and make them describe exactly what the tool will do.
- **What the journal keeps.** Checkpoints hold model output (text, reasoning, tool-call arguments), `modelState`, tool results, tool error messages, `appState` changes, and interrupt reasons as plain JSON for the execution's retention period; large ones go to the offload store. Grant `lambda:GetDurableExecution*` and read access to the offload bucket only to principals that may see this data. Keep secrets out of `appState`, tool results, and exception messages: tool errors are shown to the model and stored.
- **Offloading.** Use a dedicated bucket or prefix and allow `s3:PutObject` on it only to the function's role. The journal keeps each offloaded object's key and digest, so a tampered or foreign object never reaches the agent: the invocation that reads it fails. The durable SDK treats that like any serdes failure and retries the invocation, so the execution makes no progress until you stop it (`aws lambda stop-durable-execution`) or it times out. Set `expectedBucketOwner`, and `serverSideEncryption: "aws:kms"` if the data needs a KMS key policy.
- **Live events.** `text` events stream the model's answer. `tool` events carry only the tool name, `toolUseId`, and status unless you set `eventDetails: true`. Set it only if everyone who reads the sink may see everything the tools return.
- **MCP.** An MCP server's tool descriptions go into the prompt, and its tools run with whatever the server can reach. Connect only servers you trust and offer only the tools you need with `filter`.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Example

[strands-lambda-durable-ts](https://github.com/har1101/strands-lambda-durable-ts) is a deployable chat app built on this package (AWS SAM, Cognito, CloudFront, AppSync Events). It shows parallel tools, approval with durable callbacks, live streaming, and conversation history.

## Testing your agent

The durable SDK's `LocalDurableTestRunner` runs a handler locally. It supports suspension, callbacks, and retries. See this repository's `test/` directory for a provider-independent scripted model and the scenarios covered: replay, retries, interrupts, parallel tools, MCP, offloading, and `modelState`. If a test depends on the invocation ending, use real timers (`skipTime: false`). The SDK ends an idle invocation after a 20 ms cooldown, and with skipped time a short wait can finish before that happens.

## License

MIT. See [LICENSE](./LICENSE). Contributions: see [CONTRIBUTING.md](./CONTRIBUTING.md).
