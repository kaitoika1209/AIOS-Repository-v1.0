# X Buzz Research

Researches which posts actually outperformed on X, reports what those posts have
in common, and drafts new posts grounded in that evidence.

Two commands:

| Command | What it does | Needs an API key |
| --- | --- | --- |
| `research` | Ranks a set of collected posts and reports the structural traits the top performers share. | No |
| `compose` | Runs the research, then writes post drafts for a topic you give it. | Yes |

---

## Why the ranking is not "most likes"

Raw like counts mostly measure follower count. A post with 4,000 likes from an
account with two million followers underperformed; the same 4,000 likes from an
account with eight thousand followers is a genuine outlier, and only the second
one is worth learning from.

Each post therefore gets a **buzz score** (0–100) built from whichever of these
signals the data supports:

| Signal | What it measures | Benchmark (scores 0.5) |
| --- | --- | --- |
| Engagement rate | interactions ÷ impressions | 3% |
| Amplification rate | (reposts + quotes) ÷ impressions | 0.5% |
| Save rate | bookmarks ÷ impressions | 0.5% |
| Reach multiple | impressions ÷ followers | 3× |
| Follower engagement rate | interactions ÷ followers | 2% |

Signals whose inputs are missing are dropped and the remaining weights are
renormalised, so a post without a bookmark count is not silently penalised. Each
score carries a **confidence**:

- `high` — impressions and follower count both known.
- `medium` — one of the two known.
- `low` — neither. The post was ranked on raw interaction volume, which is the
  weak case the score exists to avoid. The report flags how many of these it found.

**The more of `impressions` and `followers` you record, the more the ranking is
worth.** Everything else is optional.

---

## Getting the data in

There is no X API call here. The X API's post-search endpoint is not on the free
tier, so this service reads a set you collect yourself — by hand, from an
analytics export, or from a scraper you already run.

Both `.json` and `.csv` are accepted.

### JSON

```json
[
  {
    "authorHandle": "indie_dev_mika",
    "url": "https://x.com/indie_dev_mika/status/1000000000000000001",
    "postedAt": "2026-06-02T12:10:00Z",
    "text": "個人開発で3年間、収益ゼロだった。\n\n変えたのは1つだけ。",
    "metrics": {
      "likes": 4820,
      "reposts": 611,
      "replies": 143,
      "quotes": 88,
      "bookmarks": 1902,
      "impressions": 412000,
      "authorFollowers": 8400
    }
  }
]
```

Only `text`, `likes`, `reposts` and `replies` are required.

### CSV

Headers are matched by alias in Japanese or English, so a spreadsheet typed up by
hand usually works without renaming anything:

| Field | Accepted headers |
| --- | --- |
| text | `text`, `content`, `post`, `本文`, `投稿`, `ツイート` |
| author | `author`, `handle`, `username`, `アカウント` |
| likes | `likes`, `favorites`, `いいね` |
| reposts | `reposts`, `retweets`, `rt`, `リポスト` |
| replies | `replies`, `comments`, `コメント`, `返信` |
| quotes | `quotes`, `引用` |
| bookmarks | `bookmarks`, `saves`, `ブックマーク`, `保存` |
| impressions | `impressions`, `views`, `インプレッション`, `表示回数` |
| followers | `followers`, `follower_count`, `フォロワー数` |
| url | `url`, `link`, `リンク` |
| posted at | `posted_at`, `date`, `投稿日` |

Numbers may carry thousands separators or shorthand: `12,300`, `12.3K`, `1.2万`
all parse. Multi-line post text works as long as it is quoted, which every
spreadsheet does automatically on export.

See `samples/` for a working file in each format.

---

## Usage

```bash
npm install

# Analyze. No API key needed.
npm run x-buzz -- research --input samples/buzz-posts.sample.json

# Write the report to a file, plus machine-readable JSON.
npm run x-buzz -- research \
  --input samples/buzz-posts.sample.csv \
  --out out/research.md \
  --json out/research.json

# Draft posts grounded in the analysis.
export ANTHROPIC_API_KEY=sk-ant-...
npm run x-buzz -- compose \
  --input samples/buzz-posts.sample.json \
  --topic "個人開発の収益化で最初にやるべきこと" \
  --audience "個人開発者・インディーハッカー" \
  --tone "断定的だが煽らない" \
  --count 5 \
  --out out/drafts.md
```

`npm run x-buzz -- help` lists every option.

### Options

| Option | Command | Meaning |
| --- | --- | --- |
| `--input <file>` | both | The collected posts. `.json` or `.csv`. Required. |
| `--top <n>` | both | Size of the cohort patterns are measured against. Default: the best third, minimum 3. |
| `--out <file>` | both | Write the Markdown report here instead of stdout. |
| `--json <file>` | research | Also write the analysis as JSON. |
| `--topic <text>` | compose | What to post about. Required. |
| `--count <n>` | compose | Number of drafts. Default 5. |
| `--language <ja\|en>` | compose | Draft language. Default `ja`. |
| `--audience <text>` | compose | Who the post is for. |
| `--goal <text>` | compose | What the post should achieve. |
| `--tone <text>` | compose | Desired voice. |
| `--account <text>` | compose | Context about the posting account. |
| `--include <text>` | compose | Must appear in the draft. Repeatable. |
| `--avoid <text>` | compose | Must not appear. Repeatable. |

### Environment

| Variable | Required | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | for `compose` only | — |
| `X_BUZZ_MODEL` | no | `claude-opus-5` |
| `X_BUZZ_EFFORT` | no | `high` |

---

## What the analysis reports

- **Signature patterns** — structural traits over-represented among the top
  cohort, with the lift over the whole set. A trait present in every post has a
  lift of 1.0 and is not a pattern; one that is three times as common among the
  winners is. Traits need ≥40% presence in the top cohort and ≥1.15× lift to
  qualify.
- **Length and shape** — median weighted length and line count, top cohort
  versus the whole set. Weighted length is how X itself counts: Japanese
  characters and emoji cost 2 units, Latin characters 1, limit 280. A Japanese
  post is therefore capped near 140 characters.
- **Ranking** — every post with its score, confidence, and the signal that drove it.
- **Hooks** — the opening line of each top post, which is what a reader actually
  decides on.

Traits measured: question, number, opens with a number, list, line breaks,
emoji, hashtag, mention, link, call to action, "label: payoff" hook, short, long.

**If no signature patterns appear**, that is a real answer, not a failure: the
top posts are structurally the same as the rest, so what separated them was the
topic or the timing rather than the format. It also happens when the reference
set is too small — under ~10 posts the top cohort is most of the set and nothing
can be over-represented in it.

## What the drafting does

`compose` sends the measured patterns, the length profile, the hooks and the
highest-scoring posts verbatim to Claude, along with your brief. The model is
instructed to treat the patterns as evidence rather than a checklist, not to
invent statistics or sources, and not to reuse wording from the reference posts.

Two things are checked locally rather than trusted to the model:

- **Length.** Every draft's weighted length is recomputed here; over-limit drafts
  are marked in the report instead of being quietly returned as postable.
- **Refusals.** A declined request is reported as an actionable error rather than
  surfacing as an empty result.

Drafts are starting points. Verify every factual claim before posting.

---

## Design

Layered per `docs/engineering/coding-standards.md`, with the domain free of
frameworks:

```text
src/
├── main.ts                     CLI entry point
├── presentation/               Argument parsing and Markdown rendering
├── application/                Use cases: research, compose
├── domain/                     Scoring, structure, patterns, and the ports
└── infrastructure/             File sources, the Claude adapter, configuration
```

Two ports keep the replaceable parts replaceable:

- `BuzzPostSource` — where posts come from. The JSON and CSV readers implement
  it; an X API adapter can be added by writing one more implementation and one
  line in `buzz-post-source.factory.ts`. Nothing in the domain or the use cases
  changes.
- `PostComposer` — who writes the drafts. `docs/engineering/tech-stack.md`
  requires the application to stay provider-agnostic, so the Claude adapter sits
  behind this interface.

Scoring and pattern analysis are deterministic and have no model dependency, so
`research` runs offline and the rules are unit-testable.

### Development

```bash
npm test        # 45 unit tests
npm run typecheck
```

Runs on Node's native TypeScript support (Node ≥ 22.18) — no build step.

---

## 日本語クイックスタート

このリポジトリのドキュメントは英語で統一する規約のため本文は英語ですが、使い方だけ日本語で。

1. **バズ投稿を集める** — `samples/buzz-posts.sample.csv` をコピーして、参考にしたい
   アカウントの投稿を貼り付けます。**「インプレッション」と「フォロワー数」を入れると
   ランキングの精度が大きく上がります**（いいね数だけだとフォロワーの多さを測っている
   だけになるため）。10〜30件あると傾向が出ます。

2. **分析する**（APIキー不要）

   ```bash
   npm install
   npm run x-buzz -- research --input 集めた投稿.csv --out out/research.md
   ```

   伸びた投稿に共通する型（箇条書き・数字・改行・問いかけ・CTA など）と、
   最適な文字数・行数がレポートに出ます。

3. **投稿文を作る**（APIキー必要）

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   npm run x-buzz -- compose \
     --input 集めた投稿.csv \
     --topic "書きたいテーマ" \
     --audience "届けたい読者" \
     --tone "希望する文体" \
     --count 5 \
     --out out/drafts.md
   ```

   文字数は日本語基準（全角2カウント・上限280＝日本語約140文字）で
   こちら側で再計算し、超過した案には警告を付けます。

生成された文面の事実確認は必ず行ってください。
