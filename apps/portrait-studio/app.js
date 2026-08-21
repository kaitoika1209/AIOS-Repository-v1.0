/* Portrait Studio — realistic portrait generation UI on top of the OpenAI Images API. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const LS = {
    settings: 'ps.settings',
    form: 'ps.form',
    selection: 'ps.selection',
    presets: 'ps.clothingPresets',
  };

  /* ── field definitions ─────────────────────────────────────────────
     These drive both the rendered inputs and the composed prompt, so a
     new attribute only has to be added here. Values are free text; the
     options are suggestions surfaced through a <datalist>. */

  const SUBJECT_FIELDS = [
    { key: 'age', label: '年齢層', options: ['10代後半', '20代前半', '20代後半', '30代前半', '30代後半', '40代', '50代', '60代以上'] },
    { key: 'gender', label: '性別表現', options: ['女性', '男性', 'ノンバイナリー', '指定しない'] },
    { key: 'build', label: '体型', options: ['スリム', '標準', 'がっしり', 'ふくよか', 'アスリート体型'] },
    { key: 'hair', label: '髪型・髪色', options: ['黒髪のロングストレート', 'ダークブラウンのボブ', 'ショートレイヤー', 'ミディアムの巻き髪', '刈り上げショート', 'ゆるくまとめたアップヘア'] },
    { key: 'expression', label: '表情', options: ['自然な微笑み', '真顔', '声を出して笑っている', '考え込んでいる', '伏し目がち'] },
    { key: 'pose', label: 'ポーズ・構図', options: ['バストアップの正面', '斜め45度の上半身', '全身', '座って正面', '歩いているところ', '横顔'] },
    { key: 'scene', label: '場所・背景', options: ['白ホリゾントのスタジオ', '窓際のオフィス', 'カフェの店内', '夕方の街路', '自宅のリビング', '屋外の公園'] },
    { key: 'light', label: 'ライティング', options: ['自然光', 'ソフトボックスの柔らかい光', '逆光', '曇天の拡散光', 'ゴールデンアワー', '窓からの斜光'] },
    { key: 'camera', label: 'カメラ・レンズ', options: ['85mm F1.4 のポートレート', '50mm F1.8', '35mm F2 のスナップ', '中判カメラの質感', '望遠 135mm'] },
    { key: 'finish', label: '仕上がり', options: ['ナチュラルな色調', 'フィルムの粒状感', '広告写真のような仕上がり', 'ドキュメンタリー調', 'モノクローム'] },
  ];

  const CLOTHING_FIELDS = [
    { key: 'tops', label: 'トップス', options: ['白のオックスフォードシャツ', '無地のTシャツ', 'ニットのプルオーバー', 'ブラウス', 'パーカー'] },
    { key: 'bottoms', label: 'ボトムス', options: ['黒のワイドパンツ', 'デニム', 'テーパードスラックス', 'ロングスカート', 'チノパン'] },
    { key: 'outer', label: 'アウター', options: ['テーラードジャケット', 'トレンチコート', 'デニムジャケット', 'カーディガン', 'なし'] },
    { key: 'shoes', label: '靴', options: ['白のスニーカー', 'レザーローファー', 'ショートブーツ', 'パンプス', 'サンダル'] },
    { key: 'accessory', label: '小物・アクセサリー', options: ['シルバーの細いネックレス', '腕時計', '細フレームの眼鏡', 'トートバッグ', 'なし'] },
    { key: 'material', label: '色・素材', options: ['オフホワイト×ネイビー', 'アースカラー', 'モノトーン', 'リネン素材', 'ウール素材'] },
  ];

  const REALISM_TEXT =
    '写真としてのリアリティを最優先。自然な肌の質感（毛穴・産毛・わずかな肌ムラ）、実際のカメラで撮影したような被写界深度と微細なノイズ、破綻のない手指と身体のプロポーション。イラスト調・CG調・過度なレタッチには見えないこと。';

  const PERSIST_IDS = ['mainPrompt', 'negativePrompt', 'realismBoost', 'clothingPrompt', 'cgAspect', 'cgVariations', 'genSize', 'genQuality', 'genCount', 'genFormat'];

  const state = {
    assets: [],
    selected: new Set(readJson(LS.selection, [])),
    manual: false,
  };

  /* ── storage helpers ───────────────────────────────────────────── */

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota or private mode — settings simply do not persist */
    }
  }

  /* ── IndexedDB: the reference material library ─────────────────── */

  const DB_NAME = 'portrait-studio';
  const STORE = 'assets';
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function dbRun(mode, fn) {
    const conn = await db();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.onerror = () => reject(tx.error);
      if (req) {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } else {
        tx.oncomplete = () => resolve();
      }
    });
  }

  const putAsset = (asset) => dbRun('readwrite', (s) => s.put(asset));
  const deleteAsset = (id) => dbRun('readwrite', (s) => s.delete(id));
  const allAssets = () => dbRun('readonly', (s) => s.getAll());

  async function loadAssets() {
    const rows = await allAssets();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    state.assets = rows;
    // Drop selections whose asset no longer exists.
    const ids = new Set(rows.map((r) => r.id));
    for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
    renderAssets();
  }

  /* ── settings ──────────────────────────────────────────────────── */

  function getSettings() {
    const s = readJson(LS.settings, {});
    return {
      outputMode: s.outputMode || 'chatgpt',
      mode: s.mode || 'proxy',
      apiKey: s.apiKey || '',
      proxyUrl: s.proxyUrl || '/api',
      model: s.model || 'gpt-image-1',
    };
  }

  function saveSettings() {
    writeJson(LS.settings, {
      outputMode: $('setOutputMode').value,
      mode: $('setMode').value,
      apiKey: $('setApiKey').value.trim(),
      proxyUrl: $('setProxyUrl').value.trim() || '/api',
      model: $('setModel').value.trim() || 'gpt-image-1',
    });
    applySettings();
  }

  function applySettings() {
    const s = getSettings();
    document.querySelectorAll('[data-out], [data-mode]').forEach((el) => {
      const hidden =
        (el.dataset.out && el.dataset.out !== s.outputMode) ||
        (el.dataset.mode && el.dataset.mode !== s.mode);
      el.classList.toggle('hidden', !!hidden);
    });

    const badge = $('connBadge');
    if (s.outputMode === 'chatgpt') {
      badge.textContent = 'ChatGPTに貼り付け';
      badge.className = 'badge badge-ok';
    } else {
      const ready = s.mode === 'proxy' ? !!s.proxyUrl : !!s.apiKey;
      badge.textContent = ready ? (s.mode === 'proxy' ? 'プロキシ経由' : '直接接続') + ' · ' + s.model : '未設定';
      badge.className = 'badge ' + (ready ? 'badge-ok' : 'badge-warn');
    }
  }

  function apiBase(s) {
    return s.mode === 'direct' ? 'https://api.openai.com/v1' : (s.proxyUrl || '/api').replace(/\/+$/, '');
  }

  /* ── dynamic attribute fields ──────────────────────────────────── */

  function buildFields(container, group, defs) {
    container.innerHTML = '';
    for (const def of defs) {
      const id = `f_${group}_${def.key}`;
      const listId = `${id}_list`;
      const label = document.createElement('label');
      label.className = 'field';
      label.innerHTML =
        `<span class="label">${def.label}</span>` +
        `<input id="${id}" type="text" list="${listId}" placeholder="未指定" autocomplete="off" />` +
        `<datalist id="${listId}">${def.options.map((o) => `<option value="${o}"></option>`).join('')}</datalist>`;
      container.appendChild(label);
      PERSIST_IDS.push(id);
    }
  }

  function fieldValues(group, defs) {
    return defs
      .map((def) => ({ label: def.label, value: ($(`f_${group}_${def.key}`).value || '').trim() }))
      .filter((f) => f.value && f.value !== 'なし' && f.value !== '指定しない');
  }

  /* ── form persistence ──────────────────────────────────────────── */

  function saveForm() {
    const data = {};
    for (const id of PERSIST_IDS) {
      const el = $(id);
      if (!el) continue;
      data[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    writeJson(LS.form, data);
  }

  function restoreForm() {
    const data = readJson(LS.form, {});
    for (const [id, value] of Object.entries(data)) {
      const el = $(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!value;
      else el.value = value;
    }
  }

  /* ── prompt composition ────────────────────────────────────────── */

  function composePrompt() {
    const parts = [];

    const main = $('mainPrompt').value.trim();
    if (main) parts.push(main);

    const subject = fieldValues('subject', SUBJECT_FIELDS);
    if (subject.length) {
      parts.push('【人物・撮影】\n' + subject.map((f) => `- ${f.label}: ${f.value}`).join('\n'));
    }

    const clothingLines = [];
    const clothingFree = $('clothingPrompt').value.trim();
    if (clothingFree) clothingLines.push(clothingFree);
    const clothing = fieldValues('clothing', CLOTHING_FIELDS);
    clothingLines.push(...clothing.map((f) => `- ${f.label}: ${f.value}`));
    if (clothingLines.length) parts.push('【服装】\n' + clothingLines.join('\n'));

    const notes = selectedAssets().filter((a) => a.kind === 'text');
    if (notes.length) {
      parts.push('【参考資料】\n' + notes.map((a) => `# ${a.name}\n${a.text}`).join('\n\n'));
    }

    const refImages = selectedAssets().filter((a) => a.kind === 'image');
    if (refImages.length) {
      parts.push(
        `【参考画像】添付した${refImages.length}枚の画像を参照し、雰囲気・服装・構図の指示として扱う。特に指定がない限り、参考画像そのものを複製するのではなく新しい1枚として構成する。`
      );
    }

    if ($('realismBoost').checked) parts.push('【仕上がり要件】\n' + REALISM_TEXT);

    if (getSettings().outputMode === 'chatgpt') {
      const output = [];
      const aspect = $('cgAspect').value;
      const variations = Number($('cgVariations').value) || 1;
      if (aspect) output.push(`- 画角: ${aspect}`);
      output.push(variations > 1 ? `- 同じ設定でバリエーションを${variations}案生成する` : '- 画像は1枚');
      parts.push('【出力】\n' + output.join('\n'));
    }

    const negative = $('negativePrompt').value.trim();
    if (negative) parts.push('【避けたい要素】\n' + negative);

    return parts.join('\n\n');
  }

  function refreshPrompt() {
    if (!state.manual) $('finalPrompt').value = composePrompt();
  }

  /* ── asset library UI ──────────────────────────────────────────── */

  const selectedAssets = () => state.assets.filter((a) => state.selected.has(a.id));

  function persistSelection() {
    writeJson(LS.selection, [...state.selected]);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderAssets() {
    const list = $('assetList');
    const query = $('assetSearch').value.trim().toLowerCase();
    const rows = state.assets.filter(
      (a) => !query || a.name.toLowerCase().includes(query) || (a.text || '').toLowerCase().includes(query)
    );

    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<p class="empty">保存された資料はまだありません。</p>';
    }

    for (const asset of rows) {
      const el = document.createElement('div');
      el.className = 'asset' + (state.selected.has(asset.id) ? ' selected' : '');

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = state.selected.has(asset.id);
      check.title = '選択して生成に使う';
      check.addEventListener('change', () => {
        if (check.checked) state.selected.add(asset.id);
        else state.selected.delete(asset.id);
        persistSelection();
        el.classList.toggle('selected', check.checked);
        updateSelectionInfo();
        refreshPrompt();
      });

      let thumb;
      if (asset.kind === 'image') {
        thumb = document.createElement('img');
        thumb.className = 'asset-thumb';
        thumb.alt = asset.name;
        thumb.src = URL.createObjectURL(asset.blob);
        thumb.addEventListener('load', () => URL.revokeObjectURL(thumb.src), { once: true });
      } else {
        thumb = document.createElement('div');
        thumb.className = 'asset-thumb text-thumb';
        thumb.textContent = 'TXT';
      }

      const body = document.createElement('div');
      body.className = 'asset-body';
      const meta =
        asset.kind === 'image'
          ? `${asset.mime.replace('image/', '').toUpperCase()} · ${formatSize(asset.size)}`
          : (asset.text || '').replace(/\s+/g, ' ').slice(0, 60);
      body.innerHTML = `<div class="asset-name"></div><div class="asset-meta"></div>`;
      body.querySelector('.asset-name').textContent = asset.name;
      body.querySelector('.asset-meta').textContent = meta;

      const del = document.createElement('button');
      del.className = 'asset-del';
      del.type = 'button';
      del.title = '削除';
      del.textContent = '✕';
      del.addEventListener('click', async () => {
        if (!confirm(`「${asset.name}」を削除しますか？`)) return;
        await deleteAsset(asset.id);
        state.selected.delete(asset.id);
        persistSelection();
        await loadAssets();
        updateSelectionInfo();
        refreshPrompt();
      });

      el.append(check, thumb, body, del);
      list.appendChild(el);
    }

    $('assetCount').textContent = `${state.assets.length}件`;
    updateSelectionInfo();
  }

  function updateSelectionInfo() {
    const sel = selectedAssets();
    const images = sel.filter((a) => a.kind === 'image').length;
    const texts = sel.filter((a) => a.kind === 'text').length;
    $('selectionInfo').textContent = `画像 ${images} / テキスト ${texts} を選択中`;
  }

  const newId = () =>
    (crypto.randomUUID && crypto.randomUUID()) || `a_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  async function addFiles(files) {
    const accepted = ['image/png', 'image/jpeg', 'image/webp'];
    let added = 0;
    for (const file of files) {
      if (accepted.includes(file.type)) {
        await putAsset({
          id: newId(),
          kind: 'image',
          name: file.name,
          mime: file.type,
          size: file.size,
          blob: file,
          createdAt: Date.now(),
        });
        added++;
      } else if (file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name)) {
        await putAsset({
          id: newId(),
          kind: 'text',
          name: file.name,
          size: file.size,
          text: await file.text(),
          createdAt: Date.now(),
        });
        added++;
      } else {
        setStatus(`「${file.name}」は対応していない形式のため取り込めませんでした。`, 'error');
      }
    }
    if (added) {
      await loadAssets();
      setStatus(`${added}件の資料を保存しました。`);
    }
  }

  /* ── clothing presets ──────────────────────────────────────────── */

  function clothingSnapshot() {
    const values = {};
    for (const def of CLOTHING_FIELDS) values[def.key] = $(`f_clothing_${def.key}`).value;
    return { prompt: $('clothingPrompt').value, values };
  }

  function applyClothingSnapshot(snap) {
    $('clothingPrompt').value = snap.prompt || '';
    for (const def of CLOTHING_FIELDS) $(`f_clothing_${def.key}`).value = (snap.values || {})[def.key] || '';
    saveForm();
    refreshPrompt();
  }

  function renderPresets(selectedName = '') {
    const presets = readJson(LS.presets, {});
    const select = $('presetSelect');
    select.innerHTML = '<option value="">プリセットを選択</option>';
    for (const name of Object.keys(presets).sort()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    select.value = selectedName;
  }

  /* ── generation ────────────────────────────────────────────────── */

  function setStatus(message, kind = '') {
    const el = $('status');
    el.textContent = message;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function readError(response) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    return `APIエラー (${response.status}): ${detail || response.statusText}`;
  }

  async function generate() {
    const settings = getSettings();
    const prompt = $('finalPrompt').value.trim();

    if (!prompt) return setStatus('プロンプトが空です。', 'error');
    if (settings.mode === 'direct' && !settings.apiKey) return setStatus('APIキーが未設定です。接続設定を開いてください。', 'error');

    const refImages = selectedAssets().filter((a) => a.kind === 'image');
    const size = $('genSize').value;
    const quality = $('genQuality').value;
    const format = $('genFormat').value;
    const n = Math.min(4, Math.max(1, Number($('genCount').value) || 1));

    const headers = {};
    if (settings.mode === 'direct') headers.Authorization = `Bearer ${settings.apiKey}`;

    let url, options;
    if (refImages.length) {
      // Reference images present → image edit endpoint (multi-image input).
      const form = new FormData();
      form.append('model', settings.model);
      form.append('prompt', prompt);
      form.append('n', String(n));
      form.append('size', size);
      form.append('quality', quality);
      form.append('output_format', format);
      for (const asset of refImages) {
        form.append('image[]', new File([asset.blob], asset.name, { type: asset.mime }));
      }
      url = `${apiBase(settings)}/images/edits`;
      options = { method: 'POST', headers, body: form };
    } else {
      url = `${apiBase(settings)}/images/generations`;
      options = {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.model, prompt, n, size, quality, output_format: format }),
      };
    }

    $('generate').disabled = true;
    setStatus(refImages.length ? `参考画像${refImages.length}枚を添付して生成中…` : '生成中…', 'busy');

    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(await readError(response));

      const body = await response.json();
      const items = body.data || [];
      if (!items.length) throw new Error('画像が返却されませんでした。');

      for (const item of items) {
        const src = item.b64_json ? `data:image/${format};base64,${item.b64_json}` : item.url;
        if (src) addResult(src, prompt, format);
      }
      setStatus(`${items.length}枚を生成しました。`);
    } catch (error) {
      setStatus(error.message || String(error), 'error');
    } finally {
      $('generate').disabled = false;
    }
  }

  function addResult(src, prompt, format) {
    const card = document.createElement('div');
    card.className = 'result';

    const img = document.createElement('img');
    img.src = src;
    img.alt = '生成された画像';

    const actions = document.createElement('div');
    actions.className = 'result-actions';

    const download = document.createElement('a');
    download.className = 'btn btn-ghost btn-sm';
    download.href = src;
    download.download = `portrait-${Date.now()}.${format}`;
    download.textContent = '保存';

    const toLibrary = document.createElement('button');
    toLibrary.className = 'btn btn-ghost btn-sm';
    toLibrary.type = 'button';
    toLibrary.textContent = '資料に追加';
    toLibrary.addEventListener('click', async () => {
      const blob = await (await fetch(src)).blob();
      await putAsset({
        id: newId(),
        kind: 'image',
        name: `生成画像 ${new Date().toLocaleString('ja-JP')}`,
        mime: blob.type || `image/${format}`,
        size: blob.size,
        blob,
        createdAt: Date.now(),
      });
      await loadAssets();
      setStatus('生成画像を資料として保存しました。');
    });

    const copyPrompt = document.createElement('button');
    copyPrompt.className = 'btn btn-ghost btn-sm';
    copyPrompt.type = 'button';
    copyPrompt.textContent = 'プロンプト';
    copyPrompt.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(prompt);
        setStatus('この画像のプロンプトをコピーしました。');
      } catch {
        setStatus('クリップボードにアクセスできませんでした。', 'error');
      }
    });

    actions.append(download, toLibrary, copyPrompt);
    card.append(img, actions);
    $('results').prepend(card);
    $('resultsEmpty').classList.add('hidden');
  }

  async function copyPrompt() {
    const text = $('finalPrompt').value;
    if (!text.trim()) return setStatus('プロンプトが空です。', 'error');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API is unavailable outside secure contexts — fall back to selection.
      const area = $('finalPrompt');
      const wasReadOnly = area.readOnly;
      area.readOnly = false;
      area.select();
      const copied = document.execCommand('copy');
      area.readOnly = wasReadOnly;
      area.setSelectionRange(0, 0);
      if (!copied) return setStatus('コピーできませんでした。プロンプト欄を選択して手動でコピーしてください。', 'error');
    }
    setStatus('プロンプトをコピーしました。ChatGPTに貼り付けてください。');
  }

  async function exportReferenceImages() {
    const images = selectedAssets().filter((a) => a.kind === 'image');
    if (!images.length) return setStatus('書き出す参考画像が選択されていません。', 'error');

    images.forEach((asset, index) => {
      const url = URL.createObjectURL(asset.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = /\.[a-z0-9]+$/i.test(asset.name)
        ? asset.name
        : `${asset.name || `reference-${index + 1}`}.${(asset.mime || 'image/png').split('/')[1]}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    setStatus(`参考画像${images.length}枚を書き出しました。ChatGPTの入力欄に添付してください。`);
  }

  /* ── wiring ────────────────────────────────────────────────────── */

  function init() {
    buildFields($('subjectFields'), 'subject', SUBJECT_FIELDS);
    buildFields($('clothingFields'), 'clothing', CLOTHING_FIELDS);

    const settings = getSettings();
    $('setOutputMode').value = settings.outputMode;
    $('setMode').value = settings.mode;
    $('setApiKey').value = settings.apiKey;
    $('setProxyUrl').value = settings.proxyUrl;
    $('setModel').value = settings.model;
    applySettings();

    restoreForm();
    renderPresets();

    $('toggleSettings').addEventListener('click', () => $('settingsPanel').classList.toggle('hidden'));
    for (const id of ['setOutputMode', 'setMode', 'setApiKey', 'setProxyUrl', 'setModel']) {
      $(id).addEventListener('change', saveSettings);
      $(id).addEventListener('input', saveSettings);
    }

    for (const id of PERSIST_IDS) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('input', () => {
        saveForm();
        refreshPrompt();
      });
      el.addEventListener('change', () => {
        saveForm();
        refreshPrompt();
      });
    }

    $('manualPrompt').addEventListener('change', (event) => {
      state.manual = event.target.checked;
      $('finalPrompt').readOnly = !state.manual;
      if (!state.manual) refreshPrompt();
    });

    // asset input
    $('pickFiles').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', async (event) => {
      await addFiles([...event.target.files]);
      event.target.value = '';
    });

    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach((type) =>
      dz.addEventListener(type, (event) => {
        event.preventDefault();
        dz.classList.add('over');
      })
    );
    ['dragleave', 'drop'].forEach((type) =>
      dz.addEventListener(type, (event) => {
        event.preventDefault();
        dz.classList.remove('over');
      })
    );
    dz.addEventListener('drop', (event) => addFiles([...event.dataTransfer.files]));

    $('addNote').addEventListener('click', async () => {
      const text = $('noteBody').value.trim();
      if (!text) return setStatus('メモの内容が空です。', 'error');
      const name = $('noteName').value.trim() || `メモ ${new Date().toLocaleString('ja-JP')}`;
      await putAsset({ id: newId(), kind: 'text', name, size: text.length, text, createdAt: Date.now() });
      $('noteName').value = '';
      $('noteBody').value = '';
      await loadAssets();
      setStatus('メモを資料として保存しました。');
    });

    $('assetSearch').addEventListener('input', renderAssets);
    $('clearSelection').addEventListener('click', () => {
      state.selected.clear();
      persistSelection();
      renderAssets();
      refreshPrompt();
    });

    // clothing presets
    $('presetSelect').addEventListener('change', (event) => {
      const presets = readJson(LS.presets, {});
      const snap = presets[event.target.value];
      if (snap) applyClothingSnapshot(snap);
    });

    $('presetSave').addEventListener('click', () => {
      const name = prompt('プリセット名を入力してください', $('presetSelect').value || '');
      if (!name) return;
      const presets = readJson(LS.presets, {});
      presets[name] = clothingSnapshot();
      writeJson(LS.presets, presets);
      renderPresets(name);
      setStatus(`服装プリセット「${name}」を保存しました。`);
    });

    $('presetDelete').addEventListener('click', () => {
      const name = $('presetSelect').value;
      if (!name) return setStatus('削除するプリセットを選択してください。', 'error');
      const presets = readJson(LS.presets, {});
      delete presets[name];
      writeJson(LS.presets, presets);
      renderPresets();
      setStatus(`服装プリセット「${name}」を削除しました。`);
    });

    $('setOutputMode').addEventListener('change', refreshPrompt);
    $('copyPrompt').addEventListener('click', copyPrompt);
    $('exportRefs').addEventListener('click', exportReferenceImages);
    $('generate').addEventListener('click', generate);
    $('clearResults').addEventListener('click', () => {
      $('results').innerHTML = '';
      $('resultsEmpty').classList.remove('hidden');
    });

    loadAssets().then(refreshPrompt).catch((error) => setStatus(`資料の読み込みに失敗しました: ${error.message}`, 'error'));
    refreshPrompt();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
