# PaperLens frontend

要件定義をもとにした PaperLens の Qwik City フロントエンドです。PDF と論文メタデータを端末内へ保存する local-first 構成を前提にしています。

本番作業では、最初に [`DEPLOYMENT.md`](./DEPLOYMENT.md) の対象確認・検証・ロールバック手順をすべて確認してください。

## 開発

プロジェクトルートで direnv を有効にしたあと、`frontend` で実行します。

```sh
direnv allow ..
pnpm install
pnpm dev
```

型チェックとプロダクションビルド:

```sh
pnpm build
```

Cloudflare Workerの静的アセット配信用ビルド（公開ディレクトリは`dist`）:

```sh
pnpm run build.static
```

本番デプロイは、型チェックとlintを通したうえで実行します。

```sh
pnpm run build.types
pnpm run lint
pnpm run deploy:dry-run
pnpm run deploy
```

`build.static`はブラウザ内で完結するライブラリ・リーダーを静的ファイルとして出力します。`wrangler.jsonc`のSPAフォールバックにより、ビルド時に存在しないローカル論文IDのパスもアプリシェルへ戻します。Go APIは別途`backend`のFly.ioデプロイで公開し、本番ビルドでは`.env.production`の`VITE_API_BASE_URL=https://api.paperlens.micanis.dev`を使用します。

`/register/`ではメールアドレス＋12文字以上のパスワード、またはApple・Google・GitHub SSOで新規登録できます。`/login/`もメール＋パスワードを既定にし、3つのSSOボタンを提供します。ログイン後の設定画面では、同じメールアドレスを確認したSSOだけを明示的に連携・解除できます。開発モードの`/login/`には、SSOアカウントを用意しなくても切り替えられる4人のテストユーザーが表示されます。

## 構成

- `src/routes/` — ライブラリ、PDFリーダー、追加、設定のルート
- `src/components/app-shell.tsx` — サイドバーとレスポンシブシェル
- `src/components/ui/button.tsx` — `cva` + `cn` の共通ボタン
- `src/lib/domain.ts` — `PaperDocument`、注釈、翻訳モードの共通型と Zod スキーマ
- `src/lib/storage.ts` — PDFバイト列を Base64 化しない IndexedDB 境界
- `src/lib/utils.ts` — `clsx` + `tailwind-merge` の `cn`

## UI 方針

- Qwik City + TypeScript
- Tailwind CSS v4（Vite plugin）
- LINE Seed JP のセルフホスト
- Lucide アイコン
- PDF.js はリーダー表示時、本文抽出・全文検索・ZIP圧縮は Web Worker へ遅延ロード
- `paperlens-managed`、各社API、OpenAI互換、local の翻訳モードを共通型で扱う

PDF 本体をサーバーの必須依存にせず、翻訳時だけ共通 API 境界へ渡す設計です。

## 実装済みの境界

ライブラリ、PDF、注釈、翻訳結果、Provider の BYOK 設定はブラウザ内で完結します。PaperLens 管理 LLM を選択した場合だけ `VITE_API_BASE_URL` の Go API を利用します。アカウント、Stripe Checkout / Customer Portal / Webhook、プラン表示は認証済みのユーザー向けに Go API が提供します。決済未設定時は課金操作を有効化しません。
