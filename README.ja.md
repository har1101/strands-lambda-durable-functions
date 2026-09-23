# strands-lambda-durable

[![CI](https://github.com/har1101/strands-lambda-durable/actions/workflows/ci.yml/badge.svg)](https://github.com/har1101/strands-lambda-durable/actions/workflows/ci.yml)

[English](./README.md) | 日本語

[Strands Agents](https://strandsagents.com)（TypeScript）を [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) 上で動かすためのパッケージです。モデルへのリクエストとツールの実行は、1 回ごとに独立した durable step になります。Lambda の呼び出しが途中で止まっても、次の呼び出しは完了済みのステップをジャーナルからリプレイします。モデルやツールを呼び直すことはありません。Strands のエージェントループはそのまま使います。このパッケージは Strands の公開拡張ポイントである `Model` と `Tool` をラップし、ツールエグゼキューターを 1 つ追加します。

> ステータス: 1.0 より前のバージョンです。マイナーバージョン間で API が変わることがあります。対応バージョン: `@strands-agents/sdk` >= 1.18 < 2、`@aws/durable-execution-sdk-js` >= 2.4 < 3、Node.js 22 以上。

## インストール

```bash
npm install strands-lambda-durable @strands-agents/sdk @aws/durable-execution-sdk-js zod
# 大きなチェックポイントを S3 に退避する場合
npm install @aws-sdk/client-s3
```

npm への公開が完了するまでは、[GitHub リリース](https://github.com/har1101/strands-lambda-durable/releases)の tarball からインストールしてください。

```bash
npm install https://github.com/har1101/strands-lambda-durable/releases/download/v0.1.1/strands-lambda-durable-0.1.1.tgz
```

## クイックスタート

```ts
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  DurableModel, DurableTool, DurableToolExecutor, currentToolExecution, invokeDurably,
} from "strands-lambda-durable";

export const handler = withDurableExecution(async (event: { prompt: string }, context) => {
  // エージェントは呼び出しごとに作り直します。進捗を保持するのはメモリではなく durable ジャーナルです。
  const refund = tool({
    name: "issue_refund",
    description: "Refund an order. A human must approve.",
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    callback: async ({ orderId, amount }, toolContext) => {
      const decision = toolContext!.interrupt({ name: "approval", reason: { orderId, amount } });
      if (!(decision as { approved?: boolean })?.approved) return { status: "rejected" };
      // リトライ、リプレイ、割り込み後の再開のどれでも同じ値です。決済 API に渡します。
      const { idempotencyKey } = currentToolExecution();
      return await payments.refund({ orderId, amount, idempotencyKey });
    },
  });

  const agent = new Agent({
    model: new DurableModel(new BedrockModel({ modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }), context),
    tools: [new DurableTool(refund, context)],
    toolExecutor: new DurableToolExecutor(context),
    retryStrategy: null, // リトライは durable step 側で行います
  });

  const result = await invokeDurably(agent, context, event.prompt, {
    // コールバック ID を承認者に送ります。承認を待つ間、Lambda の呼び出しは終了します。
    onInterrupt: async ({ callbackId, interrupt }) => notifyApprover(callbackId, interrupt),
    interruptTimeout: { hours: 24 },
  });
  return result.toString();
});
```

承認者は `aws lambda send-durable-execution-callback-success --callback-id ... --result '{"approved":true}'`（または SDK）で回答します。新しい呼び出しがジャーナルをリプレイし、同じツール実行をその回答で再開します。

## API

| エクスポート | 内容 |
| --- | --- |
| `DurableModel(source, context, options?)` | モデルへのリクエスト 1 回を 1 ステップ（`model-<n>`）にします。イベントストリーム全体を記録し、リプレイ時はプロバイダーを呼ばずに再生します。オプション: `events`（ライブの `model_start`/`text` イベント。テキストは `textFlushMs` ごとにまとめて送ります。既定値は 100 ms）、`retryStrategy`（既定値は `modelRetryStrategy`。スロットリング、5xx、タイムアウトを最大 4 回まで試行します。バリデーションエラーはすぐに失敗します）、`serdes`。ステートフルなプロバイダーの `modelState` を復元します。 |
| `DurableTool(source, context, options?)` | ツールの実行 1 回を 1 ステップにします。ツールが投げた例外は業務上の結果として扱い、モデル向けのエラー結果としてチェックポイントします。`RetryableToolError` を投げると、そのステップだけをリトライします（`toolRetryStrategy`、3 回）。リトライを使い切るとエラー結果になります。`agent.appState` の変更を復元します。オプション: `events`、`retryStrategy`、`serdes`。 |
| `DurableToolExecutor(context, options?)` | ツールを並列に実行しつつ、ジャーナルの順序を決定的に保ちます。ターン内のツールが動き出す前に、ツール実行ごとの子コンテキストを `toolUse` の順に開きます（`tools-<turn>-<index>`）。各 durable ツールは自分の子コンテキストで動きます。ツールの開始順や完了順が変わってもオペレーション ID は変わりません。使わない場合は `toolExecutor: "sequential"` を指定してください。`DurableTool` のステップが重なると拒否されます。 |
| `invokeDurably(agent, context, input, options)` | Strands の割り込み（ツールの `interrupt()`、フックの割り込み）をすべて `context.waitForCallback` に変換する `agent.invoke` です。コールバックの JSON 結果が割り込みへの応答になります。`onInterrupt` は durable step として実行されます。 |
| `durableWorkflowTool(context, config)` | 本体を子コンテキストで実行するツールです。待機、コールバック、invoke、または子コンテキスト上の `DurableModel` で作ったサブエージェントなど、任意の durable オペレーションを使えます。 |
| `durableMcpTools(context, mcpClient, { id })` | MCP サーバーのツール一覧を実行ごとに 1 回だけ取得し（`mcp-tools-<id>` ステップ）、`DurableTool` でラップします。同じ実行の後続の呼び出しは記録済みの一覧を使います。新しい実行では最新の一覧を取得します。 |
| `createOffloadSerdes({ store, thresholdBytes?, prefix? })` | しきい値（既定値 64 KiB）を超えるチェックポイントのペイロードを `OffloadStore` に保存し、ジャーナルにはポインターだけを残す JSON serdes です。モデル、ツール、エグゼキューターの `serdes` に渡します。 |
| `s3OffloadStore({ client, bucket, prefix? })`（`strands-lambda-durable/s3` から） | Amazon S3 を使う `OffloadStore` です。バケットには、durable の保持期間より長いライフサイクルルールを設定してください。 |
| `currentToolExecution()` | durable ツールの中で `{ idempotencyKey, attempt }` を返します。キーは `<実行 ARN>#<toolUseId>` です。 |
| `modelRetryStrategy`、`toolRetryStrategy`、`RetryableToolError` | 既定のリトライポリシーと、リトライを要求するためのエラーです。 |
| `EventSink`、`DurableLiveEvent` | 暫定のライブイベントを受け取ります。`model_start` の `attempt` が新しくなったら、その呼び出しで以前に送ったテキストは置き換えます。 |

## 保証と制約

- **リプレイされるもの。** 完了したモデル呼び出しとツール実行は、再実行せずにジャーナルからリプレイします。エラー結果、割り込み、`appState` の変更、`modelState` も含みます。バイナリ（`Uint8Array`）もそのまま保持します。各ツール実行は、自分が設定または削除した `appState` のキーだけを記録します。このため、並列に動くツールが互いの変更を上書きすることはありません。並列のツールが同じキーに書き込んだ場合、最終的な値は完了順に依存します。キーは分けてください。恒久的に失敗したツール実行と、割り込みを発生させたツール実行の `appState` の変更は残りません。チェックポイントにはバージョンがあります。現在は `schemaVersion` 3 で、バージョン 1 と 2 も読み込めます。
- **exactly-once ではありません。** 副作用の後、チェックポイントの前にプロセスが止まると、そのステップは再実行されることがあります。`idempotencyKey` で重複を排除できる API に渡してください。
- **決定性は利用者の責任です。** エージェントは毎回同じ方法で組み立ててください。durable でない処理（I/O を伴うフック、時計、乱数）を判断に使わないでください。使う場合は durable ツールに移してください。ラップしていないツールはリプレイのたびに再実行されます。
- **ライブイベントは暫定です。** ライブイベントは実行中のステップの副作用です。リトライでは新しい `attempt` のイベントが送られます。正しい状態はジャーナル（またはステップ内で書き込む独自のストア）で判断してください。
- **クォータ。** Lambda では、1 つの実行あたり 3,000 オペレーションと 100 MB のチェックポイントデータが上限です。大きなツール結果には `createOffloadSerdes` を使ってください。非常に長い会話は複数の実行に分けてください。たとえばユーザーのメッセージごとに 1 実行とし、履歴は独自のストアに保存します。
- **バージョン。** 公開済みのバージョンまたはエイリアスを呼び出してください。実行中の処理が、ジャーナルと一致するコードを使い続けられます。

## サンプル

[strands-lambda-durable-ts](https://github.com/har1101/strands-lambda-durable-ts) は、このパッケージを使ったデプロイ可能なチャットアプリです（AWS SAM、Cognito、CloudFront、AppSync Events）。並列ツール、durable コールバックによる承認、ライブストリーミング、会話履歴の例を示しています。

## エージェントのテスト

durable SDK の `LocalDurableTestRunner` を使うと、ハンドラーをローカルで実行できます。サスペンド、コールバック、リトライにも対応しています。プロバイダーに依存しないスクリプト化したモデルと、カバーしているシナリオ（リプレイ、リトライ、割り込み、並列ツール、MCP、オフロード、`modelState`）は、このリポジトリの `test/` ディレクトリを参照してください。呼び出しの終了を前提とするテストでは、実時間のタイマー（`skipTime: false`）を使ってください。SDK はアイドル状態の呼び出しを 20 ms のクールダウン後に終了します。時間をスキップすると、短い待機がその前に終わってしまうことがあります。

## ライセンス

MIT。詳細は [LICENSE](./LICENSE) を参照してください。コントリビューションについては [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。
