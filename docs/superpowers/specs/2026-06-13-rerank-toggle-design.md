# 設計書: リランクのデプロイ時 ON/OFF 切り替え(RAG 精度向上)

- 作成日: 2026-06-13
- ステータス: 承認待ち
- リージョン: ap-northeast-1(東京)

## 1. 目的とスコープ

Slack bot の RAG 回答精度を上げるため、Knowledge Base 検索に **リランク(再ランキング)** を
組み込む。リランクはコスト(月数ドル〜十数ドル規模)と提供リージョンの都合があるため、
**デプロイ時に `-c rerank=true/false` で有効・無効を切り替えられる**ようにする。

あわせて、これまで未指定(=デフォルト5件)だった検索取得件数を明示し、文脈量を増やす。

### 検討の経緯(前提となる意思決定)

- 改善候補のうち、再取り込み不要で効果が大きい「① 取得件数の明示増」+「② リランク追加」を
  先行して実施する。チャンク見直し・エクスポート形式変更・生成モデル変更などは独立した
  後続作業とする(①② とはレイヤーが異なり手戻りなし)。
- リランクモデルは ap-northeast-1 で提供確認済み。**Cohere Rerank 3.5
  (`cohere.rerank-v3-5:0`)** を採用する。多言語性能が高く日本語ドキュメントに強い。
  東京リージョン内で完結するためクロスリージョン推論(CRIS)は不要。
- コスト感: リランクは 1 検索クエリ単位の課金(最大100ドキュメント/クエリ)。
  Slack の1質問 = 1クエリに収まり、Cohere Rerank 3.5 は $2.00/1,000クエリ
  (1質問あたり $0.002)。社内利用規模で月数ドル〜十数ドル。

### 今回のスコープ(作るもの)

- `-c rerank`(デフォルト `true`)による ON/OFF 切り替え
- リランク有効時の「多めに取得 → 上位に絞る」検索設定、無効時の取得件数明示
- リランク利用に必要な IAM 権限(呼び出し側 Lambda + KB サービスロールの両系統)
- 検索設定を組み立てる純ロジックの単体テスト
- モデルアクセス前提のドキュメント追記

### スコープ外(将来の別作業)

- チャンク設定の見直し(`FIXED_SIZE` 300 → 512 / HIERARCHICAL)。再取り込みが必要。
- Google Docs のエクスポート形式変更(PDF → text/plain)。再取り込みが必要。
- 生成モデルの変更(Haiku 4.5 → Sonnet)。
- リランクモデルの選択(Cohere / Amazon)や件数の `-c` 可変化。今回はコード定数に固定。
- ハイブリッド検索(S3 Vectors は非対応。必要時は OpenSearch Serverless への移行)。

## 2. 設計判断

### 2.1 切り替えスコープ: ON/OFF のみ

`-c rerank=true/false` の真偽値のみをデプロイ時パラメータにする。リランクモデル・取得件数・
リランク後件数はコード定数に固定する(YAGNI)。後から `-c` 可変化が必要になれば容易に拡張できる。

### 2.2 デフォルト: ON

`-c rerank` を省略した場合はリランク有効。コストは軽微で精度向上が大きく「良い状態がデフォルト」。
無効化したい場合は明示的に `-c rerank=false` を付ける。

### 2.3 検索件数(チャンクが 300 トークンと小さい点を考慮)

| | 取得件数(`numberOfResults`) | 生成へ渡す件数 | 選別品質 |
| --- | --- | --- | --- |
| ON | 20 | リランク上位 8(`numberOfRerankedResults`) | 20件から精度順に最良8件 |
| OFF | 8 | 8(素のベクトル類似度順) | フィルタなし |

- どちらも生成へ渡す文脈量を約8チャンク(≒2,400トークン)に揃える。ON は「同じ文脈量で
  選別品質が上がる」構成。
- チャンクが 300 トークンと小さいため、リランク後を5件に絞ると単一事実の回答には十分だが
  複数ドキュメントにまたがる質問で文脈が薄くなりやすい。8件で小チャンクを補う。
- `RERANK_TOP_N` 等は1行定数のため、運用後に実回答を見て調整可能。

### 2.4 IAM: 2系統の権限が必要(コアスタックにも最小限触れる)

RetrieveAndGenerate のリランクは KB サービスが実行するため、権限は2系統必要:

1. **呼び出し側(Slack worker Lambda)**:
   `bedrock:RetrieveAndGenerate`(既存)+ `bedrock:Rerank` + `bedrock:InvokeModel`(リランクモデル限定)
2. **KB サービスロール(`kbRole`、コアの `knowledge-base-stack.ts`)**:
   `bedrock:Rerank` + `bedrock:InvokeModel`(リランクモデル限定)

このため「Slack bot 側に閉じる」ことはできず、コアの `kbRole` にも権限付与が要る。

**採用案(A): コアの `kbRole` にはリランクモデル限定で無条件付与する。**

- フラグ(`-c rerank`)はコアスタックに渡さず、`bin/app.ts` / `SlackBotStack` 内に閉じる。
- 付与する権限はリランクモデル1つの ARN に限定され、誰も使わなければ no-op。
- 棄却案(B: フラグをコアにも渡し条件付与)は、コア(常時デプロイ)が一消費者のフラグに
  密結合し、「コアは false / bot は true」でデプロイした際に実行時 AccessDenied になる
  footgun を生む。二層構成(コア常時 + 消費者選択)の思想と A が整合する。
- 呼び出し側 Lambda の IAM は `SlackBotStack` 内で `rerankEnabled` により**条件付与**する。

## 3. 変更点

### 3.1 `lib/config.ts`(定数追加)

```ts
// リランクモデル(Cohere Rerank 3.5。東京リージョン内で完結=CRIS不要)
export const RERANK_MODEL_ID = 'cohere.rerank-v3-5:0';
// 検索取得件数: リランク無効時は素のベクトル順をそのまま生成へ渡す
export const RETRIEVAL_RESULTS = 8;
// リランク有効時: 多めに取得してリランクで上位に絞る
export const RERANK_FETCH_RESULTS = 20;
export const RERANK_TOP_N = 8;
```

### 3.2 `bin/app.ts`(フラグ読み取り)

`scheduleEnabled` と同じ書き方で `-c rerank`(デフォルト `true`)を読み取り、
`SlackBotStack` の props に渡す。

```ts
const rerankEnabled = String(app.node.tryGetContext('rerank') ?? 'true') === 'true';
```

### 3.3 `lib/knowledge-base-stack.ts`(コア `kbRole` へ無条件付与)

`kbRole` にリランクモデル限定の権限を追加する。

```ts
kbRole.addToPolicy(new iam.PolicyStatement({
  actions: ['bedrock:Rerank', 'bedrock:InvokeModel'],
  resources: [`arn:aws:bedrock:${REGION}::foundation-model/${RERANK_MODEL_ID}`],
}));
```

### 3.4 `lib/slack-bot-stack.ts`(props + 環境変数 + 条件付き IAM)

- `SlackBotStackProps` に `rerankEnabled: boolean` を追加。
- `workerFn` の環境変数に `RERANK_ENABLED`(`'true'`/`'false'`)を渡す。
- `rerankEnabled` が true のときだけ呼び出し側の IAM を付与:
  ```ts
  workerFn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock:Rerank', 'bedrock:InvokeModel'],
    resources: [`arn:aws:bedrock:${this.region}::foundation-model/${RERANK_MODEL_ID}`],
  }));
  ```

### 3.5 `lambda/slack-bot/worker.ts`(純ロジック分離 + 適用)

CLAUDE.md の「純ロジックと SDK 呼び出しを分離」に従い、フラグから検索設定
(`retrievalConfiguration`)を組み立てる純関数を切り出して単体テストする。

```ts
// rerankEnabled に応じて KB の検索設定を組み立てる(副作用なし=モック不要でテスト可能)
export function buildRetrievalConfiguration(rerankEnabled: boolean, region: string) {
  if (!rerankEnabled) {
    return { vectorSearchConfiguration: { numberOfResults: RETRIEVAL_RESULTS } };
  }
  return {
    vectorSearchConfiguration: {
      numberOfResults: RERANK_FETCH_RESULTS,
      rerankingConfiguration: {
        type: 'BEDROCK_RERANKING_MODEL',
        bedrockRerankingConfiguration: {
          numberOfRerankedResults: RERANK_TOP_N,
          modelConfiguration: {
            modelArn: `arn:aws:bedrock:${region}::foundation-model/${RERANK_MODEL_ID}`,
          },
        },
      },
    },
  };
}
```

- `queryKnowledgeBase` は `process.env.RERANK_ENABLED === 'true'` と `region` を渡して
  この純関数を呼び、結果を `knowledgeBaseConfiguration.retrievalConfiguration` に設定する。
- 実装時に AWS SDK(`@aws-sdk/client-bedrock-agent-runtime`)の型と
  `rerankingConfiguration` の正確なフィールド名・列挙値を `npx tsc --noEmit` で確認する。

### 3.6 `test/`(純ロジックのテスト)

`buildRetrievalConfiguration` の両分岐を日本語テスト名で検証:

- `test('リランク無効なら取得件数のみ設定しリランク設定を含めない', ...)`
- `test('リランク有効なら多めに取得しリランク上位件数を設定する', ...)`
- 既存の CDK assertion テストに、`rerankEnabled` による IAM ステートメントの
  有無(呼び出し側)とコア `kbRole` の権限を必要に応じて追加。

### 3.7 ドキュメント

- `docs/setup.md`(またはモデルアクセス手順の該当箇所)に、`rerank=true` でデプロイする場合は
  **Bedrock のモデルアクセスで Cohere Rerank 3.5 を有効化**しておく前提を追記
  (Titan / Haiku と同じ Marketplace サブスクリプション手順)。未有効だと実行時 AccessDenied。
- README / CLAUDE.md のコマンド例に `-c rerank=true/false`(任意・デフォルト true)を補足。

## 4. 検証

CLAUDE.md の必須検証を通す:

```bash
npm test          # 純ロジック + CDK assertion テスト
npx tsc --noEmit  # 型チェック(ts-jest は transpile-only のため型は別途担保)
```

加えて synth で IAM 差分を確認する:

```bash
npx cdk synth -c driveFolderId=<ID>                # デフォルト(rerank=true)
npx cdk synth -c driveFolderId=<ID> -c rerank=false # 無効時に呼び出し側 IAM が消えること
```

## 5. リスク・留意点

- **モデルアクセス未有効での AccessDenied**: `rerank=true` デプロイ前に Cohere Rerank 3.5 の
  モデルアクセス有効化が必須。ドキュメントで明示する。
- **SDK 型の差異**: `rerankingConfiguration` のフィールド名・列挙値は SDK バージョン依存。
  実装時に型チェックで確定する(spec のコードは設計意図を示すもの)。
- **コア `kbRole` の権限拡張**: リランクモデル1つに限定。実害は無いが、二層構成上コアに
  触れる点は認識しておく。
