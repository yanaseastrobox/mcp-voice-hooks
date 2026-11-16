# 第1段の実装・レビュー用メモ

## 変更点

- `src/unified-server.ts`: 読み上げ希望 `voiceResponses`（初期値ON）とマイク状態 `voiceActive` を分離。speak強制は共通関数 `shouldRequireSpeak()` で「希望ONかつSSEまたはOPEN状態の音声WebSocket接続あり」に限定。validate-action、delivered、Stop、背景強制、入力へのリマインダーに適用。無接続の `/api/speak` は503と文字回答を促す英語エラーを返す。切断で読み上げ希望は変更しない。
- `public/app.js` / `public/index.html`: 独立した読み上げ切替を追加。接続時はサーバーから取得し、初期値を書き戻さない。変更をSSEで他タブへ通知する。
- セッション選択は手動操作と「会話開始」を `selectSession()` に統一。保存済み選択の復元も同じ通知・default移行を通し、保存の再書き込みのみ省略。背景フックの自動選択禁止と選択中セッションのTTL除外は維持。UserPromptSubmitの最初の有効なプロンプトを40文字まで保持（空白を正規化、会話開始トリガーのみは除外）。表示は「プロンプト先頭 — フォルダ名 (短縮ID)」。プロンプト未取得ならフォルダ名を使う。
- `--mcp-managed` はHTTPをlistenせず、daemonの生存確認とspeak転送だけを担当。daemonは `detached: true` / `windowsHide: true` / `stdio: 'ignore'` で起動し、ポート競合側は終了する。転送失敗時は再確認・必要に応じて再起動する。
- 起動時のdaemon確認失敗はstderrに記録してMCP初期化を継続。healthが本サービスでないHTTP応答なら旧版／別アプリの占有としてspawnしない。30秒ごとのunrefタイマーで確認・復旧する。HTTPエラー応答後の不要なensureDaemon呼び出しは削除。
- 設定は `~/.mcp-voice-hooks/state.json` に一時ファイル＋renameで保存。読み上げ希望、選択先、背景読み上げ強制を保存する。保存先は `MCP_VOICE_HOOKS_STATE_FILE` で変更可能。選択先の実体は保存せず、同一セッションのフックが再来するまで復元しない。待機中の別セッションへの入力フォールバックも禁止する。
- ブラウザ認識とサーバー認識は `speech`、文字入力は `typed` として保持。Claude向け文面にも反映。sourceなしは従来互換でvoice inputとして扱う。
- `src/debug.ts`: 一時ディレクトリを `os.tmpdir()` に統一し、ログ書き込み例外を抑止。macOS効果音生成はmacOSのみで実行する。
- `scripts/e2e-phase1.mjs`: 本体を起動するHTTP E2E。既定15112、5111/5112/5113は明示指定も拒否。ブラウザ自動起動なし、HTTPSなし、状態とログは作業ツリー内。既存リスナーがいる場合は中止する。テストで開始したプロセスのみ終了し、検証ファイルは削除しない。

## 設計上の範囲

会話履歴・認識状態は永続化しない。開いたままのブラウザの再接続時は、isListeningがtrueのときだけマイクONを再送する。falseは接続時に送信しない。選択中セッションのTTL除外により、終了済みセッションを選択したままなら一覧に残る。自動で他案件へ切り替えるより、本人の選択を保持することを優先した。

読み上げの再生成功確認、開始ボタンの統合、辞書、認識器・TTS方式変更、スマホ対応は対象外。

## 検証

- `npm.cmd run build -- --no-clean`: 成功。ファイル削除禁止のためcleanを無効化。
- `npx.cmd tsc --noEmit`: 成功。
- `npx.cmd jest --runInBand`: 24スイート、255件成功。ビルドで `dist/hook-merger.js` が生成されたため、提示された既存7件も成功した。
- `npx.cmd knip --no-config-hints` / `npx.cmd ts-prune --error`: 成功。
- `node --check public/app.js` / `node --check scripts/e2e-phase1.mjs`: 成功。
- `MCP_VOICE_HOOKS_E2E_PORT=15112 node scripts/e2e-phase1.mjs`: 6項目PASS。接続／無接続でのStop・post-tool強制、無接続のspeakエラー、表示名保持、設定永続化と選択復元、speak不要の定期復旧、旧版占有時のMCPツール維持を確認。

Windows用Rollup、esbuild、oxc-resolverの既存依存バイナリがnode_modulesから欠落していた。同じバージョンのローカルnpmキャッシュをハッシュ確認後に作業ツリー内へ展開して検証した。依存追加、lockfile変更、ネットワーク取得は行っていない。

## 本番切替

既存フックのURL・payload・MCPのspeak名は変わらない。新しいビルドを既存起動パスに配置するなら、`~/.claude.json` や `settings.json` のフック変更は不要。別の配備先から起動するなら、MCPの起動パスをそのビルドの `dist/unified-server.js --mcp-managed` に合わせる。ポートを変える場合のみMCPとフック双方のポートを揃える。

現在の旧サーバーが同じポートを占有したままだと、新daemonに切り替わらない。MCP転送役は起動を維持し、管理者による旧サーバー終了後は定期確認で新daemonを起動する。この作業では本番終了・設定変更は行わない。OS起動登録・タスクスケジューラ登録も不要。

## コミットの制約

このworktreeのGit管理領域は `C:/dev/mcp-voice-hooks-upstream/.git/worktrees/mcp-voice-hooks-phase1` にある。作業ツリー外・本番ディレクトリへの書き込み禁止と、環境の読み取り専用制限によりコミットは作成せず、変更を作業ツリーに残す。フックを省略したコミットやpushは行わない。
