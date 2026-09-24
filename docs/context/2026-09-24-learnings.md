# 学び（2026-09-24）

## チェックポイントと入力の信頼境界

- オフロードのポインターを `{"$offload":"..."}` のような通常の JSON オブジェクトで表す場合、ツール結果やモデル由来の入力にも同じ形を作れる。デシリアライズ時に形だけでポインターと判断すると、ストアが読める別オブジェクトへ誘導される。小さいインライン値の予約形を `{"$inline":value}` で包み、ポインターをたどる際には実行 ARN と operation ID から導く正確なキーを検証する。S3 での読み取り権限が広いときほど影響が大きい。
- キーの所有検証は別実行への誘導を防ぐが、保存後の同じキーの書き換えは防がない。新しいポインターに本文の SHA-256 を持たせ、読んだ本文と照合する。旧形式のポインターの読み取りは互換性のため残るので、旧データの同等の改ざん検知は期待できない。
- `{"$bytes":"aGk="}` のようなツール結果は、文字列マーカーと偶然一致するだけで `Uint8Array` に化けてはならない。`schemaVersion` 4 はマーカーに見える JSON をエスケープし、復元を外側から行う。新形式を書きながら v1〜v3 を読み続けるため、デコードはスキーマ版を受け取る。
- `SerdesFailedError` は、実 AWS durable execution では失敗した呼び出しの再試行になり得る。改ざん検知が働くことと実行が直ちに最終 FAILED になることは別。検証時は実行履歴を見て、必要なら `aws lambda stop-durable-execution` で停止する。

## ツール実行の同一性と公開範囲

- `toolUseId` をツール呼び出しそのものの一意な識別子とみなしてはいけない。同一ターンで重複すれば結果の取り違えがあるため拒否し、別ターンでの再利用には turn/scope 内の出現回数を含めてキーを導く。実行 ARN を含む生の文字列を下流 API に渡さず、ハッシュ化したキーを使う。
- リプレイ時にツール名・toolUseId が一致することも確認する。MCP のツール一覧を記録していても、サーバー側の入力スキーマが変われば同じ呼び出しを実行してよいとは限らない。実行前に照合してエラー結果にする。
- ライブイベントはジャーナルではないが、ブラウザなど別の権限境界を越える。ツール結果・進捗・割り込み理由は機密情報を含み得るため、`eventDetails: true` の明示的な opt-in にした。`text` イベントは引き続きモデルの回答を含むため、シンク全体の閲覧権限も確認する。
- 人間の承認値は JavaScript の真偽値変換では判定しない。`"false"` も truthy。例では `z.literal(true)` だけを承認する。コールバック ID の秘匿、回答者の認証と承認対象の照合は利用側の責任。

## 配布パイプライン

- GitHub Actions の job-level `NPM_TOKEN` は、`npm ci` の dependency script からも読める。インストール時に `--ignore-scripts` を使い、テスト/pack と publish を別 job に分け、秘密情報は publish ステップの `env` にだけ渡す。`GITHUB_TOKEN` の権限も job 単位で絞る。
- Actions は SHA を固定して Dependabot で更新する。tarball の `SHA256SUMS` と GitHub build provenance attestation は、ダウンロード後の照合経路として Release に添付する。ただし設定未了の GitHub environment・npm trusted publisher や、無効な private vulnerability reporting をワークフローや `SECURITY.md` の記述だけで有効にすることはできない。
