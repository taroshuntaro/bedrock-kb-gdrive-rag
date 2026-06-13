# リランク ON/OFF 切り替え 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Knowledge Base 検索にリランク(Cohere Rerank 3.5)を組み込み、`-c rerank=true/false`(デフォルト true)でデプロイ時に有効・無効を切り替えられるようにする。

**Architecture:** リランクのフラグは `bin/app.ts` で `-c rerank` を読み、`SlackBotStack` の props 経由で worker Lambda に `RERANK_ENABLED` 環境変数として渡す。検索設定の組み立ては純関数 `buildRetrievalConfiguration` に切り出して単体テストする(CLAUDE.md「純ロジックと SDK 呼び出しの分離」)。リランクモデルの ARN は stack 側で組み立て、既存の `GENERATION_PROFILE_ARN` と同じく env(`RERANK_MODEL_ARN`)で渡す(lambda は `lib/` を import しない既存規約に合わせる)。IAM は呼び出し側(worker)を `rerankEnabled` で条件付与、KB サービスロール(コア `kbRole`)はリランクモデル限定で無条件付与する。

**Tech Stack:** AWS CDK (TypeScript), `@aws-sdk/client-bedrock-agent-runtime` v3, Jest (ts-jest transpile-only) + CDK assertions。

> **spec からの差分メモ:** spec 3.5 の `buildRetrievalConfiguration(rerankEnabled, region)` は、リポジトリの「stack が ARN を組み立て env で渡す」規約(`GENERATION_PROFILE_ARN` 前例)に合わせ `buildRetrievalConfiguration(rerankEnabled, rerankModelArn)` に変更する。件数定数は worker 専用のため `worker.ts` にローカル定義し、stack と共有する `RERANK_MODEL_ID` のみ `lib/config.ts` に置く。

---

## ファイル構成

| パス | 変更 | 責務 |
| --- | --- | --- |
| `lib/config.ts` | 修正 | `RERANK_MODEL_ID` を追加(stack の IAM ARN 組み立てに使用) |
| `lambda/slack-bot/worker.ts` | 修正 | 件数定数 + 純関数 `buildRetrievalConfiguration` + `queryKnowledgeBase` への適用 |
| `test/worker.test.ts` | 修正 | `buildRetrievalConfiguration` の ON/OFF 分岐テスト |
| `bin/app.ts` | 修正 | `-c rerank`(デフォルト true)読み取り、props へ伝播 |
| `lib/knowledge-base-stack.ts` | 修正 | コア `kbRole` にリランクモデル限定の権限を無条件付与 |
| `test/knowledge-base-stack.test.ts` | 修正 | `kbRole` のリランク権限テスト |
| `lib/slack-bot-stack.ts` | 修正 | `rerankEnabled` props + env(`RERANK_ENABLED`/`RERANK_MODEL_ARN`)+ 条件付き IAM |
| `test/slack-bot-stack.test.ts` | 修正 | `synth(rerankEnabled)` ヘルパ化 + ON/OFF の IAM・env テスト |
| `docs/setup.md` | 修正 | Cohere Rerank 3.5 モデルアクセス有効化の前提を追記 |
| `README.md` | 修正 | コマンド例に `-c rerank=true/false`(任意)を補足 |

---

## Task 1: `lib/config.ts` にリランクモデル ID を追加

**Files:**
- Modify: `lib/config.ts`

- [ ] **Step 1: 定数を追加**

`lib/config.ts` の末尾(生成モデル定義の下)に追記する:

```ts
// リランクモデル: Cohere Rerank 3.5。ap-northeast-1 内で完結するため CRIS 不要。
// stack の IAM ARN 組み立てに使う。日本語ドキュメントに強い多言語リランカー。
export const RERANK_MODEL_ID = 'cohere.rerank-v3-5:0';
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし(定数追加のみ)

- [ ] **Step 3: コミット**

```bash
git add lib/config.ts
git commit -m "feat: リランクモデル ID(Cohere Rerank 3.5)を共有定数に追加"
```

---

## Task 2: `buildRetrievalConfiguration` 純関数(TDD)

検索設定をフラグから組み立てる純関数。SDK を呼ばないためモック不要で単体テストできる。

**Files:**
- Modify: `lambda/slack-bot/worker.ts`
- Test: `test/worker.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`test/worker.test.ts` の `import` 行を差し替え、テストを追記する:

```ts
import { PROMPT_TEMPLATE, buildRetrievalConfiguration } from '../lambda/slack-bot/worker';

describe('buildRetrievalConfiguration', () => {
  const arn = 'arn:aws:bedrock:ap-northeast-1::foundation-model/cohere.rerank-v3-5:0';

  test('リランク無効なら取得件数のみ設定しリランク設定を含めない', () => {
    const cfg = buildRetrievalConfiguration(false, arn);
    expect(cfg.vectorSearchConfiguration?.numberOfResults).toBe(8);
    expect(cfg.vectorSearchConfiguration?.rerankingConfiguration).toBeUndefined();
  });

  test('リランク有効なら多めに取得しリランク上位件数とモデル ARN を設定する', () => {
    const cfg = buildRetrievalConfiguration(true, arn);
    expect(cfg.vectorSearchConfiguration?.numberOfResults).toBe(20);
    const rc = cfg.vectorSearchConfiguration?.rerankingConfiguration;
    expect(rc?.type).toBe('BEDROCK_RERANKING_MODEL');
    expect(rc?.bedrockRerankingConfiguration?.numberOfRerankedResults).toBe(8);
    expect(rc?.bedrockRerankingConfiguration?.modelConfiguration?.modelArn).toBe(arn);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/worker.test.ts`
Expected: FAIL(`buildRetrievalConfiguration` is not exported / not a function)

- [ ] **Step 3: 最小実装を書く**

`lambda/slack-bot/worker.ts` の `import` に型を追加する。先頭付近の import 群に追記:

```ts
import type { KnowledgeBaseRetrievalConfiguration } from '@aws-sdk/client-bedrock-agent-runtime';
```

`PROMPT_TEMPLATE` 定義の下に、件数定数と純関数を追加する:

```ts
// 検索取得件数(チャンクが 300 トークンと小さいため文脈量を確保する)
// リランク無効時: 素のベクトル類似度順をそのまま生成へ渡す
const RETRIEVAL_RESULTS = 8;
// リランク有効時: 多めに取得(RERANK_FETCH_RESULTS)→ リランクで上位(RERANK_TOP_N)に絞る
const RERANK_FETCH_RESULTS = 20;
const RERANK_TOP_N = 8;

// rerankEnabled に応じて KB の検索設定を組み立てる純関数(副作用なし=モック不要でテスト可能)。
// 無効時は取得件数のみ、有効時は多めに取得して Cohere リランカーで上位に絞る設定を返す。
export function buildRetrievalConfiguration(
  rerankEnabled: boolean,
  rerankModelArn: string,
): KnowledgeBaseRetrievalConfiguration {
  // 無効時: 取得件数のみ指定(リランク設定は付けない)
  if (!rerankEnabled) {
    return { vectorSearchConfiguration: { numberOfResults: RETRIEVAL_RESULTS } };
  }
  // 有効時: 多めに取得 → Cohere Rerank で numberOfRerankedResults 件に絞る
  return {
    vectorSearchConfiguration: {
      numberOfResults: RERANK_FETCH_RESULTS,
      rerankingConfiguration: {
        type: 'BEDROCK_RERANKING_MODEL',
        bedrockRerankingConfiguration: {
          numberOfRerankedResults: RERANK_TOP_N,
          modelConfiguration: { modelArn: rerankModelArn },
        },
      },
    },
  };
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/worker.test.ts`
Expected: PASS(4 テスト全て)

- [ ] **Step 5: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし(`type: 'BEDROCK_RERANKING_MODEL'` が enum と一致)

- [ ] **Step 6: コミット**

```bash
git add lambda/slack-bot/worker.ts test/worker.test.ts
git commit -m "feat: 検索設定を組み立てる純関数 buildRetrievalConfiguration を追加"
```

---

## Task 3: `queryKnowledgeBase` にリランク設定を適用

純関数を実際の `RetrieveAndGenerate` 呼び出しに組み込む。

**Files:**
- Modify: `lambda/slack-bot/worker.ts`

- [ ] **Step 1: `queryKnowledgeBase` を修正**

`lambda/slack-bot/worker.ts` の `queryKnowledgeBase` 内、`knowledgeBaseConfiguration` に `retrievalConfiguration` を追加する。現状:

```ts
      knowledgeBaseConfiguration: {
        knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID!,
        modelArn: process.env.GENERATION_PROFILE_ARN!,
        generationConfiguration: {
          promptTemplate: { textPromptTemplate: PROMPT_TEMPLATE },
        },
      },
```

を次に置き換える:

```ts
      knowledgeBaseConfiguration: {
        knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID!,
        modelArn: process.env.GENERATION_PROFILE_ARN!,
        // リランクの有無は環境変数で切り替え(デプロイ時 -c rerank=true/false 由来)
        retrievalConfiguration: buildRetrievalConfiguration(
          process.env.RERANK_ENABLED === 'true',
          process.env.RERANK_MODEL_ARN ?? '',
        ),
        generationConfiguration: {
          promptTemplate: { textPromptTemplate: PROMPT_TEMPLATE },
        },
      },
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: 既存テストが通ることを確認**

Run: `npx jest test/worker.test.ts`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add lambda/slack-bot/worker.ts
git commit -m "feat: KB 検索にリランク設定を適用(環境変数で ON/OFF)"
```

---

## Task 4: `bin/app.ts` でフラグを読み取り props へ伝播

**Files:**
- Modify: `bin/app.ts`

- [ ] **Step 1: フラグ読み取りを追加**

`bin/app.ts` の `scheduleEnabled` の定義行の直後に追記する:

```ts
// リランクの有効・無効(任意・デフォルト有効)。SlackBotStack の検索精度に影響する。
const rerankEnabled = String(app.node.tryGetContext('rerank') ?? 'true') === 'true';
```

- [ ] **Step 2: SlackBotStack の props に渡す**

`bin/app.ts` の `new SlackBotStack(...)` 呼び出しに `rerankEnabled` を追加する。現状:

```ts
new SlackBotStack(app, 'SlackBotStack', {
  env: { region: 'ap-northeast-1' },
  knowledgeBaseId: kbStack.knowledgeBase.attrKnowledgeBaseId,
  knowledgeBaseArn: kbStack.knowledgeBase.attrKnowledgeBaseArn,
});
```

を次に置き換える:

```ts
new SlackBotStack(app, 'SlackBotStack', {
  env: { region: 'ap-northeast-1' },
  knowledgeBaseId: kbStack.knowledgeBase.attrKnowledgeBaseId,
  knowledgeBaseArn: kbStack.knowledgeBase.attrKnowledgeBaseArn,
  rerankEnabled,
});
```

> 注: この時点では `SlackBotStackProps` に `rerankEnabled` が無いため `npx tsc --noEmit` は型エラーになる。Task 6 で props を追加して解消する。Task 5 を先に行うため、ここではコミットのみ行い型チェックは Task 6 でまとめて通す。

- [ ] **Step 3: コミット**

```bash
git add bin/app.ts
git commit -m "feat: -c rerank フラグを読み取り SlackBotStack へ伝播"
```

---

## Task 5: コア `kbRole` にリランク権限を無条件付与

RetrieveAndGenerate のリランクは KB サービスが実行するため、KB サービスロールにもリランクモデル限定の権限が要る。クロススタックのフラグ不整合を避けるため無条件付与する。

**Files:**
- Modify: `lib/knowledge-base-stack.ts`
- Test: `test/knowledge-base-stack.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`test/knowledge-base-stack.test.ts` に、`kbRole` のリランク権限を検証するテストを追加する(既存の `synth`/`Template` ヘルパに倣う。下記は単体で動く形):

```ts
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

test('KB サービスロールにリランクモデル限定の権限がある(RetrieveAndGenerate のリランク用)', () => {
  const app = new App();
  const stack = new KnowledgeBaseStack(app, 'TestKbRerank', {
    env: { region: 'ap-northeast-1' },
    driveFolderId: 'folder-123',
    scheduleRate: 'rate(1 day)',
    scheduleEnabled: true,
  });
  const t = Template.fromStack(stack);
  t.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: ['bedrock:Rerank', 'bedrock:InvokeModel'],
          Resource: 'arn:aws:bedrock:ap-northeast-1::foundation-model/cohere.rerank-v3-5:0',
        }),
      ]),
    }),
  }));
});
```

> 既存ファイルに `import` が重複する場合は既存の import 行を流用し、`test(...)` ブロックのみ追記する。

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t リランク`
Expected: FAIL(該当アクションの IAM ステートメントが無い)

- [ ] **Step 3: 実装を書く**

`lib/knowledge-base-stack.ts` の import に `RERANK_MODEL_ID` と `REGION` を追加する(既存の config import 群に追記):

```ts
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_ARN,
  VECTOR_DATA_TYPE,
  VECTOR_DISTANCE_METRIC,
  NON_FILTERABLE_METADATA_KEYS,
  NAME_PREFIX,
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_PERCENT,
  RERANK_MODEL_ID,
  REGION,
} from './config';
```

`kbRole` の `s3vectors:*` 付与の直後に、リランク権限を追加する:

```ts
    // RetrieveAndGenerate でリランクを使う場合、KB サービスロールにもリランクモデル
    // 呼び出し権限が要る。消費者(Slack bot 等)のフラグに依存させると不整合事故に
    // なるため、リランクモデル1つに限定して無条件付与する(未使用なら no-op)。
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:Rerank', 'bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${REGION}::foundation-model/${RERANK_MODEL_ID}`],
    }));
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx jest test/knowledge-base-stack.test.ts -t リランク`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lib/knowledge-base-stack.ts test/knowledge-base-stack.test.ts
git commit -m "feat: KB サービスロールにリランクモデル限定の権限を追加"
```

---

## Task 6: `SlackBotStack` に props・env・条件付き IAM を追加

**Files:**
- Modify: `lib/slack-bot-stack.ts`
- Test: `test/slack-bot-stack.test.ts`

- [ ] **Step 1: 失敗するテストを書く(ヘルパのフラグ化 + ON/OFF 検証)**

`test/slack-bot-stack.test.ts` の `synth()` ヘルパを `rerankEnabled` 引数付きに変更し、テストを追加する。

`synth` 関数を次に置き換える:

```ts
function synth(rerankEnabled = true) {
  const app = new App();
  // KB スタックの出力(KB ID / ARN)をクロススタック参照で受け取る実構成を再現する
  const kb = new KnowledgeBaseStack(app, 'TestKbStack', {
    env: { region: 'ap-northeast-1' },
    driveFolderId: 'folder-123',
    scheduleRate: 'rate(1 day)',
    scheduleEnabled: true,
  });
  const stack = new SlackBotStack(app, 'TestSlackBotStack', {
    env: { region: 'ap-northeast-1' },
    knowledgeBaseId: kb.knowledgeBase.attrKnowledgeBaseId,
    knowledgeBaseArn: kb.knowledgeBase.attrKnowledgeBaseArn,
    rerankEnabled,
  });
  return Template.fromStack(stack);
}
```

ファイル末尾に次のテストを追加する:

```ts
test('リランク有効時、応答 Lambda に RERANK_ENABLED=true とリランク IAM が付与される', () => {
  const t = synth(true);
  // 環境変数
  t.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Environment: Match.objectLike({
      Variables: Match.objectLike({ RERANK_ENABLED: 'true', RERANK_MODEL_ARN: Match.anyValue() }),
    }),
  }));
  // 呼び出し側 IAM(Rerank + InvokeModel)
  t.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: ['bedrock:Rerank', 'bedrock:InvokeModel'] }),
      ]),
    }),
  }));
});

test('リランク無効時、RERANK_ENABLED=false でリランク IAM は付与されない', () => {
  const t = synth(false);
  t.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Environment: Match.objectLike({
      Variables: Match.objectLike({ RERANK_ENABLED: 'false' }),
    }),
  }));
  // Rerank アクションを含む IAM ステートメントが存在しないこと
  const policies = t.findResources('AWS::IAM::Policy');
  const hasRerank = JSON.stringify(policies).includes('bedrock:Rerank');
  expect(hasRerank).toBe(false);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx jest test/slack-bot-stack.test.ts`
Expected: FAIL(`rerankEnabled` が props に無い / env・IAM が未設定)

- [ ] **Step 3: 実装を書く(props)**

`lib/slack-bot-stack.ts` の import に `RERANK_MODEL_ID` を追加:

```ts
import { NAME_PREFIX, GENERATION_PROFILE_ID, GENERATION_MODEL_ID, RERANK_MODEL_ID } from './config';
```

`SlackBotStackProps` に props を追加:

```ts
export interface SlackBotStackProps extends StackProps {
  readonly knowledgeBaseId: string;  // 検索対象の Knowledge Base ID
  readonly knowledgeBaseArn: string; // IAM 許可に使う KB の ARN
  readonly rerankEnabled: boolean;   // リランクの有効・無効(-c rerank 由来)
}
```

- [ ] **Step 4: 実装を書く(リランクモデル ARN + env + 条件付き IAM)**

`profileArn` 定義の直後にリランクモデル ARN を追加:

```ts
    // リランクモデル(Cohere Rerank 3.5)の ARN。東京リージョン内で完結。
    const rerankModelArn =
      `arn:aws:bedrock:${this.region}::foundation-model/${RERANK_MODEL_ID}`;
```

`workerFn` の `environment` にリランク用の 2 変数を追加(既存の 3 変数に続けて):

```ts
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        GENERATION_PROFILE_ARN: profileArn,
        SLACK_SECRET_ARN: slackSecret.secretArn,
        RERANK_ENABLED: String(props.rerankEnabled),
        RERANK_MODEL_ARN: rerankModelArn,
      },
```

`workerFn` への既存 IAM 付与(推論プロファイル許可のブロック)の直後に、リランク有効時のみの付与を追加:

```ts
    // リランク有効時のみ、呼び出し側にもリランクモデル呼び出し権限を付与する(最小権限)。
    if (props.rerankEnabled) {
      workerFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock:Rerank', 'bedrock:InvokeModel'],
        resources: [rerankModelArn],
      }));
    }
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npx jest test/slack-bot-stack.test.ts`
Expected: PASS(既存 + 新規テスト全て)

- [ ] **Step 6: 型チェック(Task 4 の app.ts 含めて解消)**

Run: `npx tsc --noEmit`
Expected: エラーなし(`rerankEnabled` props 追加で app.ts のエラーも解消)

- [ ] **Step 7: コミット**

```bash
git add lib/slack-bot-stack.ts test/slack-bot-stack.test.ts
git commit -m "feat: SlackBotStack にリランク props・環境変数・条件付き IAM を追加"
```

---

## Task 7: 全体検証

**Files:** なし(検証のみ)

- [ ] **Step 1: 全テスト**

Run: `npm test`
Expected: 全 suite PASS

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: synth で IAM 差分を確認(デフォルト=有効)**

Run: `npx cdk synth SlackBotStack -c driveFolderId=dummy-folder-id > /tmp/synth-rerank-on.txt 2>&1`
Expected: 成功。`RERANK_ENABLED` が `"true"`、`bedrock:Rerank` ステートメントが含まれる。

- [ ] **Step 4: synth で IAM 差分を確認(無効)**

Run: `npx cdk synth SlackBotStack -c driveFolderId=dummy-folder-id -c rerank=false > /tmp/synth-rerank-off.txt 2>&1`
Expected: 成功。`RERANK_ENABLED` が `"false"`、worker 側に `bedrock:Rerank` ステートメントが含まれない(コア `kbRole` 側のリランク権限は両方に存在する)。

---

## Task 8: ドキュメント追記

**Files:**
- Modify: `docs/setup.md`
- Modify: `README.md`

- [ ] **Step 1: `docs/setup.md` にモデルアクセス前提を追記**

モデルアクセス(Marketplace サブスクリプション)を扱っている箇所に、次の趣旨を追記する(既存の見出し・文体に合わせる):

```markdown
> リランクを有効(デフォルト)でデプロイする場合は、Bedrock のモデルアクセスで
> **Cohere Rerank 3.5** も有効化してください(Titan / Haiku と同じ Marketplace
> サブスクリプション手順)。未有効のまま `rerank=true` で運用すると、回答生成時に
> AccessDenied になります。リランクを使わない場合は `-c rerank=false` でデプロイします。
```

- [ ] **Step 2: `README.md` のコマンド例に補足**

`cdk deploy` のコマンド例付近に、任意フラグとして次を追記する:

```markdown
- `-c rerank=true|false`(任意・デフォルト `true`): Slack bot の検索にリランクを使うか。
  有効時は Cohere Rerank 3.5 のモデルアクセスが必要。
```

- [ ] **Step 3: コミット**

```bash
git add docs/setup.md README.md
git commit -m "docs: リランク有効化の前提(Cohere Rerank モデルアクセス)を追記"
```

---

## 完了の定義

- `npm test` と `npx tsc --noEmit` が両方通る(CLAUDE.md 必須検証)。
- `-c rerank` 省略時はリランク有効、`-c rerank=false` で無効になり、worker 側のリランク IAM が条件付きで増減する。
- コア `kbRole` にはリランクモデル限定の権限が常に付与される。
- リランクモデルアクセスの前提がドキュメント化されている。
