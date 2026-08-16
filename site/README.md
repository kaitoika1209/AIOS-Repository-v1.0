# 君がいた季節 — オフィシャルサイト（サンプル）

いただいたロゴをもとに作った、アイドルグループのホームページ一式です。
ビルド不要の静的サイトなので、`index.html` をブラウザで開けばそのまま動きます。

参考にしたテイスト: 乃木坂46 の余白と明朝の上品さ ＋ 僕が見たかった青空 の青い透明感。
ロゴの淡い空色・桜のピンク・細身の明朝体をそのまま配色とタイポグラフィに落とし込んでいます。

---

## ファイル構成

```text
site/
├── index.html              トップページ（HERO / NEWS / CONCEPT / MEMBER /
│                           DISCOGRAPHY / SCHEDULE / MEDIA / SNS）
├── news.html               お知らせ一覧（カテゴリー絞り込み付き）
├── members.html            メンバー一覧（期別 + プロフィールモーダル）
├── discography.html        作品一覧（収録曲つき）
└── assets/
    ├── css/style.css       スタイル一式
    ├── js/data.js          ★ 掲載内容はすべてここ
    ├── js/main.js          描画とUIの動き
    └── img/
        ├── logo-key.png        いただいた元データ（未加工・原寸）
        ├── logo-wordmark.png   背景を透過させたロゴ（ヘッダー/ヒーロー/フッター用）
        ├── logo-tagline.png    「忘れたくない季節を、歌にする。」
        ├── og-image.jpg        SNSシェア用
        ├── favicon.png / apple-touch-icon.png
```

---

## 見かた

そのまま `index.html` をダブルクリックでも開けますが、ローカルサーバー経由のほうが確実です。

```bash
cd site
python3 -m http.server 8000
# → http://localhost:8000
```

---

## 中身の書き換えかた

**`assets/js/data.js` だけ** を編集すれば、全ページに反映されます。HTML は触らなくて構いません。

| 定数 | 中身 |
|---|---|
| `SITE` | グループ名・キャッチコピー |
| `NEWS` | お知らせ（`category` は `news / live / release / media / member / goods`） |
| `MEMBERS` | メンバー（名前・生年月日・出身・身長・メンバーカラー・キャッチ） |
| `RELEASES` | 作品（`latest: true` を付けた1枚がトップの大きい枠に出ます） |
| `SCHEDULE` | スケジュール（`type` は `live / event / tv / radio / release`） |
| `MEDIA` | 映像コンテンツ（`url` に YouTube 等のリンク） |
| `SNS` | 公式アカウントのリンク |

### メンバー写真を入れる

いまは名字の一文字をメンバーカラーの上に置いたプレースホルダーです。
写真を用意したら `assets/img/members/` に置いて、`photo` にパスを書くだけで差し替わります。

```js
{ name: '天野 ひなた', …, photo: 'assets/img/members/hinata.jpg' },
```

縦長（3:4）だと収まりが良いです。ジャケット写真も同様に `RELEASES` の `cover` にパスを入れると使われます。

### 色を変える

`assets/css/style.css` の冒頭 `:root` にまとまっています。
`--blue-600` や `--sakura` を変えるとサイト全体のトーンが変わります。

---

## 実装メモ

- **レスポンシブ** — 1000px 以下でグローバルナビがハンバーガー＋全画面ドロワーに切り替わります。
- **スクロール演出** — `IntersectionObserver` でセクションをふわっと表示。桜の花びらは CSS アニメーションです。
- **`prefers-reduced-motion`** — 動きを減らす設定の環境では、花びらと出現アニメーションを止めます。
- **JavaScript が無効なとき** — `<html>` に `js` クラスが付いたときだけ要素を隠すので、JS が動かなくてもページが真っ白にはなりません（ただし本文は JS で描画しているため、一覧は空になります）。
- **フォント** — Google Fonts の Shippori Mincho B1 / Cormorant Garamond / Noto Sans JP。
  読み込めない環境では游明朝・ヒラギノ明朝にフォールバックします。

---

## ロゴの加工について

いただいた PNG は背景（淡い空と桜）込みの1枚絵だったので、次の3点を書き出して使っています。
元データ `logo-key.png` はそのまま残してあります。

1. `logo-wordmark.png` — 「君がいた季節 / KIMI GA ITA KISETSU」部分を切り出し、白背景をアルファに変換
2. `logo-tagline.png` — キャッチコピー部分を同様に切り出し
3. `favicon.png` — 「季」の一文字

透過処理は「白の上に戻したとき元の見えかたと一致する」計算をしているので、白〜淡色の背景ならロゴの質感はそのまま出ます。濃色の背景に置く場合は、白抜き版を別途いただけると綺麗です。

---

## 注意

掲載しているメンバー・楽曲・スケジュール・ニュースは**すべて架空のサンプル**です。
実在の人物・団体とは関係ありません。各ページのフッターにもその旨を明記しています。
