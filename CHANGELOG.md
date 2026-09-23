# Changelog

## 0.1.0 (unreleased)

First release.

- `DurableModel`: one durable step per model request. Records and replays the stream, retries only transient errors, emits live text events, and restores `modelState`.
- `DurableTool`: one durable step per tool use. Separates business errors from `RetryableToolError`, restores `appState`, and provides `currentToolExecution()` idempotency keys.
- `DurableToolExecutor`: parallel tools with a deterministic journal (one child context per tool use, in `toolUse` order).
- `invokeDurably`: turns Strands interrupts into durable callbacks.
- `durableWorkflowTool`: tools that use durable operations, including sub-agents.
- `durableMcpTools`: records the MCP tool list once per execution.
- `createOffloadSerdes` and `s3OffloadStore` (`strands-lambda-durable/s3`): moves large checkpoints to external storage.
