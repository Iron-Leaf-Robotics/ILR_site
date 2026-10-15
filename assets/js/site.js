/* Iron Leaf Robotics — site behaviour, shared by every page.
   No dependencies. Everything degrades to plain, readable HTML without JS.

   Footage comes from /assets/media/clips.json. A clip only shows on the live site when:
     - status is "ready" and it has sources,
     - "labels" says where its overlays came from (none | hand | model-reviewed), and
     - "public" is true.
   Anywhere else (staging, localhost) every clip shows, with a chip saying why it wouldn't go live. */
(() => {
  'use strict';
  const root = document.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const small = window.matchMedia('(max-width: 54rem)');
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  const PROD_HOSTS = ['www.ironleafrobotics.ca', 'ironleafrobotics.ca'];
  const isProd = PROD_HOSTS.includes(location.hostname);
  const PUBLIC_LABELS = ['none', 'hand', 'model-reviewed'];
  const LABEL_TEXT = {
    'none': 'Raw footage',
    'hand': 'Labels drawn by hand',
    'model-reviewed': 'Model output, checked by a person',
    'model-unreviewed': 'Model output, not yet checked',
  };
  const CATEGORY_TEXT = { cart: 'The cart', gophers: 'Gopher mounds', stakes: 'Irrigation stakes', canopy: 'Canopy and dripline' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const el = (tag, attrs = {}, html) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v === true ? '' : v);
    }
    if (html !== undefined) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const month = (d) => { if (!d) return ''; const [y, m] = String(d).split('-'); return m ? `${MONTHS[+m - 1]} ${y}` : y; };

  /* ---------- Small things ---------- */
  $$('[data-year]').forEach((n) => { n.textContent = new Date().getFullYear(); });

  /* ---------- Nav ---------- */
  const nav = $('[data-nav]');
  const toggle = $('.nav-toggle');
  const links = $('#nav-links');
  if (toggle && links) {
    const setOpen = (open) => {
      links.classList.toggle('open', open);
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open);
      toggle.textContent = open ? 'Close' : 'Menu';
    };
    toggle.addEventListener('click', () => setOpen(!links.classList.contains('open')));
    $$('a', links).forEach((a) => a.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  }
  if (nav) {
    const overHero = !!$('.hero');
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (overHero) nav.classList.toggle('solid', y > 40);
      const open = links && links.classList.contains('open');
      if (!open && y > 600 && y - lastY > 6) nav.classList.add('tucked');
      else if (lastY - y > 6 || y < 600) nav.classList.remove('tucked');
      lastY = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
  // Highlight the section in view (same-page links only)
  if (links) {
    const map = new Map();
    $$('a[href^="#"]:not(.cta)', links).forEach((a) => { const t = document.getElementById(a.getAttribute('href').slice(1)); if (t) map.set(t, a); });
    if (map.size) {
      const io = new IntersectionObserver((entries) => entries.forEach((e) => {
        if (e.isIntersecting) { map.forEach((a) => a.classList.remove('active')); map.get(e.target).classList.add('active'); }
        else map.get(e.target).classList.remove('active');
      }), { rootMargin: '-40% 0px -55% 0px' });
      map.forEach((_, t) => io.observe(t));
    }
  }

  /* ---------- Reveal ---------- */
  const loadReveal = $('[data-load-reveal]');
  const ready = () => requestAnimationFrame(() => loadReveal && loadReveal.classList.add('ready'));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(ready); else ready();
  setTimeout(ready, 900);

  const revealIO = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); }
  }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  $$('.reveal, .track').forEach((n) => {
    if (loadReveal && loadReveal.contains(n)) { setTimeout(() => n.classList.add('in'), 450); return; }
    revealIO.observe(n);
  });

  /* ---------- Count-up stats ---------- */
  $$('[data-count-group]').forEach((group) => {
    const nums = $$('[data-count]', group);
    const run = () => nums.forEach((n) => {
      const to = parseFloat(n.dataset.count); const dec = +(n.dataset.decimals || 0); const suf = n.dataset.suffix || '';
      if (reduce.matches) { n.textContent = to.toFixed(dec) + suf; return; }
      const t0 = performance.now(); const dur = 1400;
      const step = (t) => {
        const k = clamp((t - t0) / dur, 0, 1); const e = 1 - Math.pow(1 - k, 3);
        n.textContent = (to * e).toFixed(dec) + suf;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { run(); io.disconnect(); } }, { threshold: 0.4 });
    io.observe(group);
  });

  /* ---------- Report map: path draws in, then marks land ---------- */
  $$('[data-map-overlay]').forEach((svg) => {
    let i = 0;
    $$('polyline, line', svg).forEach((p) => {
      p.classList.add('draw'); p.setAttribute('pathLength', '1'); p.style.setProperty('--i', i++);
      if (p.hasAttribute('stroke-dasharray')) {
        // Keep the dashed cart path dashed once it has drawn in
        p.addEventListener('animationend', () => { p.classList.remove('draw'); p.removeAttribute('pathLength'); }, { once: true });
      }
    });
    let j = 0;
    $$('circle, rect, text', svg).forEach((n, idx) => {
      if (idx === 0 && n.tagName === 'rect') return; // full-map tint
      n.classList.add('pop'); n.style.setProperty('--i', j++);
    });
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { svg.classList.add('play'); io.disconnect(); } }, { threshold: 0.3 });
    io.observe(svg);
  });

  /* ---------- Scroll-linked zoom on full-bleed footage ---------- */
  const zoomers = $$('[data-zoom]');
  if (zoomers.length && !reduce.matches) {
    let ticking = false;
    const upd = () => {
      ticking = false;
      zoomers.forEach((z) => {
        const r = z.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return;
        const p = clamp(1 - (r.bottom / (innerHeight + r.height)), 0, 1);
        z.style.setProperty('--zoom', (1.16 - p * 0.14).toFixed(4));
      });
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(upd); } }, { passive: true });
    upd();
  }

  /* ---------- How a pass works ---------- */
  const pass = $('[data-pass]');
  if (pass) {
    const steps = $$('[data-pass-steps] li', pass);
    const count = $('[data-pass-count]', pass);
    const svg = $('[data-row]', pass);
    const N = steps.length;
    const marksX = [212, 344, 468];
    const rejected = 1; // one candidate gets rejected at review, to show that step honestly
    let cart, trail, marks = [], rings = [];
    if (svg) {
      const ns = 'http://www.w3.org/2000/svg';
      const trees = $('.trees', svg);
      for (let x = 34; x <= 570; x += 24) {
        for (const y of [8, 48]) { const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 4.5); c.setAttribute('class', 'tree'); trees.appendChild(c); }
      }
      const g = $('[data-marks]', svg);
      marksX.forEach((x) => {
        const ring = document.createElementNS(ns, 'circle'); ring.setAttribute('cx', x); ring.setAttribute('cy', 28); ring.setAttribute('r', 9); ring.setAttribute('class', 'ring'); g.appendChild(ring); rings.push(ring);
        const m = document.createElementNS(ns, 'circle'); m.setAttribute('cx', x); m.setAttribute('cy', 28); m.setAttribute('r', 4.5); m.setAttribute('class', 'mk'); g.appendChild(m); marks.push(m);
      });
      cart = $('[data-cart]', svg); trail = $('[data-trail]', svg);
    }
    const render = (p, step) => {
      pass.dataset.step = step;
      steps.forEach((li, i) => li.classList.toggle('on', i <= step));
      $('[data-pass-steps]', pass).style.setProperty('--p', p.toFixed(3));
      if (count) count.textContent = `0${step + 1} / 0${N}`;
      if (!svg) return;
      const x = 20 + 560 * clamp((p - 0.04) / 0.62, 0, 1);
      cart.setAttribute('x', x - 6); trail.setAttribute('x2', x);
      marks.forEach((m, i) => {
        const on = step >= 1 && x >= marksX[i];
        m.classList.toggle('on', on);
        const rej = step >= 2 && i === rejected;
        m.style.fill = rej ? 'var(--dim)' : '';
        rings[i].classList.toggle('on', on && !rej);
      });
    };
    const scrollMode = () => !small.matches && !reduce.matches && CSS.supports('position', 'sticky');
    let ticking = false;
    const upd = () => {
      ticking = false;
      if (!scrollMode()) return;
      const r = pass.getBoundingClientRect();
      const navH = 72;
      const span = r.height - (innerHeight - navH);
      const p = clamp((navH - r.top) / span, 0, 1);
      render(p, Math.min(N - 1, Math.floor(p * N * 0.999)));
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(upd); } }, { passive: true });
    window.addEventListener('resize', upd);
    // Small screens: the stage cycles through the steps while it's on screen
    let timer = null, cyc = 0;
    const stage = $('.pass-stage', pass);
    const cycleIO = new IntersectionObserver((es) => {
      const vis = es[0].isIntersecting;
      clearInterval(timer);
      if (vis && !scrollMode() && !reduce.matches) {
        timer = setInterval(() => { cyc = (cyc + 1) % N; render((cyc + 0.99) / N, cyc); }, 3200);
      }
    }, { threshold: 0.4 });
    if (stage) cycleIO.observe(stage);
    if (scrollMode()) upd(); else render(reduce.matches ? 1 : 0.2, reduce.matches ? N - 1 : 0);
    if (reduce.matches || small.matches) steps.forEach((li) => li.classList.add('on'));
  }

  /* ---------- Tabs ---------- */
  $$('[role="tablist"]').forEach((list) => {
    const tabs = $$('[role="tab"]', list);
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) {
          panel.hidden = !on;
          if (on) panel.classList.add('in');
          $$('video', panel).forEach((v) => { if (!on) v.pause(); else if (v._autoplay) v._autoplay(); });
        }
      });
      if (focus) tab.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { e.preventDefault(); select(tabs[(i + d + tabs.length) % tabs.length], true); }
      });
    });
  });

  /* ---------- Footage ---------- */
  const publishable = (c) => {
    if (!c || c.status !== 'ready' || !c.sources) return false;
    if (!(c.sources.mp4 || c.sources.image)) return false;
    if (isProd) return c.public === true && PUBLIC_LABELS.includes(c.labels);
    return true; // staging shows everything, flagged
  };
  const stagingReason = (c) => {
    if (isProd) return null;
    if (!PUBLIC_LABELS.includes(c.labels)) return { cls: 'red', text: 'Not public: labels unchecked' };
    if (c.public !== true) return { cls: 'amber', text: 'Staging only' };
    return null;
  };
  const pickSrc = (c, compact) => {
    const s = c.sources;
    if (!compact && s.mp4_portrait && window.matchMedia('(max-aspect-ratio: 4/5)').matches) return s.mp4_portrait;
    if (s.mp4_720 && (compact || saveData || innerWidth < 900)) return s.mp4_720;
    return s.mp4 || s.mp4_720;
  };

  const vidIO = new IntersectionObserver((entries) => entries.forEach((e) => {
    const v = e.target;
    if (e.isIntersecting) v._autoplay && v._autoplay(); else v.pause();
  }), { threshold: 0.2 });

  const makeVideo = (c, { eager = false, compact = false } = {}) => {
    const v = el('video', { muted: true, loop: true, playsinline: true, preload: eager ? 'auto' : 'none', poster: c.sources.poster, 'aria-label': c.alt || c.title || '' });
    v.muted = true; v.playsInline = true;
    const src = pickSrc(c, compact);
    const load = () => { if (!v.src) { v.src = src; } };
    if (eager) load();
    const canAuto = !reduce.matches && !saveData;
    v._autoplay = () => {
      if (!canAuto) return;
      const panel = v.closest('[role="tabpanel"]');
      if (panel && panel.hidden) return;
      load(); const p = v.play(); if (p) p.catch(() => {});
    };
    if (!canAuto) {
      const b = el('button', { class: 'play-btn', type: 'button', 'aria-label': 'Play clip' }, '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>');
      b.addEventListener('click', () => { load(); v.play(); b.remove(); });
      v._playBtn = b;
    }
    vidIO.observe(v);
    return v;
  };

  const provChip = (c) => el('span', { class: `chip prov ${c.labels}`, text: c.labels_note || LABEL_TEXT[c.labels] || c.labels });

  const mountClip = (box, c, opts = {}) => {
    // Swap the fallback still for the clip; keep overlays (shade, chips, vf) that follow it
    const old = $(':scope > img, :scope > .pending-media, :scope > video', box);
    let node;
    if (c.sources.mp4) {
      node = makeVideo(c, opts);
      if (old && old.classList.contains('still-drift')) node.classList.add('is-clip');
    } else {
      node = el('img', { src: c.sources.image, alt: c.alt || c.title || '', loading: 'lazy', width: c.width, height: c.height });
      node.style.cssText = 'width:100%;height:100%;object-fit:cover';
    }
    if (old) old.replaceWith(node); else box.prepend(node);
    if (node._playBtn) box.appendChild(node._playBtn);
    const why = stagingReason(c);
    if (why) box.appendChild(el('span', { class: `chip ${why.cls} staging-flag`, text: why.text }));
    return node;
  };

  const markPending = (box, id) => {
    if (isProd) return;
    box.appendChild(el('span', { class: 'chip amber staging-flag', text: `Clip pending: ${id}` }));
  };

  const fillHud = (c, video) => {
    const hud = $(`[data-hud="${c.id}"]`);
    if (!hud || !video || video.tagName !== 'VIDEO') return;
    const label = $('[data-hud-label]', hud); const tc = $('[data-hud-tc]', hud);
    label.textContent = [c.site, month(c.date)].filter(Boolean).join(' · ');
    const fps = c.fps || 30;
    const fmt = (t) => {
      const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * fps);
      return [m, s, f].map((n) => String(n).padStart(2, '0')).join(':');
    };
    let raf = 0;
    const tick = () => { tc.textContent = fmt(video.currentTime); raf = requestAnimationFrame(tick); };
    video.addEventListener('playing', () => { hud.hidden = false; cancelAnimationFrame(raf); tick(); });
    video.addEventListener('pause', () => cancelAnimationFrame(raf));
  };

  /* Clip grid + lightbox (field log page) */
  const lightbox = $('[data-lightbox]');
  const openLightbox = (c) => {
    if (!lightbox) return;
    const media = $('.lb-media', lightbox);
    media.innerHTML = '';
    if (c.sources.mp4) {
      const v = el('video', { controls: true, playsinline: true, muted: true, loop: true, poster: c.sources.poster, src: c.sources.mp4 });
      media.appendChild(v);
      if (!reduce.matches) v.play().catch(() => {});
    } else {
      media.appendChild(el('img', { src: c.sources.image, alt: c.alt || c.title || '' }));
    }
    $('[data-lb-title]', lightbox).textContent = c.title || '';
    $('[data-lb-caption]', lightbox).textContent = c.caption || '';
    const dl = $('[data-lb-meta]', lightbox);
    const rows = [
      ['Labels', c.labels_note || LABEL_TEXT[c.labels]],
      ['Finding', CATEGORY_TEXT[c.category]],
      ['Where', c.site], ['When', month(c.date)], ['Crop', c.crop], ['Camera', c.camera],
    ].filter((r) => r[1]);
    dl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    lightbox.showModal();
  };
  if (lightbox) {
    lightbox.addEventListener('close', () => { $$('video', lightbox).forEach((v) => v.pause()); });
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.close(); });
    $('[data-lb-close]', lightbox).addEventListener('click', () => lightbox.close());
  }

  const renderGrid = (grid, clips) => {
    const empty = $('[data-grid-empty]');
    const card = (c) => {
      const li = el('li', { class: 'clip-card reveal', 'data-cat': c.category });
      const btn = el('button', { class: 'clip-media media', type: 'button', 'aria-label': `Open: ${c.title || c.id}` });
      if (c.sources.mp4) {
        const img = el('img', { src: c.sources.poster, alt: '', loading: 'lazy' }); btn.appendChild(img);
        const v = makeVideo(c, { compact: true }); v.classList.add('clip-video'); btn.appendChild(v);
        if (v._playBtn) v._playBtn.remove();
        btn.appendChild(el('span', { class: 'chip clip-kind' }, '<span class="dot"></span>Video'));
      } else {
        btn.appendChild(el('img', { src: c.sources.image, alt: c.alt || '', loading: 'lazy' }));
      }
      const why = stagingReason(c);
      if (why) btn.appendChild(el('span', { class: `chip ${why.cls} staging-flag`, text: why.text }));
      btn.addEventListener('click', () => openLightbox(c));
      li.appendChild(btn);
      const body = el('div', { class: 'clip-body' });
      body.appendChild(provChip(c));
      body.appendChild(el('h3', { text: c.title || c.id }));
      body.appendChild(el('p', { class: 'clip-meta', text: [CATEGORY_TEXT[c.category], c.site, month(c.date)].filter(Boolean).join(' · ') }));
      li.appendChild(body);
      return li;
    };
    grid.innerHTML = '';
    clips.forEach((c) => { const n = card(c); grid.appendChild(n); revealIO.observe(n); });
    const filters = $$('[data-filter]');
    const apply = (cat) => {
      let shown = 0;
      $$('.clip-card', grid).forEach((n) => { const on = cat === 'all' || n.dataset.cat === cat; n.hidden = !on; if (on) shown++; });
      filters.forEach((f) => f.setAttribute('aria-pressed', f.dataset.filter === cat));
      if (empty) empty.hidden = shown > 0;
    };
    filters.forEach((f) => {
      const n = f.dataset.filter === 'all' ? clips.length : clips.filter((c) => c.category === f.dataset.filter).length;
      const k = $('.n', f); if (k) k.textContent = n;
      if (n === 0 && f.dataset.filter !== 'all') f.hidden = true;
      f.addEventListener('click', () => apply(f.dataset.filter));
    });
    apply('all');
  };

  const needsClips = $('[data-clip], [data-clip-cat], [data-clip-grid]');
  if (needsClips) {
    fetch('/assets/media/clips.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        const all = (data.clips || []);
        const byId = new Map(all.map((c) => [c.id, c]));
        const live = all.filter(publishable);

        $$('[data-clip]').forEach((box) => {
          const c = byId.get(box.dataset.clip);
          if (c && publishable(c) && c.sources.mp4) {
            const node = mountClip(box, c, { eager: box.dataset.autoplay === 'eager' });
            fillHud(c, node);
          } else markPending(box, box.dataset.clip);
        });

        $$('[data-clip-cat]').forEach((box) => {
          const c = live.find((x) => x.category === box.dataset.clipCat && x.feature !== false && (x.sources.mp4 || x.sources.image));
          if (!c) return;
          mountClip(box, c);
          const chips = $('[data-clip-chips]', box);
          if (chips) { chips.innerHTML = ''; chips.appendChild(provChip(c)); }
        });

        const grid = $('[data-clip-grid]');
        if (grid) renderGrid(grid, live.filter((c) => c.in_log !== false));
      })
      .catch(() => { /* no manifest: the stills stay, which is fine */ });
  }
})();
