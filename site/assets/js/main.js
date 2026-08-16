/* =============================================================
   君がいた季節 — main.js
   data.js の内容を各ページに描画し、UI の動きを組み立てます。
   ============================================================= */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- icons ---------------------------------------- */
  const ICON = {
    arrow: '<svg width="22" height="8" viewBox="0 0 22 8" fill="none" aria-hidden="true"><path d="M0 4h20M16.5.5 20.5 4l-4 3.5" stroke="currentColor" stroke-width="1"/></svg>',
    play:  '<svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M13 8 0 16V0z" fill="currentColor"/></svg>',
    up:    '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 13V1M1.5 6.5 7 1l5.5 5.5" stroke="currentColor" stroke-width="1.2"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 1l12 12M13 1 1 13" stroke="currentColor" stroke-width="1.2"/></svg>',
    x:         '<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.82l4.71 6.23 5.46-6.23Zm-1.16 17.52h1.83L7.08 4.13H5.11l11.97 15.64Z"/></svg>',
    instagram: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.4"/><circle cx="17.6" cy="6.4" r="1.2" fill="currentColor"/></svg>',
    youtube:   '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M23.5 7.2a3 3 0 0 0-2.1-2.1C19.5 4.6 12 4.6 12 4.6s-7.5 0-9.4.5A3 3 0 0 0 .5 7.2C0 9.1 0 12 0 12s0 2.9.5 4.8a3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1c.5-1.9.5-4.8.5-4.8s0-2.9-.5-4.8ZM9.6 15.6V8.4l6.2 3.6-6.2 3.6Z"/></svg>',
    tiktok:    '<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.6 2h-3.2v13.1a2.7 2.7 0 1 1-2.2-2.7V9.1a6 6 0 1 0 5.4 6V8.6a7.2 7.2 0 0 0 4.2 1.4V6.8a4.1 4.1 0 0 1-4.2-4.1V2Z"/></svg>',
  };

  /* ---------- petals --------------------------------------- */
  function petals(host, count) {
    if (!host || reduced) return;
    // narrow screens get fewer, smaller petals so they stay a background texture
    const narrow = window.innerWidth < 720;
    if (narrow) count = Math.round(count * 0.55);

    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = 'petal' + (i % 4 === 0 ? ' petal--blue' : '');
      const size = narrow ? 4 + Math.random() * 6 : 6 + Math.random() * 11;
      p.style.setProperty('--x', (Math.random() * 100).toFixed(2) + '%');
      p.style.setProperty('--s', size.toFixed(1) + 'px');
      p.style.setProperty('--d', (13 + Math.random() * 14).toFixed(1) + 's');
      p.style.setProperty('--delay', (-Math.random() * 22).toFixed(1) + 's');
      p.style.setProperty('--sway', (Math.random() * 150 - 75).toFixed(0) + 'px');
      p.style.setProperty('--o', (0.3 + Math.random() * 0.45).toFixed(2));
      frag.appendChild(p);
    }
    host.appendChild(frag);
  }

  /* ---------- header / drawer ------------------------------ */
  function header() {
    const el = $('.header');
    if (!el) return;
    const solid = el.dataset.always === 'solid';
    const onScroll = () => el.classList.toggle('is-solid', solid || window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const burger = $('.burger');
    const drawer = $('.drawer');
    if (!burger || !drawer) return;

    const setOpen = (open) => {
      burger.setAttribute('aria-expanded', String(open));
      drawer.classList.toggle('is-open', open);
      document.body.classList.toggle('is-locked', open);
      drawer.setAttribute('aria-hidden', String(!open));
    };
    burger.addEventListener('click', () => setOpen(burger.getAttribute('aria-expanded') !== 'true'));
    $$('.drawer__link', drawer).forEach((a) => a.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  }

  /* ---------- reveal --------------------------------------- */
  function reveal() {
    const items = $$('[data-reveal]');
    if (!items.length) return;
    if (reduced || !('IntersectionObserver' in window)) {
      items.forEach((i) => i.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.06 });
    items.forEach((i) => io.observe(i));
  }

  /* ---------- to top --------------------------------------- */
  function toTop() {
    const btn = $('.to-top');
    if (!btn) return;
    btn.innerHTML = ICON.up;
    const onScroll = () => btn.classList.toggle('is-show', window.scrollY > 700);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }));
  }

  /* ---------- NEWS ----------------------------------------- */
  function newsRow(n, withBody) {
    const cat = NEWS_CATEGORIES[n.category] || 'NEWS';
    return `
      <li class="news-item">
        <time class="news-item__date">${esc(n.date)}</time>
        <span class="chip" data-cat="${esc(n.category)}">${esc(cat)}</span>
        <p class="news-item__title">${esc(n.title)}</p>
        <span class="news-item__arrow">${ICON.arrow}</span>
        ${withBody && n.body ? `<div class="news-item__body">${esc(n.body)}</div>` : ''}
      </li>`;
  }

  function renderNews() {
    const host = $('[data-news]');
    if (!host) return;
    const limit = parseInt(host.dataset.news, 10);
    const withBody = host.hasAttribute('data-news-body');
    const list = Number.isFinite(limit) && limit > 0 ? NEWS.slice(0, limit) : NEWS;
    host.innerHTML = list.map((n) => newsRow(n, withBody)).join('');

    // filter (news.html)
    const filter = $('[data-news-filter]');
    if (!filter) return;
    const cats = ['all', ...Object.keys(NEWS_CATEGORIES)];
    filter.innerHTML = cats.map((c, i) => `
      <button class="filter__btn${i === 0 ? ' is-active' : ''}" data-cat="${c}">
        ${c === 'all' ? 'ALL' : NEWS_CATEGORIES[c]}
      </button>`).join('');

    filter.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter__btn');
      if (!btn) return;
      $$('.filter__btn', filter).forEach((b) => b.classList.toggle('is-active', b === btn));
      const cat = btn.dataset.cat;
      const rows = cat === 'all' ? NEWS : NEWS.filter((n) => n.category === cat);
      host.innerHTML = rows.length
        ? rows.map((n) => newsRow(n, withBody)).join('')
        : '<li class="empty">該当するお知らせはありません。</li>';
    });
  }

  /* ---------- MEMBER --------------------------------------- */
  function memberCard(m, i) {
    const media = m.photo
      ? `<img src="${esc(m.photo)}" alt="${esc(m.name)}" loading="lazy">`
      : `<span class="member__initial" aria-hidden="true">${esc(m.initial)}</span>`;
    return `
      <button class="member" style="--mc:${esc(m.color)}" data-member="${i}" type="button">
        <span class="member__photo">${media}</span>
        <span class="member__body">
          <span class="member__name">${esc(m.name)}</span>
          <span class="member__en">${esc(m.en)}</span>
          <span class="member__bar"></span>
        </span>
      </button>`;
  }

  function renderMembers() {
    const host = $('[data-members]');
    if (!host) return;

    if (host.dataset.members === 'gen') {
      const gens = [...new Set(MEMBERS.map((m) => m.gen))].sort();
      host.innerHTML = gens.map((g) => {
        const cards = MEMBERS
          .map((m, i) => ({ m, i }))
          .filter((x) => x.m.gen === g)
          .map((x) => memberCard(x.m, x.i)).join('');
        return `
          <h3 class="gen-label" data-reveal>${g}${g === 1 ? 'st' : g === 2 ? 'nd' : g === 3 ? 'rd' : 'th'} GENERATION<span class="sr-only">（${g}期生）</span></h3>
          <div class="member-grid" data-reveal>${cards}</div>`;
      }).join('');
    } else {
      const limit = parseInt(host.dataset.members, 10);
      const list = Number.isFinite(limit) && limit > 0 ? MEMBERS.slice(0, limit) : MEMBERS;
      host.innerHTML = list.map((m) => memberCard(m, MEMBERS.indexOf(m))).join('');
    }

    memberModal();
  }

  function memberModal() {
    let modal = $('.modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-hidden', 'true');
      modal.innerHTML = '<div class="modal__panel"></div>';
      document.body.appendChild(modal);
    }
    const panel = $('.modal__panel', modal);
    let lastFocus = null;

    const close = () => {
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('is-locked');
      if (lastFocus) lastFocus.focus();
    };
    const open = (m, trigger) => {
      lastFocus = trigger;
      const media = m.photo
        ? `<img src="${esc(m.photo)}" alt="${esc(m.name)}">`
        : `<span class="member__initial" aria-hidden="true">${esc(m.initial)}</span>`;
      panel.style.setProperty('--mc', m.color);
      panel.innerHTML = `
        <button class="modal__close" type="button" aria-label="閉じる">${ICON.close}</button>
        <div class="modal__photo">${media}</div>
        <div class="modal__body">
          <p class="modal__catch">${esc(m.catch)}</p>
          <h3 class="modal__name">${esc(m.name)}</h3>
          <p class="modal__kana">${esc(m.kana)}</p>
          <p class="modal__en">${esc(m.en)}</p>
          <dl class="modal__profile">
            <div><dt>GENERATION</dt><dd>${esc(m.gen)}期生</dd></div>
            <div><dt>BIRTHDAY</dt><dd>${esc(m.birth)}</dd></div>
            <div><dt>FROM</dt><dd>${esc(m.from)}</dd></div>
            <div><dt>HEIGHT</dt><dd>${esc(m.height)}</dd></div>
            <div><dt>COLOR</dt><dd><span style="display:inline-block;width:34px;height:10px;border-radius:2px;vertical-align:middle;background:${esc(m.color)}"></span></dd></div>
          </dl>
        </div>`;
      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('is-locked');
      $('.modal__close', panel).focus();
    };

    document.addEventListener('click', (e) => {
      const card = e.target.closest('[data-member]');
      if (card) { open(MEMBERS[+card.dataset.member], card); return; }
      if (e.target.closest('.modal__close') || e.target === modal) close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  /* ---------- DISCOGRAPHY ---------------------------------- */
  const jacket = (r) => `
    <span class="jacket" style="--jc:${esc(r.color)}">
      ${r.cover ? `<img src="${esc(r.cover)}" alt="${esc(r.title)}" loading="lazy">`
                : `<span class="jacket__title">${esc(r.title)}</span>`}
    </span>`;

  function renderDisc() {
    const feat = $('[data-disc-latest]');
    if (feat) {
      const r = RELEASES.find((x) => x.latest) || RELEASES[0];
      feat.innerHTML = `
        <div data-reveal>${jacket(r)}</div>
        <div data-reveal data-delay="1">
          <p class="disc-latest__no">${esc(r.no)}${r.latest ? '<span class="badge-new">NEW</span>' : ''}</p>
          <h3 class="disc-latest__title">${esc(r.title)}</h3>
          <p class="disc-latest__date">${esc(r.date)} RELEASE</p>
          <p class="disc-latest__note">${esc(r.note || '')}</p>
          <ol class="tracklist">
            ${r.tracks.map((t, i) => `<li><span>${String(i + 1).padStart(2, '0')}</span>${esc(t)}</li>`).join('')}
          </ol>
        </div>`;
    }

    const grid = $('[data-disc-grid]');
    if (grid) {
      const all = grid.dataset.discGrid === 'all';
      const list = all ? RELEASES : RELEASES.filter((r) => !r.latest);
      grid.innerHTML = list.map((r) => `
        <a class="disc-card" href="discography.html">
          ${jacket(r)}
          <span class="disc-card__no">${esc(r.no)}</span>
          <span class="disc-card__title">${esc(r.title)}</span>
          <span class="disc-card__date">${esc(r.date)}</span>
        </a>`).join('');
    }

    const full = $('[data-disc-full]');
    if (full) {
      full.innerHTML = RELEASES.map((r, i) => `
        <article class="disc-latest" data-reveal>
          <div>${jacket(r)}</div>
          <div>
            <p class="disc-latest__no">${esc(r.no)}${r.latest ? '<span class="badge-new">NEW</span>' : ''}</p>
            <h3 class="disc-latest__title">${esc(r.title)}</h3>
            <p class="disc-latest__date">${esc(r.date)} RELEASE</p>
            <p class="disc-latest__note">${esc(r.note || '')}</p>
            <ol class="tracklist">
              ${r.tracks.map((t, n) => `<li><span>${String(n + 1).padStart(2, '0')}</span>${esc(t)}</li>`).join('')}
            </ol>
          </div>
        </article>`).join('');
    }
  }

  /* ---------- SCHEDULE ------------------------------------- */
  function renderSchedule() {
    const host = $('[data-schedule]');
    if (!host) return;
    const limit = parseInt(host.dataset.schedule, 10);
    const list = Number.isFinite(limit) && limit > 0 ? SCHEDULE.slice(0, limit) : SCHEDULE;
    host.innerHTML = list.map((s) => {
      const [y, m, d] = s.date.split('.');
      return `
        <li class="sched__item">
          <time class="sched__date"><b>${esc(d)}</b>${esc(y)}.${esc(m)}</time>
          <span class="chip" data-cat="${esc(s.type)}">${esc(SCHEDULE_TYPES[s.type] || s.type)}</span>
          <div class="sched__body">
            <p class="sched__title">${esc(s.title)}</p>
            <p class="sched__meta">${esc(s.place)}　/　${esc(s.time)}</p>
          </div>
        </li>`;
    }).join('');
  }

  /* ---------- MEDIA ---------------------------------------- */
  function renderMedia() {
    const host = $('[data-media]');
    if (!host) return;
    host.innerHTML = MEDIA.map((m, i) => `
      <a class="media-card" href="${esc(m.url)}" style="--mc:${esc(m.color)}" data-reveal data-delay="${i % 4}">
        <span class="media-card__thumb"><span class="play">${ICON.play}</span></span>
        <span class="media-card__label">${esc(m.label)}</span>
        <span class="media-card__title">${esc(m.title)}</span>
        <span class="media-card__date">${esc(m.date)}</span>
      </a>`).join('');
  }

  /* ---------- SNS ------------------------------------------ */
  function renderSns() {
    const grid = $('[data-sns]');
    if (grid) {
      grid.innerHTML = SNS.map((s) => `
        <a class="sns-card" href="${esc(s.url)}" target="_blank" rel="noopener">
          ${ICON[s.icon] || ''}
          <span>
            <span class="sns-card__name">${esc(s.name)}</span><br>
            <span class="sns-card__handle">${esc(s.handle)}</span>
          </span>
        </a>`).join('');
    }
    $$('[data-sns-buttons]').forEach((host) => {
      host.innerHTML = SNS.map((s) => `
        <a class="sns-btn" href="${esc(s.url)}" target="_blank" rel="noopener" aria-label="${esc(s.name)}">
          ${ICON[s.icon] || ''}
        </a>`).join('');
    });
  }

  /* ---------- misc ----------------------------------------- */
  function misc() {
    $$('[data-year]').forEach((e) => { e.textContent = new Date().getFullYear(); });
    $$('[data-tagline]').forEach((e) => { e.textContent = SITE.tagline; });
  }

  /* ---------- boot ----------------------------------------- */
  document.addEventListener('DOMContentLoaded', () => {
    petals($('.hero .petals'), 22);
    petals($('.page-head .petals'), 12);
    petals($('.footer .petals'), 10);

    header();
    misc();
    renderNews();
    renderMembers();
    renderDisc();
    renderSchedule();
    renderMedia();
    renderSns();

    reveal();   // after render so injected [data-reveal] is observed
    toTop();
  });
})();
