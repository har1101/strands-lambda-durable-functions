# Changelog

## 0.2.0 (2026-09-24)

- Renamed the package and repository from `strands-lambda-durable` to `strands-lambda-durable-functions`, so the name says which AWS service it integrates with. Update imports (`strands-lambda-durable-functions`, `strands-lambda-durable-functions/s3`). No API or checkpoint format changes.
- README states that this is an unofficial community extension for Strands Agents, not a fork, and not affiliated with the Strands Agents project or AWS.

## 0.1.1 (2026-09-23)

- `DurableTool`: a tool use whose step fails permanently or raises an interrupt now undoes its live `appState` changes. The journal keeps no changes for such a step, so live state and replayed state now match.

## 0.1.0 (2026-09-23)

First release.

- `DurableModel`: one durable step per model request. Records and replays the stream, retries only transient errors, emits live text events, and restores `modelState`.
- `DurableTool`: one durable step per tool use. Separates business errors from `RetryableToolError`, restores `appState`, and provides `currentToolExecution()` idempotency keys.
- `DurableToolExecutor`: parallel tools with a deterministic journal (one child context per tool use, in `toolUse` order).
- `invokeDurably`: turns Strands interrupts into durable callbacks.
- `durableWorkflowTool`: tools that use durable operations, including sub-agents.
- `durableMcpTools`: records the MCP tool list once per execution.
- `createOffloadSerdes` and `s3OffloadStore` (`strands-lambda-durable/s3`): moves large checkpoints to external storage.
