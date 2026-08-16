/* =============================================================
   君がいた季節 — サイトコンテンツ定義
   -------------------------------------------------------------
   ページの中身はすべてこのファイルにまとまっています。
   ここを書き換えるだけで各ページに反映されます。
   （※ 掲載しているメンバー・楽曲・日程はすべてサンプルです）
   ============================================================= */

const SITE = {
  name: '君がいた季節',
  nameEn: 'KIMI GA ITA KISETSU',
  tagline: '忘れたくない季節を、歌にする。',
  copyright: 'KIMI GA ITA KISETSU',
};

/* -------------------------------------------------------------
   NEWS  —  category: news / live / release / media / member / goods
   ------------------------------------------------------------- */
const NEWS = [
  {
    date: '2026.08.14',
    category: 'live',
    title: '「君がいた季節 1st TOUR 2026 “季節のしおり”」東京公演の追加開催が決定しました',
    body: 'チケット即完売を受け、東京国際フォーラム ホールAにて追加公演の開催が決定いたしました。オフィシャルファンクラブ「しおり」会員先行受付は8月20日12:00より開始いたします。',
  },
  {
    date: '2026.08.05',
    category: 'release',
    title: '6thシングル「夏の終わりのサイダー」本日発売',
    title_short: '6thシングル「夏の終わりのサイダー」本日発売',
    body: '通常盤・初回仕様限定盤A/B/Cの4形態で本日発売となりました。初回仕様限定盤にはミュージックビデオおよびメイキング映像を収録したBlu-rayが付属します。',
  },
  {
    date: '2026.07.28',
    category: 'media',
    title: '音楽番組「MUSIC STATION」出演決定のお知らせ',
    body: '8月29日 21:00 放送の音楽番組に出演し、6thシングル表題曲「夏の終わりのサイダー」を披露いたします。ぜひご覧ください。',
  },
  {
    date: '2026.07.15',
    category: 'member',
    title: '2期生 加入のお知らせ',
    body: '新たに4名のメンバーが加入いたしました。今後の「君がいた季節」を、あたたかく見守っていただけますと幸いです。',
  },
  {
    date: '2026.07.02',
    category: 'goods',
    title: 'オフィシャルグッズ 2026 SUMMER COLLECTION 発売',
    body: 'ツアーグッズおよび夏季限定アイテムをオフィシャルオンラインストアにて販売開始いたしました。会場での販売は開演3時間前より行います。',
  },
  {
    date: '2026.06.20',
    category: 'media',
    title: 'レギュラー番組「季節のとなりで」放送開始',
    body: '毎週土曜 25:00 より、メンバーがさまざまな季節の風景を訪ねるレギュラー番組がスタートいたしました。',
  },
  {
    date: '2026.06.01',
    category: 'news',
    title: 'オフィシャルファンクラブ「しおり」開設のお知らせ',
    body: '会員限定コンテンツ、チケット先行受付、バースデーメッセージ等をご用意しております。詳細は特設ページをご確認ください。',
  },
  {
    date: '2026.05.18',
    category: 'live',
    title: '初の全国ツアー「君がいた季節 1st TOUR 2026 “季節のしおり”」開催決定',
    body: '全国5都市10公演をまわる初の全国ツアーの開催が決定いたしました。詳細なスケジュールはSCHEDULEページをご確認ください。',
  },
  {
    date: '2026.04.15',
    category: 'release',
    title: '5thシングル「春を待つ教室」発売',
    body: '5枚目のシングルを発売いたしました。表題曲は卒業をテーマにした、春のはじまりを描く一曲です。',
  },
  {
    date: '2026.03.03',
    category: 'news',
    title: 'オフィシャルサイトリニューアルのお知らせ',
    body: 'このたびオフィシャルサイトをリニューアルいたしました。今後ともよろしくお願いいたします。',
  },
];

const NEWS_CATEGORIES = {
  news: 'NEWS',
  live: 'LIVE',
  release: 'RELEASE',
  media: 'MEDIA',
  member: 'MEMBER',
  goods: 'GOODS',
};

/* -------------------------------------------------------------
   MEMBER
   photo に画像パス（例 'assets/img/members/hinata.jpg'）を入れると
   写真が表示されます。空のままだとメンバーカラーのプレースホルダー。
   ------------------------------------------------------------- */
const MEMBERS = [
  { name: '天野 ひなた', kana: 'あまの ひなた', en: 'AMANO Hinata', initial: '天', gen: 1, birth: '2005.04.12', from: '東京都', height: '158cm', color: '#8fb4d4', catch: 'いちばん先に、春を見つける人。', photo: '' },
  { name: '白瀬 ことね', kana: 'しらせ ことね', en: 'SHIRASE Kotone', initial: '白', gen: 1, birth: '2004.01.08', from: '北海道', height: '163cm', color: '#c3d6ea', catch: '静かな声で、遠くまで届く。', photo: '' },
  { name: '水無月 あおい', kana: 'みなづき あおい', en: 'MINAZUKI Aoi', initial: '水', gen: 1, birth: '2006.06.30', from: '神奈川県', height: '160cm', color: '#6d94ba', catch: '雨のにおいがする歌をうたう。', photo: '' },
  { name: '桜庭 みゆ', kana: 'さくらば みゆ', en: 'SAKURABA Miyu', initial: '桜', gen: 1, birth: '2005.03.27', from: '京都府', height: '155cm', color: '#eeb6b6', catch: '満開のまんなかで笑う。', photo: '' },
  { name: '遠野 なぎさ', kana: 'とおの なぎさ', en: 'TONO Nagisa', initial: '遠', gen: 1, birth: '2003.08.14', from: '沖縄県', height: '166cm', color: '#7fc3c8', catch: '波の音をリズムにして。', photo: '' },
  { name: '陽向 すず', kana: 'ひなた すず', en: 'HINATA Suzu', initial: '陽', gen: 1, birth: '2007.05.05', from: '福岡県', height: '152cm', color: '#f3d9a4', catch: '風鈴みたいに、よく響く。', photo: '' },
  { name: '星野 まりあ', kana: 'ほしの まりあ', en: 'HOSHINO Maria', initial: '星', gen: 1, birth: '2004.11.23', from: '宮城県', height: '164cm', color: '#b9a8d6', catch: '夜がいちばん似合う。', photo: '' },
  { name: '藍原 ちひろ', kana: 'あいはら ちひろ', en: 'AIHARA Chihiro', initial: '藍', gen: 1, birth: '2005.09.19', from: '愛知県', height: '159cm', color: '#52789e', catch: '深いところで、ずっと考えている。', photo: '' },
  { name: '小春 ゆい', kana: 'こはる ゆい', en: 'KOHARU Yui', initial: '小', gen: 2, birth: '2006.02.14', from: '広島県', height: '157cm', color: '#f5c7da', catch: '冬のなかの、あたたかい日。', photo: '' },
  { name: '雪村 いろは', kana: 'ゆきむら いろは', en: 'YUKIMURA Iroha', initial: '雪', gen: 2, birth: '2003.12.24', from: '新潟県', height: '162cm', color: '#d2e2f0', catch: '降りはじめの、しずかな時間。', photo: '' },
  { name: '七海 りん', kana: 'ななみ りん', en: 'NANAMI Rin', initial: '七', gen: 2, birth: '2006.07.07', from: '静岡県', height: '161cm', color: '#a9cbb0', catch: '青いままで、まっすぐに。', photo: '' },
  { name: '夏川 ののか', kana: 'なつかわ ののか', en: 'NATSUKAWA Nonoka', initial: '夏', gen: 2, birth: '2005.08.02', from: '大阪府', height: '154cm', color: '#efa98c', catch: '終わらない夕方をつくる。', photo: '' },
];

/* -------------------------------------------------------------
   DISCOGRAPHY
   ------------------------------------------------------------- */
const RELEASES = [
  {
    no: '6th Single',
    title: '夏の終わりのサイダー',
    date: '2026.08.05',
    color: '#7fc3c8',
    latest: true,
    note: '通常盤 / 初回仕様限定盤A・B・C',
    tracks: ['夏の終わりのサイダー', '汽水域', 'ひとりぶんの花火', '17時の待ち合わせ', '夏の終わりのサイダー (off vocal ver.)'],
  },
  {
    no: '5th Single',
    title: '春を待つ教室',
    date: '2026.04.15',
    color: '#eeb6b6',
    note: '通常盤 / 初回仕様限定盤A・B・C',
    tracks: ['春を待つ教室', '三月の忘れもの', 'チョークの粉', 'また、この坂で', '春を待つ教室 (off vocal ver.)'],
  },
  {
    no: '4th Single',
    title: '約束の交差点',
    date: '2025.12.10',
    color: '#b9a8d6',
    note: '通常盤 / 初回仕様限定盤A・B',
    tracks: ['約束の交差点', '冬のはじまり', 'イルミネーション', '約束の交差点 (off vocal ver.)'],
  },
  {
    no: '3rd Single',
    title: '放課後スケッチ',
    date: '2025.07.23',
    color: '#f3d9a4',
    note: '通常盤 / 初回仕様限定盤A・B',
    tracks: ['放課後スケッチ', '夕立', '窓際の席', '放課後スケッチ (off vocal ver.)'],
  },
  {
    no: '2nd Single',
    title: '白線のむこう',
    date: '2025.03.05',
    color: '#8fb4d4',
    note: '通常盤 / 初回仕様限定盤A・B',
    tracks: ['白線のむこう', '通学路', 'かたつむり', '白線のむこう (off vocal ver.)'],
  },
  {
    no: '1st Single',
    title: '君がいた季節',
    date: '2024.10.09',
    color: '#52789e',
    note: '通常盤 / 初回仕様限定盤',
    tracks: ['君がいた季節', 'はじまりの seasons', '栞', '君がいた季節 (off vocal ver.)'],
  },
];

/* -------------------------------------------------------------
   SCHEDULE  —  type: live / event / tv / radio / release
   ------------------------------------------------------------- */
const SCHEDULE = [
  { date: '2026.08.20', type: 'live',    title: '1st TOUR 2026 “季節のしおり” 大阪公演', place: 'オリックス劇場', time: '開場 17:00 / 開演 18:00' },
  { date: '2026.08.23', type: 'event',   title: '6thシングル発売記念 個別お話し会', place: '幕張メッセ 国際展示場', time: '11:00 – 18:00' },
  { date: '2026.08.29', type: 'tv',      title: '音楽番組 出演', place: '全国ネット', time: '21:00 – 22:54' },
  { date: '2026.09.05', type: 'live',    title: '1st TOUR 2026 “季節のしおり” 名古屋公演', place: '日本特殊陶業市民会館', time: '開場 17:00 / 開演 18:00' },
  { date: '2026.09.13', type: 'radio',   title: 'レギュラー番組「季節のとなりで」', place: 'ラジオ', time: '22:00 – 22:30' },
  { date: '2026.09.21', type: 'live',    title: '1st TOUR 2026 “季節のしおり” 東京・追加公演', place: '東京国際フォーラム ホールA', time: '開場 16:30 / 開演 17:30' },
];

const SCHEDULE_TYPES = {
  live: 'LIVE', event: 'EVENT', tv: 'TV', radio: 'RADIO', release: 'RELEASE',
};

/* -------------------------------------------------------------
   MEDIA / MOVIE
   url に YouTube などのリンクを入れてください
   ------------------------------------------------------------- */
const MEDIA = [
  { label: 'MUSIC VIDEO', title: '「夏の終わりのサイダー」Music Video', date: '2026.08.05', color: '#7fc3c8', url: '#' },
  { label: 'MUSIC VIDEO', title: '「春を待つ教室」Music Video', date: '2026.04.15', color: '#eeb6b6', url: '#' },
  { label: 'DOCUMENTARY', title: 'ドキュメンタリー「はじまりの seasons」', date: '2026.06.10', color: '#b9a8d6', url: '#' },
  { label: 'VARIETY', title: '季節のとなりで #12 ｜ 夏祭りに行ってみた', date: '2026.08.09', color: '#f3d9a4', url: '#' },
];

/* -------------------------------------------------------------
   SNS
   ------------------------------------------------------------- */
const SNS = [
  { name: 'X', handle: '@kimigaita_staff', url: '#', icon: 'x' },
  { name: 'Instagram', handle: '@kimigaita_official', url: '#', icon: 'instagram' },
  { name: 'YouTube', handle: '君がいた季節 OFFICIAL', url: '#', icon: 'youtube' },
  { name: 'TikTok', handle: '@kimigaita', url: '#', icon: 'tiktok' },
];
