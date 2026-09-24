# Changelog

## Unreleased

Security fixes from a review. Executions started on an earlier version keep working if they keep running on that version (invoke a published version or alias).

- `createOffloadSerdes`: a pointer is followed only if its key is the one the current operation writes, and new pointers record the payload's SHA-256 digest, which is checked on read. Before, a small result shaped like `{"$offload": key}` (for example a workflow tool returning model-chosen input) was replaced with any object under the store's prefix, and a changed object in the store was trusted. Inline values shaped like a pointer are now stored as `{"$inline": value}`. Pointers written by earlier versions are still read.
- `s3OffloadStore`: new options `expectedBucketOwner`, `serverSideEncryption`, `sseKmsKeyId`, and `maxBytes` (default 64 MiB; larger checkpoints are rejected on write and on read).
- Checkpoint `schemaVersion` 4: data shaped like a codec marker (`{"$bytes": …}`, `{"$esc": …}`) is escaped, so tool output no longer decodes as a `Uint8Array`. Tool records name their tool use and tool, and replay rejects a record that belongs to another tool use. Versions 1 to 3 are still read.
- **Breaking:** `currentToolExecution().idempotencyKey` is a SHA-256 hex digest instead of `<execution ARN>#<toolUseId>`. It no longer passes the execution ARN to downstream APIs, and it differs between tool uses when a provider reuses a `toolUseId` in a later response (before, both got the same key, so a deduplicating API dropped the second call). It is still stable across retries, replays, and a resumed interrupt.
- A model response or turn that repeats a `toolUseId` fails the execution. Before, `DurableToolExecutor` ran only the first of them and gave its result to the others.
- **Breaking:** `tool` live events include the tool result, progress data, and interrupt reason only with the new `eventDetails: true` option of `DurableTool` and `durableMcpTools`.
- `durableMcpTools`: new `filter` option. A recorded tool whose input schema changed on the server returns an error result instead of being called.
- Release workflow: tests and packing run without secrets or write permissions and with `npm ci --ignore-scripts`; publishing runs in the `npm` environment with npm trusted publishing, or with `NPM_TOKEN` exposed only to the publish step; releases attach `SHA256SUMS` and a build provenance attestation. Actions are pinned to commit SHAs and updated by Dependabot.
- README: a security section (approvals, persisted data, offloading, live events, MCP), a strict approval check in the quick start, and tarball verification. Added `SECURITY.md`.

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
