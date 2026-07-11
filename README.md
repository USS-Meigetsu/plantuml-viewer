# PlantUML Viewer

大きなPlantUML図を、ブラウザだけで安全に描画・確認できる日本語ビューアーです。

**公開サイト:** https://plantuml.massivedyno.com

## 特長

- PlantUMLコードを貼り付けてブラウザ内で描画
- MarkdownのPlantUMLコードブロックにも対応
- ホイールによる拡大・縮小、ドラッグ移動、全体表示、全画面表示
- 操作バーを好きな位置へドラッグ移動
- PNG / SVGで保存
- 描画エラーを選択・コピー可能なテキストとして表示
- 大きすぎる図では、利用者が任意の描画上限を指定して再実行
- アクティビティ図のスイムレーン名を、縦に読み進めても追従表示
- アクティビティ図の箱を選択し、文章・順番・主体・追加・複製・削除を画面上で微修正
- 画面上の編集をPlantUMLコードへ反映し、元に戻す・やり直すにも対応
- 入力コードを外部のPlantUMLサーバーへ送信しないブラウザ内処理

## ローカルで動かす

### 必要環境

- Node.js 22.13以上
- npm

### 起動

```bash
git clone https://github.com/USS-Meigetsu/plantuml-viewer.git
cd plantuml-viewer
npm install
npm run dev
```

起動後、ターミナルに表示されるローカルURLをブラウザで開いてください。

`npm run dev` と `npm run build` の直前に、`@plantuml/core` からブラウザ実行資産を自動生成します。生成物はGit管理の対象外です。

## 主なコマンド

```bash
npm run dev       # 開発サーバー
npm run lint      # ESLint
npm test          # 本番ビルドと基本テスト
npm run build     # Sites向け本番ビルド
npm run test:pages # Cloudflare Pages向け静的ビルドと基本テスト
```

## Cloudflare Pages

`codex/cloudflare-pages` ブランチは、Cloudflare Pages向けの完全な静的サイトを
`out/` に出力します。Pagesのビルドコマンドは `npm run build:pages`、出力先は
`out` です。HTMLと画面用アセットはCloudflareのエッジから配信され、PlantUML
描画エンジンは利用者が初めて図を描画するときだけブラウザへ読み込まれます。

## 描画上限

初期上限は縦横それぞれ8,192pxです。上限超過時だけ変更UIが表示され、必要に応じて最大32,768pxまで指定できます。無制限にはせず、ブラウザのフリーズや過剰なメモリ消費を防いでいます。

## 箱の編集

アクティビティ図を描画した後に「箱を編集」を選ぶと、標準的な `:処理;` の箱を
図上または一覧から選択できます。文章変更、同じ制御構造内での前後移動、主体変更、
前後への追加、複製、削除が可能です。編集のたびにPlantUMLコードへ反映して再描画します。

`if`、`while`、`fork`などの境界を越える並べ替えは、コード構造を壊さないよう制限しています。

## プライバシー

PlantUMLコードと描画処理は利用者のブラウザ内に留まり、外部のPlantUML描画サーバーへ送信されません。入力内容は同じブラウザのローカルストレージにのみ保存されます。

## 技術構成

- React / Next.js互換App Router
- Vinext / Vite
- `@plantuml/core`（TeaVM版PlantUML + Graphviz）
- Lucide React
- Cloudflare Workers互換のSitesビルド

## ライセンス

このリポジトリのアプリケーションコードは[MIT License](LICENSE)で公開しています。

PlantUMLブラウザエンジンは、MITライセンスの[`@plantuml/core`](https://www.npmjs.com/package/@plantuml/core)を利用しています。生成時に同パッケージのライセンスファイルも実行資産へコピーされます。

## コントリビューション

不具合報告や改善提案はGitHub Issuesへどうぞ。変更提案はPull Requestで受け付けます。
