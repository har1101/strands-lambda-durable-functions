# strands-lambda-durable-functions

[![CI](https://github.com/har1101/strands-lambda-durable-functions/actions/workflows/ci.yml/badge.svg)](https://github.com/har1101/strands-lambda-durable-functions/actions/workflows/ci.yml)

[English](./README.md) | 日本語

[Strands Agents](https://strandsagents.com)（TypeScript）の**非公式のコミュニティ製拡張機能**です。エージェントを [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) 上で動かせるようにします。モデルへのリクエストとツールの実行は、1 回ごとに独立した durable step になります。Lambda の呼び出しが途中で止まっても、次の呼び出しは完了済みのステップをジャーナルからリプレイし、モデルやツールを呼び直しません。

> **非公式です。** このプロジェクトは、Strands Agents プロジェクトや Amazon Web Services とは提携しておらず、承認やサポートも受けていません。Strands のフォークではなく追加モジュールなので、`@strands-agents/sdk` とそのエージェントループはそのまま使います。このパッケージは、Strands の公開拡張ポイントである `Model` と `Tool` をラップし、ツールエグゼキューターを 1 つ追加します。Strands と durable execution SDK は peer dependency です。

> ステータス: 1.0 より前のバージョンです。マイナーバージョン間で API が変わることがあります。対応バージョン: `@strands-agents/sdk` >= 1.18 < 2、`@aws/durable-execution-sdk-js` >= 2.4 < 3、Node.js 22 以上。

## インストール

```bash
npm install strands-lambda-durable-functions @strands-agents/sdk @aws/durable-execution-sdk-js zod
# 大きなチェックポイントを S3 に退避する場合
npm install @aws-sdk/client-s3
```

npm への公開が完了するまでは、[GitHub リリース](https://github.com/har1101/strands-lambda-durable-functions/releases)の tarball からインストールしてください。0.2.0 より後のリリースには `SHA256SUMS` と GitHub のビルド来歴証明（attestation）が付きます。インストールする前に tarball を検証してください。

```bash
curl -fLO https://github.com/har1101/strands-lambda-durable-functions/releases/download/v<version>/strands-lambda-durable-functions-<version>.tgz
gh attestation verify strands-lambda-durable-functions-<version>.tgz --repo har1101/strands-lambda-durable-functions
npm install ./strands-lambda-durable-functions-<version>.tgz
```

## クイックスタート

```ts
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  DurableModel, DurableTool, DurableToolExecutor, currentToolExecution, invokeDurably,
} from "strands-lambda-durable-functions";

export const handler = withDurableExecution(async (event: { prompt: string }, context) => {
  // エージェントは呼び出しごとに作り直します。進捗を保持するのはメモリではなく durable ジャーナルです。
  const refund = tool({
    name: "issue_refund",
    description: "Refund an order. A human must approve.",
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    callback: async ({ orderId, amount }, toolContext) => {
      const decision = toolContext!.interrupt({ name: "approval", reason: { orderId, amount } });
      // 明示的な承認だけを受け付けます。"false" や "yes"、フィールドの欠落はすべて却下になります。
      if (!z.object({ approved: z.literal(true) }).safeParse(decision).success) return { status: "rejected" };
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
    // コールバック ID は承認用のバックエンドに送り、依頼したユーザーには渡しません。承認を待つ間、Lambda の呼び出しは終了します。
    onInterrupt: async ({ callbackId, interrupt }) => notifyApprover(callbackId, interrupt),
    interruptTimeout: { hours: 24 },
  });
  return result.toString();
});
```

承認用のバックエンドは `aws lambda send-durable-execution-callback-success --callback-id ... --result '{"approved":true}'`（または SDK）で回答します。新しい呼び出しがジャーナルをリプレイし、同じツール実行をその回答で再開します。コールバック ID を知っていて `lambda:SendDurableExecutionCallbackSuccess` を呼べる主体なら誰でも回答できます。[セキュリティ](#セキュリティ)を参照してください。

## API

| エクスポート | 内容 |
| --- | --- |
| `DurableModel(source, context, options?)` | モデルへのリクエスト 1 回を 1 ステップ（`model-<n>`）にします。イベントストリーム全体を記録し、リプレイ時はプロバイダーを呼ばずに再生します。オプション: `events`（ライブの `model_start`/`text` イベント。テキストは `textFlushMs` ごとにまとめて送ります。既定値は 100 ms）、`retryStrategy`（既定値は `modelRetryStrategy`。スロットリング、5xx、タイムアウトを最大 4 回まで試行します。バリデーションエラーはすぐに失敗します）、`serdes`。ステートフルなプロバイダーの `modelState` を復元します。 |
| `DurableTool(source, context, options?)` | ツールの実行 1 回を 1 ステップにします。ツールが投げた例外は業務上の結果として扱い、モデル向けのエラー結果としてチェックポイントします。`RetryableToolError` を投げると、そのステップだけをリトライします（`toolRetryStrategy`、3 回）。リトライを使い切るとエラー結果になります。`agent.appState` の変更を復元します。オプション: `events`、`eventDetails`（`tool` イベントにツールの出力を含めます。既定値は `false`）、`retryStrategy`、`serdes`。 |
| `DurableToolExecutor(context, options?)` | ツールを並列に実行しつつ、ジャーナルの順序を決定的に保ちます。ターン内のツールが動き出す前に、ツール実行ごとの子コンテキストを `toolUse` の順に開きます（`tools-<turn>-<index>`）。各 durable ツールは自分の子コンテキストで動きます。ツールの開始順や完了順が変わってもオペレーション ID は変わりません。使わない場合は `toolExecutor: "sequential"` を指定してください。`DurableTool` のステップが重なると拒否されます。 |
| `invokeDurably(agent, context, input, options)` | Strands の割り込み（ツールの `interrupt()`、フックの割り込み）をすべて `context.waitForCallback` に変換する `agent.invoke` です。コールバックの JSON 結果が割り込みへの応答になります。`onInterrupt` は durable step として実行されます。 |
| `durableWorkflowTool(context, config)` | 本体を子コンテキストで実行するツールです。待機、コールバック、invoke、または子コンテキスト上の `DurableModel` で作ったサブエージェントなど、任意の durable オペレーションを使えます。 |
| `durableMcpTools(context, mcpClient, { id, filter? })` | MCP サーバーのツール一覧を実行ごとに 1 回だけ取得し（`mcp-tools-<id>` ステップ）、`DurableTool` でラップします。同じ実行の後続の呼び出しは記録済みの一覧を使います。新しい実行では最新の一覧を取得します。`filter` でエージェントに見せるツールを絞り込めます。記録後にサーバー側で入力スキーマが変わったツールは呼ばず、モデルにはエラー結果を返します。 |
| `createOffloadSerdes({ store, thresholdBytes?, prefix? })` | しきい値（既定値 64 KiB）を超えるチェックポイントのペイロードを `OffloadStore` に保存し、ジャーナルにはペイロードの SHA-256 ダイジェスト付きのポインターだけを残す JSON serdes です。ポインターは、そのオペレーション自身が書き込んだオブジェクトしか指せません。オブジェクトが変更されていればリプレイは失敗します。モデル、ツール、エグゼキューターの `serdes` に渡します。 |
| `s3OffloadStore({ client, bucket, prefix?, expectedBucketOwner?, serverSideEncryption?, sseKmsKeyId?, maxBytes? })`（`strands-lambda-durable-functions/s3` から） | Amazon S3 を使う `OffloadStore` です。`expectedBucketOwner` でバケットの所有アカウントを固定し、`serverSideEncryption`/`sseKmsKeyId` で SSE-KMS を指定します。`maxBytes`（既定値 64 MiB）は、書き込み・読み込みするチェックポイント 1 件の上限です。バケットには、durable の保持期間より長いライフサイクルルールを設定してください。 |
| `currentToolExecution()` | durable ツールの中で `{ idempotencyKey, attempt }` を返します。キーは SHA-256 の 16 進ダイジェストです。リトライ、リプレイ、割り込み後の再開のどれでも同じ値になり、プロバイダーが `toolUseId` を使い回してもツール実行ごとに異なります。実行 ARN は含みません。 |
| `modelRetryStrategy`、`toolRetryStrategy`、`RetryableToolError` | 既定のリトライポリシーと、リトライを要求するためのエラーです。 |
| `EventSink`、`DurableLiveEvent` | 暫定のライブイベントを受け取ります。`model_start` の `attempt` が新しくなったら、その呼び出しで以前に送ったテキストは置き換えます。 |

## 保証と制約

- **リプレイされるもの。** 完了したモデル呼び出しとツール実行は、再実行せずにジャーナルからリプレイします。エラー結果、割り込み、`appState` の変更、`modelState` も含みます。バイナリ（`Uint8Array`）もそのまま保持します。各ツール実行は、自分が設定または削除した `appState` のキーだけを記録します。このため、並列に動くツールが互いの変更を上書きすることはありません。並列のツールが同じキーに書き込んだ場合、最終的な値は完了順に依存します。キーは分けてください。恒久的に失敗したツール実行と、割り込みを発生させたツール実行の `appState` の変更は残りません。チェックポイントにはバージョンがあります。現在は `schemaVersion` 4 で、バージョン 1 から 3 も読み込めます。
- **ツール実行 ID。** 1 つのモデル応答に含まれるツール実行の `toolUseId` は、互いに異なる必要があります。同じ ID を繰り返す応答が来ると、実行は失敗します。Strands とジャーナルは、結果や割り込みへの回答を ID で対応付けているためです。応答をまたいで ID を使い回すプロバイダーは問題ありません。使うたびに別の冪等キーになります。
- **exactly-once ではありません。** 副作用の後、チェックポイントの前にプロセスが止まると、そのステップは再実行されることがあります。`idempotencyKey` で重複を排除できる API に渡してください。
- **決定性は利用者の責任です。** エージェントは毎回同じ方法で組み立ててください。durable でない処理（I/O を伴うフック、時計、乱数）を判断に使わないでください。使う場合は durable ツールに移してください。ラップしていないツールはリプレイのたびに再実行されます。
- **ライブイベントは暫定です。** ライブイベントは実行中のステップの副作用です。リトライでは新しい `attempt` のイベントが送られます。正しい状態はジャーナル（またはステップ内で書き込む独自のストア）で判断してください。
- **クォータ。** Lambda では、1 つの実行あたり 3,000 オペレーションと 100 MB のチェックポイントデータが上限です。大きなツール結果には `createOffloadSerdes` を使ってください。非常に長い会話は複数の実行に分けてください。たとえばユーザーのメッセージごとに 1 実行とし、履歴は独自のストアに保存します。
- **バージョン。** 公開済みのバージョンまたはエイリアスを呼び出してください。実行中の処理が、ジャーナルと一致するコードを使い続けられます。

## セキュリティ

- **承認。** コールバック ID があれば、その関数に対して `lambda:SendDurableExecutionCallbackSuccess` を呼べる主体なら誰でも割り込みに回答できます。誰が回答したかをライブラリは把握しません。コールバック ID は承認用のバックエンドにだけ送り、操作を依頼したユーザーには渡さず、ログにも出さないでください。バックエンドは承認者を認証し、その人がこの割り込みを承認してよいかを確認してから（コールバック ID を割り込みと承認可能な人に結び付けて保存します）、自分で回答を送ります。回答はクイックスタートのようにツールの中で検証し、`interruptTimeout` を設定してください。承認者に見せる `reason` の値は、モデルが決めたツール入力から来ます。データとして表示し、ツールが実際に行う内容をそのまま表すようにしてください。
- **ジャーナルに残るもの。** チェックポイントには、モデルの出力（テキスト、推論、ツール呼び出しの引数）、`modelState`、ツールの結果、ツールのエラーメッセージ、`appState` の変更、割り込みの理由が、実行の保持期間中そのまま JSON で残ります。大きなものはオフロード先のストアに入ります。`lambda:GetDurableExecution*` とオフロード先バケットの読み取り権限は、これらのデータを見てよい主体にだけ付与してください。`appState`、ツールの結果、例外メッセージには秘密情報を入れないでください。ツールのエラーはモデルに見せられ、保存されます。
- **オフロード。** 専用のバケットかプレフィックスを使い、`s3:PutObject` は関数のロールにだけ許可してください。ジャーナルにはオフロードしたオブジェクトごとのキーとダイジェストが残るため、改ざんされたオブジェクトや別のオペレーションのオブジェクトがエージェントに渡ることはありません。それを読んだ呼び出しは失敗します。durable SDK はこれを他の serdes の失敗と同じく扱い、呼び出しをリトライします。このため、停止する（`aws lambda stop-durable-execution`）かタイムアウトするまで、その実行は先に進みません。`expectedBucketOwner` を設定し、KMS のキーポリシーで守る必要があるデータなら `serverSideEncryption: "aws:kms"` も指定してください。
- **ライブイベント。** `text` イベントはモデルの回答をストリーミングします。`tool` イベントは、`eventDetails: true` を指定しない限り、ツール名、`toolUseId`、ステータスだけを運びます。シンクを読む全員がツールの返す内容をすべて見てよい場合にだけ指定してください。
- **MCP。** MCP サーバーのツールの説明はプロンプトに入り、そのツールはサーバーが到達できる範囲で動きます。信頼できるサーバーだけに接続し、`filter` で必要なツールだけを見せてください。

脆弱性の報告については [SECURITY.md](./SECURITY.md) を参照してください。

## サンプル

[strands-lambda-durable-ts](https://github.com/har1101/strands-lambda-durable-ts) は、このパッケージを使ったデプロイ可能なチャットアプリです（AWS SAM、Cognito、CloudFront、AppSync Events）。並列ツール、durable コールバックによる承認、ライブストリーミング、会話履歴の例を示しています。

## エージェントのテスト

durable SDK の `LocalDurableTestRunner` を使うと、ハンドラーをローカルで実行できます。サスペンド、コールバック、リトライにも対応しています。プロバイダーに依存しないスクリプト化したモデルと、カバーしているシナリオ（リプレイ、リトライ、割り込み、並列ツール、MCP、オフロード、`modelState`）は、このリポジトリの `test/` ディレクトリを参照してください。呼び出しの終了を前提とするテストでは、実時間のタイマー（`skipTime: false`）を使ってください。SDK はアイドル状態の呼び出しを 20 ms のクールダウン後に終了します。時間をスキップすると、短い待機がその前に終わってしまうことがあります。

## ライセンス

MIT。詳細は [LICENSE](./LICENSE) を参照してください。コントリビューションについては [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。
