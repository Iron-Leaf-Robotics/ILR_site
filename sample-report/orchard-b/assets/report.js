
'use strict';
(async () => {
  document.getElementById('print-report').addEventListener('click', () => window.print());
  const host = document.getElementById('interactive-map');
  const status = document.getElementById('map-status');
  const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  // Only published local images may become URLs, even with untrusted JSON.
  const localImage = value => typeof value === 'string' &&
    /^img\/[A-Za-z0-9_-]+(?:_crop)?\.webp$/.test(value) ? value : null;
  try {
    document.documentElement.classList.add('js-map');
    const response = await fetch('site.json');
    if (!response.ok) throw new Error('site.json unavailable');
    const data = await response.json();
    const config = JSON.parse(host.dataset.map);
    const map = L.map(host, {crs:L.CRS.Simple, minZoom:-5, attributionControl:false, maxBounds:config.bounds,
      maxBoundsViscosity:1, zoomSnap:0.25});
    L.imageOverlay('aerial.webp', config.bounds).addTo(map);
    map.fitBounds(config.bounds);
    const zoom = map.getZoom();
    map.setMinZoom(zoom - 0.5);
    const nativeZoom = zoom + 2;
    map.setMaxZoom(Math.max(zoom, nativeZoom + 3, zoom + 3));
    // Cart-path and row lines: one layer at a constant 60% opacity, switched by the "Cart paths" checkbox.
    const lineLayer = L.layerGroup().addTo(map);
    config.paths.forEach(p => L.polyline(p, {color:'#adbdb2', weight:2, dashArray:'5 4', opacity:.6}).addTo(lineLayer));
    config.rows.forEach(p => L.polyline(p, {color:'#fff', weight:2, opacity:.6}).addTo(lineLayer));
    const pins = L.layerGroup().addTo(map);
    const detections = data.detections || [];
    const clips = data.clips || [];
    const reportFindings = config.findings || [];
    const linked = new Set(reportFindings.map(d => d.clip_id).filter(Boolean));
    const unlinkedClips = clips.filter(d => !linked.has(d.id));
    const items = detections.concat(unlinkedClips);
    const positioned = d => Number.isFinite(d.y) && Number.isFinite(d.x);
    const union = config.rows.flat().concat(reportFindings.concat(clips).flatMap(d =>
      (positioned(d) ? [[d.y,d.x]] : []).concat(d.region || [])));
    requestAnimationFrame(() => { map.invalidateSize(); map.fitBounds(union.length ? union : config.bounds, {padding:[40,40]}); });
    const classLabel = c => (config.classLabels || {})[c] || cap(String(c).replace(/_/g,' '));
    const cards = new Map();
    let selected = null;
    const markers = new Map();
    function highlight(d) {
      selected = d;
      cards.forEach((card,item) => card.setAttribute('aria-pressed', item === d ? 'true' : 'false'));
      markers.forEach((marker,item) => { if (marker.setIcon) marker.setIcon(numberIcon(item)); if (marker.setRadius) marker.setRadius(item === d ? 12 : 7); });
      declutter();
    }
    function metadata(id, d) {
      const node = document.getElementById(id); node.replaceChildren();
      const position = 'Coordinates removed in this public sample';
      Object.entries({Row:d.row, Position:position, Time:[d.date,d.time_local].filter(Boolean).join(' '), Camera:d.camera, Held:Number.isFinite(d.held_s) ? `${Math.round(d.held_s)} s` : '', 'First seen':d.first_seen}).forEach(([key,value]) => { node.append(el('dt',key),el('dd',value === undefined || value === '' ? '\u2014' : value)); });
    }
    const classes = [...new Set(reportFindings.concat(items).map(d => d.class))].sort();
    const dates = [...new Set(reportFindings.concat(items).map(d => d.date).filter(Boolean))].sort();
    const filters = document.getElementById('map-filters');
    const groupTitle = t => { const g = el('span', t); g.className = 'fgroup'; filters.append(g); };
    const inputs = new Map();
    const counts = new Map();
    let heatMode = false, pinsRadio = null, heatRadio = null, heatLegendBox = null, linesBox = null;
    groupTitle('View the marks as');
    const viewToggle = el('div'); viewToggle.className = 'view-toggle'; viewToggle.setAttribute('role', 'radiogroup'); viewToggle.setAttribute('aria-label', 'Map view');
    [['Pins', false], ['Heat map', true]].forEach(([name, heat]) => {
      const label = el('label', name), radio = el('input');
      radio.type = 'radio'; radio.name = 'map-view'; radio.checked = !heat;
      label.append(radio); viewToggle.append(label);
      radio.addEventListener('change', () => { if (radio.checked) setHeat(heat); });
      if (heat) heatRadio = radio; else pinsRadio = radio;
    });
    filters.append(viewToggle);
    heatLegendBox = el('div'); heatLegendBox.className = 'heat-legend'; heatLegendBox.hidden = true;
    filters.append(heatLegendBox);
    if (classes.length) groupTitle('Type');
    classes.forEach(c => {
      const label = el('label');
      const box = el('input'); box.type = 'checkbox'; box.checked = true;
      const count = el('span');
      label.append(box, el('span', classLabel(c)), count); filters.append(label);
      inputs.set(c, box); counts.set(c, count);
      box.addEventListener('change', update);
    });
    const dateLabel = el('label', 'Date ');
    const select = el('select'); select.setAttribute('aria-label', 'Detection date');
    const all = el('option', 'All'); all.value = ''; select.append(all);
    dates.forEach(d => { const option = el('option', d); option.value = d; select.append(option); });
    dateLabel.append(select); filters.append(dateLabel);
    select.addEventListener('change', update);
    const show = {};
    let onlyNew = null;
    const visit = data.site.visit_date || data.site.date || dates[dates.length - 1];
    const hasHistory = data.counts?.not_scanned_before !== undefined || reportFindings.concat(detections,clips).some(d => d.first_seen && d.first_seen < visit);
    const isNew = d => d.new === true && d.first_seen === visit;
    function badge(d) {
      if (!hasHistory || !d.first_seen || d.new === null) return el('span', '');
      // Calendar dates are already site-local; UTC preserves that calendar day.
      const date = new Date(d.first_seen.slice(0,10) + 'T12:00:00Z');
      const label = isNew(d) ? 'New this visit' : 'First seen ' +
        new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric', timeZone:'UTC'}).format(date);
      const b = el('span', label); b.className = isNew(d) ? 'seen-badge new-badge' : 'seen-badge';
      return b;
    }
    const clipDialog = document.getElementById('clip-dialog');
    let active = [], generation = 0;
    const stop = () => { generation++; active.forEach(c => c.video.pause()); };
    let overlay, seek, play;
    function draw(c, enabled = overlay.checked) {
      const v = c.video, canvas = c.canvas;
      canvas.width = v.clientWidth; canvas.height = v.clientHeight;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!enabled) return;
      const frame = Math.floor(v.currentTime * c.meta.fps);
      ctx.strokeStyle = '#2ec4b6'; ctx.fillStyle = '#2ec4b6'; ctx.lineWidth = 2;
      (c.meta.boxes || []).filter(b => b.i === frame).forEach(b => {
        ctx.strokeRect(b.x0*canvas.width, b.y0*canvas.height,
          (b.x1-b.x0)*canvas.width, (b.y1-b.y0)*canvas.height);
        ctx.fillText(b.class || '', b.x0*canvas.width, Math.max(12,b.y0*canvas.height));
      });
    }
    function openClip(d) {
      stop(); active = [];
      document.getElementById('image-dialog').close();
      highlight(d); metadata('clip-meta', d);
      const title = document.getElementById('clip-title');
      title.textContent = d.title || `${cap(d.class)} · ${d.date || ''} ${d.time_local || ''}` +
        (d.kind === 'mark' ? ` · held ${Math.round(d.held_s || 0)} s ` : ' ');
      title.append(badge(d));
      const cameras = document.getElementById('clip-cameras'); cameras.replaceChildren();
      ['L','R'].forEach(side => {
        const column = el('div'); column.append(el('p', side === 'L' ? 'Left camera' : 'Right camera'));
        cameras.append(column);
        const meta = (d.cams || {})[side];
        if (!meta || !/^clips\/[A-Za-z0-9_-]+\.mp4$/.test(meta.src)) {
          column.append(el('p', 'No clip from this camera')); return;
        }
        const stage = el('div'); stage.className = 'clip-stage';
        const video = el('video'); video.muted = true; video.playsInline = true;
        video.loop = true; video.preload = 'metadata'; video.src = meta.src;
        const canvas = el('canvas'); canvas.hidden = !overlay.checked;
        stage.append(video, canvas); column.append(stage);
        const c = {video, canvas, meta}; active.push(c);
        video.addEventListener('loadedmetadata', () => { video.currentTime = 0; draw(c); });
      });
      seek.value = 0; play.textContent = 'Play';
      clipDialog.showModal();
      const token = generation;
      function tick() {
        if (token !== generation || !clipDialog.open) return;
        const leader = active[0];
        if (leader) {
          const t = leader.video.currentTime;
          active.slice(1).forEach(c => {
            if (Math.abs(c.video.currentTime - t) > 0.15) c.video.currentTime = t;
          });
          seek.max = Number.isFinite(leader.video.duration) ? leader.video.duration : 0;
          seek.value = t; active.forEach(c => draw(c));
          if (leader.video.requestVideoFrameCallback && !leader.video.paused)
            leader.video.requestVideoFrameCallback(tick);
          else requestAnimationFrame(tick);
        }
      }
      tick();
    }
    {
      groupTitle('Show');
      ['Photos','Clips','Marked areas'].forEach(name => {
        const label = el('label', name), box = el('input');
        box.type = 'checkbox'; box.checked = true; show[name] = box;
        label.append(box); filters.append(label); box.addEventListener('change', update);
      });
      if (hasHistory) {
        const label = el('label', 'New this visit only'); onlyNew = el('input');
        onlyNew.type = 'checkbox'; label.append(onlyNew); filters.append(label);
        onlyNew.addEventListener('change', update);
      }
      {
        const label = el('label', 'Cart paths'), box = el('input');
        box.type = 'checkbox'; box.checked = true; label.append(box); filters.append(label);
        linesBox = box;
        box.addEventListener('change', () => { if (box.checked) lineLayer.addTo(map); else lineLayer.remove(); update(); });
      }
    }
    if (clips.length) {
      overlay = document.getElementById('clip-overlay');
      seek = document.getElementById('clip-seek'); play = document.getElementById('clip-play');
      overlay.addEventListener('change', () => active.forEach(c => {c.canvas.hidden = !overlay.checked; draw(c);}));
      seek.addEventListener('input', () => active.forEach(c => {c.video.currentTime = Number(seek.value); draw(c);}));
      play.addEventListener('click', () => {
        const paused = active.length && active[0].video.paused;
        active.forEach(c => { if (paused) c.video.play().catch(() => {play.textContent = 'Play';}); else c.video.pause(); });
        play.textContent = paused ? 'Pause' : 'Play';
      });
      document.getElementById('clip-close').addEventListener('click', () => {stop(); clipDialog.close();});
      clipDialog.addEventListener('cancel', stop); clipDialog.addEventListener('close', stop);
    }
    const dialog = document.getElementById('image-dialog');
    const full = dialog.querySelector('img');
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
    // Mound boxes on the photo: Source-report boxes and ages from the hub, or the model's guess until he checks it.
    const AGE_NAME = {NEW:'Fresh mound', '24H':'Recent mound', '1WK':'Week-old mound', OLD:'Old mound', UNS:'Mound, age unsure'};
    const BOX_CYAN = '#00E5FF', BOX_TEXT = '#00262b';   // every mound box is cyan (stands out on grass and soil); the age is in the label
    const boxLayer = dialog.querySelector('.photo-boxes'), boxesOn = document.getElementById('photo-boxes-on');
    function drawBoxes(d, shown) {
      if (!boxLayer || !boxesOn) return;
      boxLayer.replaceChildren();
      boxLayer.hidden = !boxesOn.checked;
      boxesOn.parentElement.hidden = !shown || !(d.photo_boxes || []).length;
      if (!shown) return;
      (d.photo_boxes || []).forEach(b => {
        const [x0, y0, x1, y1] = b.box, shade = BOX_CYAN;
        const r = el('div'); r.className = 'photo-box' + (b.reviewed ? '' : ' guess');
        Object.assign(r.style, {left:`${x0*100}%`, top:`${y0*100}%`, width:`${(x1-x0)*100}%`, height:`${(y1-y0)*100}%`, borderColor:shade});
        const t = el('span', (AGE_NAME[b.age] || AGE_NAME.UNS) + (b.reviewed ? '' : ' · model guess')); t.style.background = shade;
        t.style.color = BOX_TEXT;
        if (x0 > 0.5) Object.assign(t.style, {left:'auto', right:'-3px'});   // keep the label on the photo
        if (y0 < 0.06) Object.assign(t.style, {bottom:'auto', top:'0'});
        r.append(t); boxLayer.append(r);
      });
    }
    if (boxesOn && boxLayer) boxesOn.addEventListener('change', () => { boxLayer.hidden = !boxesOn.checked; });
    // Previous / Next: every finding shown on the map (current filters), numbered marks first, then by time.
    function skimList() {
      return [...markers.keys()].sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9)
        || String(a.date || '').localeCompare(String(b.date || '')) || String(a.time_local || '').localeCompare(String(b.time_local || '')));
    }
    function skim(step) {
      const list = skimList();
      if (!list.length) return;
      const i = list.indexOf(selected), d = list[i < 0 ? 0 : (i + step + list.length) % list.length];
      const m = markers.get(d);
      if (m && m.getLatLng) map.panTo(m.getLatLng());
      openPhoto(d);
    }
    const skimPos = document.getElementById('skim-pos');
    [['skim-prev', -1], ['skim-next', 1]].forEach(([id, step]) => { const b = document.getElementById(id); if (b) b.addEventListener('click', () => skim(step)); });
    function openPhoto(d) {
      stop(); clipDialog && clipDialog.close(); highlight(d);
      const img = d.report ? d.img : localImage(d.img);
      full.hidden = !img;   // no broken-image icon when a mark has no photo (CSS: #image-dialog img[hidden])
      if (img) { full.src = img; full.alt = d.title || d.class || 'Photo'; } else full.removeAttribute('src');
      document.getElementById('image-title').textContent = d.title || `${cap(d.class)} \u00b7 ${d.date || ''} ${d.time_local || ''}`;
      if (!img) document.getElementById('image-title').textContent += ' · no photo for this mark';
      else if (d.caption) document.getElementById('image-title').textContent += ` · ${d.caption}`;
      drawBoxes(d, !!img);
      const list = skimList(), at = list.indexOf(d);
      if (skimPos) skimPos.textContent = at < 0 ? '' : `${at + 1} of ${list.length}`;
      metadata('image-meta', d); if (!dialog.open) dialog.showModal();
    }
    let mini = null;
    function closeMini() {
      if (!mini) return;
      const old = mini; mini = null;
      if (old.video) { old.video.pause(); old.video.removeAttribute('src'); old.video.load(); }
      if (old.popup) map.closePopup(old.popup);
      old.box.remove();
    }
    function openMini(d) {
      closeMini(); highlight(d);
      const card = cards.get(d); if (card && card.classList && card.classList.contains('more')) expandRail();
      if (card) card.scrollIntoView({block:'nearest', behavior:'instant'});
      const box = el('div'); box.className = 'mini-player';
      const row = d.row && (/^row\b/i.test(d.row) ? d.row : `Row ${d.row}`);
      box.append(el('strong',[d.title,row,d.distance].filter(Boolean).join(' \u00b7 ')), badge(d));
      if (Number.isFinite(d.held_s)) box.append(el('span', ` · held ${Math.round(d.held_s)} s`));
      const controls = el('div'); controls.className = 'mini-controls';
      const button = (label, action) => { const b=el('button',label); b.type='button'; b.addEventListener('click',action); controls.append(b); return b; };
      const state = {box}; mini = state;
      const cams = d.cams || {};
      const sides = ['R','L'].filter(k => cams[k] && /^clips\/[A-Za-z0-9_-]+\.mp4$/.test(cams[k].src));
      let hasMedia = sides.length > 0;
      sides.sort((a,b) => (cams[b].boxes || []).length - (cams[a].boxes || []).length);
      if (sides.length) {
        const stage=el('div'); stage.className='clip-stage';
        const video=el('video'), canvas=el('canvas'); state.video=video;
        video.muted=true; video.defaultMuted=true; video.playsInline=true; video.loop=true; video.autoplay=true; video.preload='metadata';
        let side=sides[0], boxes=true;
        const c={video,canvas,meta:cams[side]};
        const playButton=button('Pause',()=>{ if(video.paused) video.play().catch(()=>{}); else video.pause(); playButton.textContent=video.paused?'Play':'Pause'; });
        const swap=()=>{ video.pause(); c.meta=cams[side]; video.src=c.meta.src; video.load(); video.play().catch(()=>{playButton.textContent='Play';}); };
        if(sides.length===2) button('L | R',()=>{side=side==='L'?'R':'L'; swap();});
        const toggle=button('Boxes',()=>{ boxes=!boxes; canvas.hidden=!boxes; toggle.setAttribute('aria-pressed',String(boxes)); });
        toggle.setAttribute('aria-pressed','true');
        stage.append(video,canvas); box.append(stage); swap();
        const tick=()=>{ if(mini!==state) return; draw(c,boxes); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      } else {
        const src=d.report ? d.crop : localImage(d.crop);
        if(src) {const img=el('img'); img.src=src; img.alt=d.title || 'Photo'; box.append(img); hasMedia=true;}
      }
      if(hasMedia) button('Expand',()=>{closeMini(); if(sides.length) openClip(d); else openPhoto(d);});   // no photo or clip: nothing to expand
      button('Close',closeMini); box.append(controls);
      if(window.matchMedia('(max-width:600px)').matches || !positioned(d)) {
        box.className+=' mini-dock'; host.append(box);
      } else {
        state.popup=L.popup({className:'mini-popup',maxWidth:300,autoPan:true,autoPanPaddingTopLeft:[24,24],autoPanPaddingBottomRight:[24,24]}).setLatLng([d.y,d.x]).setContent(box);
        state.popup.on('remove',()=>{if(mini===state) closeMini();}); state.popup.openOn(map);
      }
    }
    function openFinding(d) {
      if (heatMode) setHeat(false);
      if (positioned(d)) map.flyTo([d.y,d.x], Math.min(nativeZoom + 2, zoom + 2), {animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches});
      openMini(d);
    }
    document.addEventListener('keydown', e => { if (dialog.open && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); skim(e.key === 'ArrowRight' ? 1 : -1); return; } if (e.key === 'Escape') { closeMini(); stop(); dialog.close(); clipDialog && clipDialog.close(); } });
    const rail = document.getElementById('findings');
    reportFindings.concat(items).forEach(d => {
      const card = el('button'); card.type = 'button'; card.className = 'finding-card';
      card.setAttribute('aria-pressed','false');
      const crop = d.report ? d.crop : localImage(d.crop);
      if (crop) { const im = el('img'); im.src = crop; im.alt = ''; im.loading = 'lazy'; card.append(im); }
      const body = el('div'); body.append(el('strong',d.title || cap(d.class)));
      const meta = el('div',[d.row,d.distance,d.time_local].filter(Boolean).join(' \u00b7 ')); meta.className = 'finding-meta'; body.append(meta);
      body.append(badge(d)); card.append(body); rail.append(card); cards.set(d,card);
      card.addEventListener('click', () => openFinding(d));
    });
    // Phone: the first 5 findings, then a "Show all" button (the page was 15 000 px tall with 119 cards).
    const PHONE_TOP = 5;
    let showAll = null;
    function expandRail() { cards.forEach(c => c.classList && c.classList.remove('more')); if (showAll) { showAll.remove(); showAll = null; } }
    if (window.matchMedia('(max-width:600px)').matches && cards.size > PHONE_TOP) {
      let n = 0; cards.forEach(c => { if (++n > PHONE_TOP && c.classList) c.classList.add('more'); });
      showAll = el('button', `Show all ${cards.size} findings`); showAll.type = 'button'; showAll.className = 'show-all';
      showAll.addEventListener('click', expandRail); if (rail.after) rail.after(showAll);
    }
    function popup(d) {
      const box = el('div');
      const crop = localImage(d.crop);
      if (crop) { const im = el('img'); im.src = crop; im.alt = d.class + ' crop'; box.append(im); }
      const score = d.score === null ? 'added by hand' : `${Math.floor(d.score * 100)}%`;
      box.append(el('p', `${cap(d.class)} · ${score}`),
        el('p', `${d.date || ''} ${d.time_local || ''} · ${d.camera || ''}`));
      const img = localImage(d.img);
      if (img) {
        const link = el('a', 'Open full labelled image'); link.href = img;
        link.addEventListener('click', e => {
          e.preventDefault(); openPhoto(d);
        });
        box.append(link);
      }
      if (clips.length) box.append(badge(d));
      return box;
    }
    function numberIcon(d, compact = false) {
      const number = !compact && Number.isSafeInteger(d.number) ? String(d.number) : '';
      return L.divIcon({className:'mark-number' + (compact ? ' compact' : '') + (selected === d ? ' selected' : ''), html:'<span class="pin-n">'+number+'</span>', iconSize:compact ? [12,12] : [44,44], iconAnchor:compact ? [6,6] : [22,22]});
    }
    function declutter() {
      const full = [];
      [...markers.entries()].filter(([,marker]) => marker.setIcon).sort(([a],[b]) =>
        (b === selected) - (a === selected) || a.number - b.number).forEach(([d,marker]) => {
        const point = map.latLngToContainerPoint([d.y,d.x]);
        marker.compact = d !== selected && full.some(p => Math.hypot(point.x-p.x, point.y-p.y) < 30);
        if (!marker.compact) full.push(point);
        marker.setIcon(numberIcon(d, marker.compact));
      });
    }
    // Heat map view: where the marks now shown cluster. A plain canvas layer, nothing fetched.
    // A shown mark adds heat within HEAT_RADIUS_M metres. Its weight is the number of mound boxes the operator
    // reviewed on its photo (a mark with none counts 1; unreviewed model guesses never count).
    // A weight of HEAT_FULL, alone or overlapping, reaches the top colour.
    const HEAT_RADIUS_M = 8, HEAT_FULL = 5;
    const HEAT_STOPS = [[0,[43,131,186]],[.35,[102,194,165]],[.65,[254,224,139]],[1,[213,62,79]]];
    const HEAT_LUT = Array.from({length:256}, (_, v) => {
      if (!v) return [0,0,0,0];
      const t = v / 255;
      let i = 1; while (i < HEAT_STOPS.length - 1 && t > HEAT_STOPS[i][0]) i++;
      const [t0,c0] = HEAT_STOPS[i-1], [t1,c1] = HEAT_STOPS[i], f = (t - t0) / (t1 - t0);
      return [0,1,2].map(j => Math.round(c0[j] + (c1[j] - c0[j]) * f)).concat(Math.round(255 * Math.min(.92, .4 + .6 * t)));
    });
    let heatLayer = null, heatCanvas = null;
    function heatPoints() {
      const pts = [];
      markers.forEach((m, d) => {
        const p = positioned(d) ? [d.y, d.x] : (d.region && d.region[0]);
        const w = Math.max(1, (d.photo_boxes || []).filter(b => b.reviewed !== false).length);
        if (p) pts.push([p[0], p[1], w]);
      });
      return pts;
    }
    function hideHeat() { if (heatCanvas) heatCanvas.style.visibility = 'hidden'; }
    function paintHeat() {
      if (!heatCanvas) return;
      const size = map.getSize(), k = 0.5;                       // half resolution: the surface is soft anyway
      const w = Math.max(1, Math.round(size.x * k)), h = Math.max(1, Math.round(size.y * k));
      heatCanvas.width = w; heatCanvas.height = h;
      heatCanvas.style.width = size.x + 'px'; heatCanvas.style.height = size.y + 'px';
      heatCanvas.style.visibility = 'visible';
      L.DomUtil.setPosition(heatCanvas, map.containerPointToLayerPoint([0,0]));
      const g = heatCanvas.getContext('2d');
      g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      const metresPerPx = 1 / Math.pow(2, map.getZoom());
      const r = Math.max(8, HEAT_RADIUS_M / metresPerPx) * k;
      g.globalCompositeOperation = 'lighter';                    // grey level adds up where marks overlap
      heatPoints().forEach(p => {
        const c = map.latLngToContainerPoint(p), x = c.x * k, y = c.y * k;
        if (x < -r || y < -r || x > w + r || y > h + r) return;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(255,255,255,' + (Math.min(HEAT_FULL, p[2]) / HEAT_FULL) + ')');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.fillRect(x - r, y - r, 2 * r, 2 * r);
      });
      const img = g.getImageData(0, 0, w, h), px = img.data;
      for (let i = 0; i < px.length; i += 4) {
        const c = HEAT_LUT[px[i]]; px[i] = c[0]; px[i+1] = c[1]; px[i+2] = c[2]; px[i+3] = c[3];
      }
      g.putImageData(img, 0, 0);
      // Only where the cart scanned: keep the heat within HEAT_RADIUS_M of a scanned row line, nowhere else.
      if (g.beginPath && g.stroke && config.rows && config.rows.length) {
        g.globalCompositeOperation = 'destination-in';
        g.lineWidth = Math.max(4, 2 * HEAT_RADIUS_M / metresPerPx * k); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#000';
        g.beginPath();
        config.rows.forEach(r => r.forEach((q, i) => { const c = map.latLngToContainerPoint(q); if (i) g.lineTo(c.x * k, c.y * k); else g.moveTo(c.x * k, c.y * k); }));
        g.stroke(); g.globalCompositeOperation = 'source-over';
      }
    }
    function buildHeatLegend() {
      const bar = el('canvas'); bar.width = 120; bar.height = 10;
      const g = bar.getContext('2d');
      for (let x = 0; x < 120; x++) { const c = HEAT_LUT[1 + Math.round(x / 119 * 254)]; g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; g.fillRect(x, 0, 1, 10); }
      heatLegendBox.append(el('span', 'none'), bar, el('span', `about ${Math.round(HEAT_FULL / (2 * HEAT_RADIUS_M) * 100)}+ marked spots per 100 m of row`), el('span', 'Shown only along rows the cart scanned.'));
    }
    function setHeat(on) {
      if (on === heatMode) return;
      heatMode = on;
      closeMini();
      if (on) {
        if (!heatLayer) {
          heatLayer = new (L.Layer.extend({
            onAdd(m) {
              heatCanvas = el('canvas'); heatCanvas.className = 'heat-canvas'; heatCanvas.setAttribute('aria-hidden', 'true');
              (m.getPane('heat') || m.createPane('heat')).style.zIndex = 450;   // above the cart-path lines (overlay pane 400), below pins
              m.getPane('heat').appendChild(heatCanvas);
              m.on('zoomstart', hideHeat); m.on('moveend', paintHeat); m.on('resize', paintHeat);   // setHeat() calls update(), which paints
            },
            onRemove(m) {
              m.off('zoomstart', hideHeat); m.off('moveend', paintHeat); m.off('resize', paintHeat);
              heatCanvas.remove(); heatCanvas = null;
            }
          }))();
        }
        if (!heatLegendBox.children.length) buildHeatLegend();
        pins.remove(); heatLayer.addTo(map);
      } else {
        if (heatLayer) heatLayer.remove();
        pins.addTo(map);
      }
      if (pinsRadio) pinsRadio.checked = !on;
      if (heatRadio) heatRadio.checked = on;
      heatLegendBox.hidden = !on;
      update();
    }
    function update() {
      pins.clearLayers(); markers.clear();
      reportFindings.filter(d => positioned(d) && (!show.Photos || show.Photos.checked) && (!onlyNew || !onlyNew.checked || isNew(d)) && (!select.value || d.date === select.value) && (!inputs.has(d.class) || inputs.get(d.class).checked)).forEach(d => {
        const marker = L.marker([d.y,d.x], {icon:numberIcon(d)}).on('click', () => {
          if (marker.compact) map.flyTo([d.y,d.x], Math.min(map.getZoom() + 2, map.getMaxZoom()), {animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches});
          else openMini(d);
        }).addTo(pins);
        if(show['Marked areas'].checked && d.region && d.region.length) L.polyline(d.region,{weight:2,color:'#E5C75A',opacity:0.5,interactive:false}).addTo(pins).bringToBack();
        markers.set(d,marker);
      });
      const dated = detections.filter(d => !select.value || d.date === select.value);

      let missing = 0, shown = 0;
      dated.filter(d => inputs.get(d.class).checked && (!show.Photos || show.Photos.checked) &&
        (!onlyNew || !onlyNew.checked || isNew(d))).forEach(d => {
        if (!Number.isFinite(d.y) || !Number.isFinite(d.x)) { missing++; return; }
        const color = '#5FE3A1';
        const marker = L.circleMarker([d.y,d.x], {radius:selected === d ? 11 : 7, color:'#5FE3A1', weight:2,
          fillColor:color, fillOpacity:0.95}).bindPopup(popup(d)).on('click', () => {highlight(d); openPhoto(d);}).addTo(pins);
        markers.set(d,marker);
        shown++;
      });
      unlinkedClips.filter(d => inputs.get(d.class).checked && (!select.value || d.date === select.value) &&
        (!onlyNew || !onlyNew.checked || isNew(d))).forEach(d => {
        const mark = d.kind === 'mark';
        if (!show[mark ? 'Marked areas' : 'Clips'].checked) return;
        const hasCam = Object.values(d.cams || {}).some(c => c && c.src);
        const content = el('div');
        content.append(el('p', mark ? `Gopher mound marked in the field, held ${Math.round(d.held_s || 0)} s` : cap(d.class)), badge(d));
        const attach = layer => {
          if (hasCam) layer.on('click', () => openClip(d));
          else layer.bindPopup(content).on('click', () => openPhoto(d));
          layer.addTo(pins); if (layer.setRadius) markers.set(d,layer);
        };
        if (mark && d.region && d.region.length) {
          attach(L.polyline(d.region, {weight:6, color:'#E5C75A', opacity:0.85}));
          attach(L.circleMarker(d.region[0], {radius:4, color:'#E5C75A', fillOpacity:0.85}));
        } else if (Number.isFinite(d.y) && Number.isFinite(d.x)) {
          attach(L.circleMarker([d.y,d.x], {radius:selected === d ? 12 : 8, color:'#2ec4b6', weight:3, fillColor:'#10201A', fillOpacity:0.95}));
        }
      });
      classes.forEach(c => {
        const total=reportFindings.concat(items).filter(d => positioned(d) && d.class===c && (!select.value || d.date===select.value)).length;
        const visible=[...markers.keys()].filter(d=>d.class===c).length;
        counts.get(c).textContent=`(${visible}/${total})`;
      });
      const note=document.getElementById('no-position');
      if(note) {note.textContent=missing ? `${missing} without a position` : ''; note.hidden=!missing;}
      status.textContent = heatMode ? `${markers.size} marks in the heat map` : `${markers.size} marks shown`;
      declutter();
      if (heatMode) paintHeat();
      syncUrl();
    }
    map.on('zoomend', declutter);
    // The view lives in the URL (?view=heatmap&new=1&date=..&hide=..) so a link opens the same filters.
    function viewParams() {
      const p = new URLSearchParams();
      if (heatMode) p.set('view', 'heatmap');
      if (onlyNew && onlyNew.checked) p.set('new', '1');
      if (select.value) p.set('date', select.value);
      const hide = classes.filter(c => !inputs.get(c).checked); if (hide.length) p.set('hide', hide.join(','));
      const off = ['Photos','Clips','Marked areas'].filter(n => show[n] && !show[n].checked); if (off.length) p.set('off', off.join(','));
      if (linesBox && !linesBox.checked) p.set('lines', '0');
      return p;
    }
    function syncUrl() {
      try { const q = viewParams().toString(); history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) {}
    }
    function restoreView() {
      let p; try { p = new URLSearchParams(location.search); } catch (e) { return; }
      if (p.get('date') && dates.includes(p.get('date'))) select.value = p.get('date');
      if (p.get('new') === '1' && onlyNew) onlyNew.checked = true;
      (p.get('hide') || '').split(',').forEach(c => { if (inputs.get(c)) inputs.get(c).checked = false; });
      (p.get('off') || '').split(',').forEach(n => { if (show[n]) show[n].checked = false; });
      if (p.get('lines') === '0' && linesBox) { linesBox.checked = false; lineLayer.remove(); }
    }
    restoreView();
    update();
    try { if (new URLSearchParams(location.search).get('view') === 'heatmap') setHeat(true); } catch (e) {}
    document.documentElement.classList.add('map-ready');
  } catch (err) {
    document.documentElement.classList.add('map-failed');
    status.textContent = 'Interactive map unavailable. The static report map is shown below.';
    host.hidden = true;
  }
})();
