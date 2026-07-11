# PlantUML Viewer 運用ルール

## 正本と公開先

- `main` を Cloudflare 本番ソースの唯一の正本とする。
- 公開先は Cloudflare Pages プロジェクト `plantuml-viewer` と `https://plantuml.massivedyno.com/`。
- OpenAI Sites 内部のソースや公開サイトは本番の正本として扱わない。
- `collabvaultx.com` とその DNS・サイト・Pull Request には触れない。

## 「変更して公開して」と依頼された時

1. `main` の最新状態から作業する。
2. 依頼された変更を実装する。
3. `npm run lint` と `npm run test:pages` を実行する。`npm test` は旧OpenAI Sites版の開発用メタタグを検証するため、Cloudflare本番判定には使わない。
4. ユーザーから別の指示がない限り、Pull Requestは作らず `main` へ直接Commit・Pushする。
5. GitHub Actionsの `CI and deploy` が成功するまで確認する。
6. `https://plantuml.massivedyno.com/` を開き、公開内容と基本動作を確認する。
7. 失敗した場合は原因を修正し、Actionsと本番表示を再確認する。

`main` へのPush後は、GitHub Actionsが静的出力 `out/` をビルド・テストし、既存のCloudflare Pagesプロジェクトへ自動デプロイする。通常の更新でCloudflareダッシュボードを手作業する必要はない。

## バックアップブランチ

- `openai-sites-backup` は従来のOpenAI Sites版の保全用。変更・削除・上書きをしない。
- `codex/cloudflare-pages` は移行時点の保全用。ユーザーが明示するまで削除しない。

## 認証情報と課金ガード

- GitHub Actionsには `CLOUDFLARE_API_TOKEN` Secretと `CLOUDFLARE_ACCOUNT_ID` Variableが登録済み。
- トークン値をソース、Commit、ログ、チャットへ出さない。
- 新しいCloudflare Pagesプロジェクト、有料プラン、有料アドオン、有料GitHub Runnerを作らない。
- 無料枠を超える変更や料金が発生し得る操作は、実行前にユーザーへ確認する。
