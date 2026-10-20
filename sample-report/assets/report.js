
'use strict';
(async () => {
  document.getElementById('print-report').addEventListener('click', () => window.print());
  if (window.matchMedia('(max-width:600px)').matches) document.getElementById('map-controls').open = false;
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
    const map = L.map(host, {attributionControl:false, maxBounds:config.bounds,
      maxBoundsViscosity:1, zoomSnap:0.25});
    L.imageOverlay(config.mapImage || 'map.webp', config.bounds).addTo(map);
    map.fitBounds(config.bounds);
    const zoom = map.getZoom();
    map.setMinZoom(config.mapImage === 'map_web.webp' ? map.getBoundsZoom(config.bounds, true) : zoom);
    const nativeZoom = config.imageSize ? Math.log2(config.imageSize[0] * 360 / (256 * Math.abs(config.bounds[1][1] - config.bounds[0][1]))) : zoom + 1;
    map.setMaxZoom(Math.max(zoom, nativeZoom + 3, zoom + 3));
    config.paths.forEach(p => L.polyline(p, {color:'#adbdb2', weight:2, dashArray:'5 4'}).addTo(map));
    config.rows.forEach(p => L.polyline(p, {color:'#fff', weight:2}).addTo(map));
    const pins = L.layerGroup().addTo(map);
    const detections = data.detections || [];
    const clips = data.clips || [];
    const reportFindings = config.findings || [];
    const linked = new Set(reportFindings.map(d => d.clip_id).filter(Boolean));
    const unlinkedClips = clips.filter(d => !linked.has(d.id));
    const items = detections.concat(unlinkedClips);
    const positioned = d => Number.isFinite(d.lat) && Number.isFinite(d.lon);
    const union = config.rows.flat().concat(reportFindings.concat(clips).flatMap(d =>
      (positioned(d) ? [[d.lat,d.lon]] : []).concat(d.region || [])));
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
      const position = Number.isFinite(d.lat) && Number.isFinite(d.lon) ? `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}` + (Number.isFinite(d.eph) ? ` \u00b1 ${d.eph} m` : '') : '';
      Object.entries({Row:d.row, Position:position, Time:[d.date,d.time_local].filter(Boolean).join(' '), Camera:d.camera, Held:Number.isFinite(d.held_s) ? `${Math.round(d.held_s)} s` : '', 'First seen':d.first_seen}).forEach(([key,value]) => { node.append(el('dt',key),el('dd',value === undefined || value === '' ? '\u2014' : value)); });
    }
    const classes = [...new Set(reportFindings.concat(items).map(d => d.class))].sort();
    const dates = [...new Set(reportFindings.concat(items).map(d => d.date).filter(Boolean))].sort();
    const filters = document.getElementById('map-filters');
    const inputs = new Map();
    const counts = new Map();
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
      filters.append(el('span', 'Show:'));
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
    function openPhoto(d) {
      stop(); clipDialog && clipDialog.close(); highlight(d);
      const img = d.report ? d.img : localImage(d.img);
      full.hidden = !img;
      if (img) { full.src = img; full.alt = d.title || d.class || 'Photo'; }
      document.getElementById('image-title').textContent = d.title || `${cap(d.class)} \u00b7 ${d.date || ''} ${d.time_local || ''}`;
      metadata('image-meta', d); dialog.showModal();
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
      const card = cards.get(d); if (card) card.scrollIntoView({block:'nearest', behavior:'instant'});
      const box = el('div'); box.className = 'mini-player';
      const row = d.row && (/^row\b/i.test(d.row) ? d.row : `Row ${d.row}`);
      box.append(el('strong',[d.title,row,d.distance].filter(Boolean).join(' \u00b7 ')), badge(d));
      if (Number.isFinite(d.held_s)) box.append(el('span', ` · held ${Math.round(d.held_s)} s`));
      const controls = el('div'); controls.className = 'mini-controls';
      const button = (label, action) => { const b=el('button',label); b.type='button'; b.addEventListener('click',action); controls.append(b); return b; };
      const state = {box}; mini = state;
      const cams = d.cams || {};
      const sides = ['R','L'].filter(k => cams[k] && /^clips\/[A-Za-z0-9_-]+\.mp4$/.test(cams[k].src));
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
        if(src) {const img=el('img'); img.src=src; img.alt=d.title || 'Photo'; box.append(img);}
      }
      button('Expand',()=>{closeMini(); if(sides.length) openClip(d); else openPhoto(d);});
      button('Close',closeMini); box.append(controls);
      if(window.matchMedia('(max-width:600px)').matches || !positioned(d)) {
        box.className+=' mini-dock'; host.append(box);
      } else {
        state.popup=L.popup({className:'mini-popup',maxWidth:300,autoPan:true,autoPanPaddingTopLeft:[24,24],autoPanPaddingBottomRight:[24,24]}).setLatLng([d.lat,d.lon]).setContent(box);
        state.popup.on('remove',()=>{if(mini===state) closeMini();}); state.popup.openOn(map);
      }
    }
    function openFinding(d) {
      if (positioned(d)) map.flyTo([d.lat,d.lon], Math.min(nativeZoom + 2, zoom + 2), {animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches});
      openMini(d);
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMini(); stop(); dialog.close(); clipDialog && clipDialog.close(); } });
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
        const point = map.latLngToContainerPoint([d.lat,d.lon]);
        marker.compact = d !== selected && full.some(p => Math.hypot(point.x-p.x, point.y-p.y) < 30);
        if (!marker.compact) full.push(point);
        marker.setIcon(numberIcon(d, marker.compact));
      });
    }
    function update() {
      pins.clearLayers(); markers.clear();
      reportFindings.filter(d => positioned(d) && (!show.Photos || show.Photos.checked) && (!onlyNew || !onlyNew.checked || isNew(d)) && (!select.value || d.date === select.value) && (!inputs.has(d.class) || inputs.get(d.class).checked)).forEach(d => {
        const marker = L.marker([d.lat,d.lon], {icon:numberIcon(d)}).on('click', () => {
          if (marker.compact) map.flyTo([d.lat,d.lon], Math.min(map.getZoom() + 2, map.getMaxZoom()), {animate:!window.matchMedia('(prefers-reduced-motion: reduce)').matches});
          else openMini(d);
        }).addTo(pins);
        if(show['Marked areas'].checked && d.region && d.region.length) L.polyline(d.region,{weight:2,color:'#E5C75A',opacity:0.5,interactive:false}).addTo(pins).bringToBack();
        markers.set(d,marker);
      });
      const dated = detections.filter(d => !select.value || d.date === select.value);

      let missing = 0, shown = 0;
      dated.filter(d => inputs.get(d.class).checked && (!show.Photos || show.Photos.checked) &&
        (!onlyNew || !onlyNew.checked || isNew(d))).forEach(d => {
        if (!Number.isFinite(d.lat) || !Number.isFinite(d.lon)) { missing++; return; }
        const color = '#5FE3A1';
        const marker = L.circleMarker([d.lat,d.lon], {radius:selected === d ? 11 : 7, color:'#5FE3A1', weight:2,
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
        } else if (Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
          attach(L.circleMarker([d.lat,d.lon], {radius:selected === d ? 12 : 8, color:'#2ec4b6', weight:3, fillColor:'#10201A', fillOpacity:0.95}));
        }
      });
      classes.forEach(c => {
        const total=reportFindings.concat(items).filter(d => positioned(d) && d.class===c && (!select.value || d.date===select.value)).length;
        const visible=[...markers.keys()].filter(d=>d.class===c).length;
        counts.get(c).textContent=`(${visible}/${total})`;
      });
      const note=document.getElementById('no-position');
      if(note) {note.textContent=missing ? `${missing} without a position` : ''; note.hidden=!missing;}
      status.textContent = `${markers.size} marks shown`;
      declutter();
    }
    map.on('zoomend', declutter);
    update();
    document.documentElement.classList.add('map-ready');
  } catch (err) {
    document.documentElement.classList.add('map-failed');
    status.textContent = 'Interactive map unavailable. The static report map is shown below.';
    host.hidden = true;
  }
})();
