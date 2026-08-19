/**
 * dsh-music-player client half: the browser player, loaded by the web
 * ModuleLoader as a plain React plugin. It injects a now-playing bar into the
 * composer dock and a floating player panel (track list / modes / volume /
 * spectrum) that also holds the music-directory setting in-panel.
 *
 * Audio is a native <audio> element. A per-track peak envelope is decoded via
 * XMLHttpRequest(arraybuffer) + decodeAudioData and drives a smoothed 7-bar
 * equalizer drawn on a canvas rAF loop. Play mode and volume persist across
 * reloads via localStorage; the current track + position are restored without
 * autoplay (a tap on ▶ resumes). Host communication is plain HTTP to the
 * /dsh-music/(manifest|intent|set-root|id) routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-music-player',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;

    // ---- persisted prefs / playback ----
    const PREF_MODE = 'dsh-music-mode';
    const PREF_VOL = 'dsh-music-volume';
    const PREF_PLAYBACK = 'dsh-music-playback';
    const PREF_ROOT = 'dsh-music-root';
    const PREF_PANEL_POS = 'dsh-music-panel-pos';
    const loadPref = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const savePref = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
    const clearPref = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
    // Restore the playback-panel position ({x,y,h}) previously saved by dragging, if any.
    function loadPanelPos() {
      const raw = loadPref(PREF_PANEL_POS);
      if (raw === null) return null;
      try {
        const p = JSON.parse(raw);
        if (p && typeof p.x === 'number' && typeof p.y === 'number'
          && typeof p.h === 'number' && p.h > 0) return p;
      } catch (e) {}
      return null;
    }
    const jsonGet = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json());

    // ---- engine + shared store (React re-renders on set) ----
    const SMOOTH_BARS = 7;
    const PEAK_DECAY = 0.016;
    const audio = new Audio();
    audio.preload = 'auto';

    const store = {
      root: null, tracks: [], count: 0, currentId: null, currentName: null,
      playing: false, position: 0, duration: 0, volume: 0.8,
      panelOpen: false, loading: false, error: null, pendingId: null, pendingName: null,
      mode: 'order', vizState: 'ok',
    };
    const listeners = new Set();
    function set(patch) {
      Object.assign(store, patch);
      if ('mode' in patch) savePref(PREF_MODE, patch.mode);
      if ('volume' in patch) savePref(PREF_VOL, String(patch.volume));
      for (const fn of [...listeners]) fn();
    }
    function useStore() {
      const [snap, setSnap] = useState(store);
      useEffect(() => {
        const update = () => setSnap({ ...store });
        listeners.add(update);
        update();
        return () => { listeners.delete(update); };
      }, []);
      return snap;
    }
    const trackById = (id) => (store.tracks || []).find((t) => t.id === id) || null;

    // restore persisted prefs
    try {
      const m = loadPref(PREF_MODE);
      if (m === 'single' || m === 'order' || m === 'shuffle') store.mode = m;
      const v = parseFloat(loadPref(PREF_VOL));
      if (Number.isFinite(v)) { store.volume = Math.min(1, Math.max(0, v)); audio.volume = store.volume; }
    } catch (e) {}

    function savePlayback() {
      if (store.currentId === null) { clearPref(PREF_PLAYBACK); return; }
      savePref(PREF_PLAYBACK, JSON.stringify({ id: store.currentId, name: store.currentName, position: audio.currentTime || 0 }));
    }
    function loadPlayback() {
      const raw = loadPref(PREF_PLAYBACK);
      if (raw === null) return null;
      try { const p = JSON.parse(raw); if (p && typeof p.id === 'string') return p; } catch (e) {}
      return null;
    }

    // ---- envelope decode (current-track guarded by generation token; prefetch caches only) ----
    let decodeCtx = null;
    let trackEnv = null;
    let envReqId = 0;
    const envCache = new Map();
    function closeDecodeCtx() {
      if (decodeCtx !== null && decodeCtx.state !== 'closed') decodeCtx.close();
      decodeCtx = null;
    }
    function ensureDecodeCtx() {
      if (decodeCtx !== null) return decodeCtx;
      try {
        const Ctor = (window.AudioContext || window.webkitAudioContext);
        if (Ctor === undefined) return null;
        decodeCtx = new Ctor();
      } catch { decodeCtx = null; }
      return decodeCtx;
    }
    function trimCache() { while (envCache.size > 24) envCache.delete(envCache.keys().next().value); }
    function loadEnvelope(id, url, isPrefetch) {
      const cached = envCache.get(id);
      const isCurrent = () => store.currentId === id;
      if (cached !== undefined) { if (isCurrent()) { trackEnv = cached; set({ vizState: 'ok' }); } return; }
      const reqId = isPrefetch ? -1 : (++envReqId);
      if (isCurrent()) { trackEnv = null; set({ vizState: 'loading' }); }
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => {
          const ac = ensureDecodeCtx();
          if (ac === null || xhr.response === null) return;
          ac.decodeAudioData(xhr.response).then((buf) => {
            const ch = buf.getChannelData(0);
            const dt = 0.05;
            const n = Math.max(1, Math.ceil(buf.duration / dt));
            const peaks = new Float32Array(n);
            const sRate = buf.sampleRate;
            for (let i = 0; i < n; i++) {
              const s = Math.floor(i * dt * sRate);
              const e = Math.min(ch.length, Math.floor((i + 1) * dt * sRate));
              let p = 0;
              for (let j = s; j < e; j++) { const v = Math.abs(ch[j]); if (v > p) p = v; }
              peaks[i] = p;
            }
            const env = { peaks, dt, duration: buf.duration };
            envCache.set(id, env);
            trimCache();
            if (!isPrefetch && reqId === envReqId && isCurrent()) { trackEnv = env; set({ vizState: 'ok' }); }
          }).catch(() => { if (!isPrefetch && isCurrent()) set({ vizState: 'unavailable' }); });
        };
        xhr.onerror = () => { if (!isPrefetch && isCurrent()) set({ vizState: 'unavailable' }); };
        xhr.send();
      } catch { if (!isPrefetch && isCurrent()) set({ vizState: 'unavailable' }); }
    }
    function prefetchNext() {
      if (store.tracks.length === 0 || store.currentId === null) return;
      let nextId = null;
      if (store.mode === 'shuffle') {
        // Prefetch the queued next track so a shuffle "next" starts instantly.
        if (shuffleQueue.length === store.tracks.length) {
          const pos = shuffleQueue.indexOf(store.currentId);
          if (pos >= 0 && pos + 1 < shuffleQueue.length) nextId = shuffleQueue[pos + 1];
        }
      } else {
        const idx = store.tracks.findIndex((t) => t.id === store.currentId);
        const next = store.tracks[(idx + 1) % store.tracks.length];
        if (next !== undefined) nextId = next.id;
      }
      if (nextId !== null) {
        const next = trackById(nextId);
        if (next !== undefined && !envCache.has(next.id)) loadEnvelope(next.id, next.url, true);
      }
    }

    // ---- bar color sampling + canvas drawing ----
    let barCanvasNode = null;
    let rafId = null;
    let scanCounter = 0;
    let barColor = null;
    const smoothCur = new Float32Array(SMOOTH_BARS);
    const smoothPeak = new Float32Array(SMOOTH_BARS);
    const targetBuf = new Float32Array(SMOOTH_BARS);
    function extractColorFromCss(value) {
      if (typeof value !== 'string') return null;
      const rgba = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\)/);
      if (rgba !== null) {
        if (rgba[4] !== undefined && parseFloat(rgba[4]) < 0.15) return null;
        return 'rgb(' + rgba[1] + ', ' + rgba[2] + ', ' + rgba[3] + ')';
      }
      const hex = value.match(/#([0-9a-fA-F]{6})/);
      if (hex !== null) return '#' + hex[1];
      return null;
    }
    function refreshBarColor() {
      let best = null; let bestSat = -1;
      try {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const cs = getComputedStyle(btn);
          let col = extractColorFromCss(cs.backgroundColor);
          if (col === null) {
            const grads = cs.backgroundImage.match(/#[0-9a-fA-F]{6}|rgba?\([^)]*\)/g);
            if (grads !== null && grads.length > 0) { for (const g of grads) { const c = extractColorFromCss(g); if (c !== null) { col = c; break; } } }
          }
          if (col === null) continue;
          const rgb = col.match(/(\d+)/g);
          if (rgb === null || rgb.length < 3) continue;
          const r = parseInt(rgb[0], 10); const g = parseInt(rgb[1], 10); const b = parseInt(rgb[2], 10);
          const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const sat = mx - mn;
          if (sat < 40 || mx < 80) continue;
          if (sat > bestSat) { bestSat = sat; best = 'rgb(' + r + ', ' + g + ', ' + b + ')'; }
        }
      } catch {}
      if (best !== null && best !== barColor) {
        barColor = best;
        document.documentElement.style.setProperty('--dsh-music-accent', best);
      }
    }
    function drawBars(canvas, useCaps) {
      const c = canvas.getContext('2d');
      const w = canvas.width; const h = canvas.height;
      c.clearRect(0, 0, w, h);
      const gap = 2;
      const bw = (w - gap * (SMOOTH_BARS - 1)) / SMOOTH_BARS;
      const color = barColor || '#2f9e6e';
      for (let i = 0; i < SMOOTH_BARS; i++) {
        const bh = Math.max(2, Math.round(smoothCur[i] * (h - 2)));
        const x = Math.round(i * (bw + gap));
        c.fillStyle = color;
        c.fillRect(x, h - 1 - bh, Math.floor(bw), bh);
        if (useCaps && smoothPeak[i] > smoothCur[i] + 0.03) {
          const py = h - 1 - Math.round(smoothPeak[i] * (h - 2));
          c.fillStyle = color;
          c.fillRect(x, Math.max(0, py), Math.floor(bw), 2);
        }
      }
    }
    function drawViz() {
      scanCounter++;
      if (scanCounter % 120 === 0) refreshBarColor();
      if (store.playing && trackEnv !== null) {
        const envIdx = (audio.currentTime || 0) / trackEnv.dt;
        const base = Math.floor(envIdx);
        const n = trackEnv.peaks.length;
        for (let i = 0; i < SMOOTH_BARS; i++) {
          const len = 2 + (SMOOTH_BARS - 1 - i);
          let mx = 0;
          for (let k = base; k > base - len && k >= 0; k--) { if (k >= n) continue; const v = trackEnv.peaks[k]; if (v > mx) mx = v; }
          targetBuf[i] = mx;
        }
      } else if (store.playing) {
        const now = Date.now();
        for (let i = 0; i < SMOOTH_BARS; i++) targetBuf[i] = 0.12 + 0.05 * Math.sin(now / 240 + i * 0.9);
      } else {
        for (let i = 0; i < SMOOTH_BARS; i++) targetBuf[i] = 0;
      }
      for (let i = 0; i < SMOOTH_BARS; i++) {
        const t = targetBuf[i];
        if (t > smoothCur[i]) smoothCur[i] += (t - smoothCur[i]) * 0.6;
        else smoothCur[i] += (t - smoothCur[i]) * 0.1;
        if (t > smoothPeak[i]) smoothPeak[i] = t;
        else smoothPeak[i] -= PEAK_DECAY;
        if (smoothPeak[i] < 0) smoothPeak[i] = 0;
      }
      if (barCanvasNode !== null) drawBars(barCanvasNode, true);
    }
    let rafRunning = false;
    function startRaf() {
      if (rafRunning) return;
      rafRunning = true;
      const tick = () => { if (!rafRunning) return; rafId = requestAnimationFrame(tick); drawViz(); };
      tick();
    }
    function stopRaf() {
      rafRunning = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
    }

    // ---- player actions ----
    // Shuffle playback uses a pre-shuffled queue with a position pointer so
    // "next" plays an unplayed track and "prev" returns to the previously
    // played one, instead of random-without-repeat or list-order neighbors.
    let shuffleQueue = [];
    let shufflePos = -1;
    function buildShuffleQueue(anchorId) {
      const ids = store.tracks.map((t) => t.id);
      // Fisher-Yates
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
      }
      const a = anchorId !== undefined ? anchorId : store.currentId;
      if (a !== null && ids.includes(a)) {
        const ai = ids.indexOf(a);
        if (ai !== 0) { ids.splice(ai, 1); ids.unshift(a); }
      }
      shuffleQueue = ids;
      shufflePos = a !== null && ids[0] === a ? 0 : -1;
    }
    function syncShufflePos() {
      if (store.mode !== 'shuffle') return;
      if (store.currentId === null) return;
      if (shuffleQueue.length !== store.tracks.length || !shuffleQueue.includes(store.currentId)) {
        buildShuffleQueue(store.currentId);
        return;
      }
      shufflePos = shuffleQueue.indexOf(store.currentId);
    }
    function startPlay(id) {
      const track = trackById(id);
      if (track === null) return;
      audio.src = track.url;
      audio.load();
      set({ currentId: id, currentName: track.name, pendingId: null, pendingName: null, error: null });
      syncShufflePos();
      loadEnvelope(id, track.url);
      prefetchNext();
      savePlayback();
      const promise = audio.play();
      if (promise !== undefined && typeof promise.catch === 'function') {
        promise.catch(() => { set({ error: '\u6d4f\u89c8\u5668\u62e6\u622a\u4e86\u81ea\u52a8\u64ad\u653e\uff0c\u8bf7\u70b9\u51fb\u4e00\u6b21\u64ad\u653e\u6309\u94ae', pendingId: id, pendingName: track.name }); });
      }
    }
    function togglePlay() {
      if (store.pendingId !== null && store.currentId === null) { startPlay(store.pendingId); return; }
      if (store.currentId === null) { if (store.tracks.length > 0) startPlay(store.tracks[0].id); return; }
      if (audio.paused) {
        const promise = audio.play();
        if (promise !== undefined && typeof promise.catch === 'function') promise.catch(() => set({ error: '\u6d4f\u89c8\u5668\u62e6\u622a\u4e86\u81ea\u52a8\u64ad\u653e\uff0c\u8bf7\u70b9\u51fb\u64ad\u653e\u6309\u94ae' }));
      } else audio.pause();
    }
    function step(delta) {
      if (store.tracks.length === 0) return;
      if (store.mode === 'shuffle' && store.tracks.length > 1) {
        // Walk the shuffled queue: next plays the next unplayed track, prev
        // returns to the previously played one (not a list-order neighbor).
        if (shuffleQueue.length !== store.tracks.length
          || store.currentId === null || !shuffleQueue.includes(store.currentId)) {
          buildShuffleQueue(store.currentId);
        }
        const pos = shuffleQueue.indexOf(store.currentId);
        if (store.currentId === null) {
          // Nothing playing yet: start from the head of the shuffled queue.
          if (delta > 0) startPlay(shuffleQueue[0]);
          return;
        }
        if (delta > 0) {
          if (pos >= 0 && pos + 1 < shuffleQueue.length) {
            startPlay(shuffleQueue[pos + 1]);
          } else {
            // Round finished: reshuffle anchored on the current track so the
            // next play is a fresh unplayed one, not the track that just ended.
            buildShuffleQueue(store.currentId);
            startPlay(shuffleQueue.length > 1 ? shuffleQueue[1] : shuffleQueue[0]);
          }
        } else if (pos > 0) {
          startPlay(shuffleQueue[pos - 1]);
        } else {
          // Already at the head of the shuffled queue: replay the current track.
          startPlay(store.currentId);
        }
        return;
      }
      const idx = store.tracks.findIndex((t) => t.id === store.currentId);
      const nextIdx = idx < 0 ? 0 : (idx + delta + store.tracks.length) % store.tracks.length;
      startPlay(store.tracks[nextIdx].id);
    }
    function seekTo(seconds) {
      if (Number.isFinite(seconds)) { audio.currentTime = seconds; set({ position: seconds }); savePlayback(); }
    }
    function changeVolume(value) {
      const v = Math.min(1, Math.max(0, value));
      audio.volume = v;
      set({ volume: v });
    }
    function stop() {
      envReqId++;
      trackEnv = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      set({ currentId: null, currentName: null, playing: false, position: 0, duration: 0, pendingId: null, pendingName: null, vizState: 'ok' });
      clearPref(PREF_PLAYBACK);
    }

    function bindAudio() {
      const onTime = () => set({ position: audio.currentTime || 0 });
      const onDur = () => set({ duration: audio.duration || 0 });
      const onPlay = () => set({ playing: true, error: null });
      const onPause = () => { set({ playing: false }); savePlayback(); };
      const onEnded = () => {
        if (store.mode === 'single' && store.currentId !== null) {
          audio.currentTime = 0;
          const promise = audio.play();
          if (promise !== undefined && typeof promise.catch === 'function') promise.catch(() => set({ error: '\u64ad\u653e\u5931\u8d25', playing: false }));
          return;
        }
        step(1);
      };
      const onError = () => set({ error: '\u97f3\u9891\u52a0\u8f7d\u6216\u89e3\u7801\u5931\u8d25', playing: false });
      audio.addEventListener('timeupdate', onTime);
      audio.addEventListener('durationchange', onDur);
      audio.addEventListener('play', onPlay);
      audio.addEventListener('pause', onPause);
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      return () => {
        audio.pause();
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('durationchange', onDur);
        audio.removeEventListener('play', onPlay);
        audio.removeEventListener('pause', onPause);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
      };
    }

    function restorePlayback(list) {
      const saved = loadPlayback();
      if (saved === null) return;
      const track = list.find((t) => t.id === saved.id);
      if (track === undefined) return;
      audio.src = track.url;
      audio.load();
      const pos = Number.isFinite(saved.position) ? saved.position : 0;
      audio.currentTime = pos;
      set({ currentId: track.id, currentName: track.name, position: pos, pendingId: null, pendingName: null, error: null });
      savePlayback();
      loadEnvelope(track.id, track.url);
      prefetchNext();
    }

    // ---- host data ----
    async function loadTracks() {
      set({ loading: true });
      try {
        const result = await jsonGet('/dsh-music/manifest');
        const rememberedRoot = loadPref(PREF_ROOT);
        // If the host came up with the default root but this browser remembers
        // a different one (e.g. the host state file was not yet written on an
        // older restart), re-apply it so the chosen directory is restored.
        if (rememberedRoot !== null && rememberedRoot !== '' && result.root !== rememberedRoot) {
          saveRoot(rememberedRoot);
          return;
        }
        set({ root: result.root || null, tracks: result.tracks || [], count: result.count || 0, loading: false, error: result.error || null });
        const list = result.tracks || [];
        if (list.length > 0) {
          loadEnvelope(list[0].id, list[0].url, true);
          if (list.length > 1) loadEnvelope(list[1].id, list[1].url, true);
        }
        restorePlayback(list);
      } catch (err) {
        set({ loading: false, error: '\u65e0\u6cd5\u8bfb\u53d6\u97f3\u4e50\u5e93\uff1a' + String((err && err.message) || err) });
      }
    }
    function saveRoot(path) {
      set({ loading: true });
      fetch('/dsh-music/set-root', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      }).then((r) => r.json()).then((result) => {
        if (result && result.ok) {
          if (result.root) savePref(PREF_ROOT, result.root);
          set({ root: result.root || null, tracks: result.tracks || [], count: result.count || 0, loading: false, error: null });
          restorePlayback(result.tracks || []);
        } else {
          set({ loading: false, error: (result && result.error) || '\u8bbe\u7f6e\u76ee\u5f55\u5931\u8d25' });
        }
      }).catch((err) => {
        set({ loading: false, error: '\u8bbe\u7f6e\u76ee\u5f55\u5931\u8d25\uff1a' + String((err && err.message) || err) });
      });
    }

    function fmtTime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
    function MusicNote(props) {
      const cls = props.className || '';
      return React.createElement('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        React.createElement('path', { d: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z' }));
    }

    // ---- components ----
    // Custom vertical volume slider. The native <input type=range> cannot be
    // fully restyled in current Chrome (track keeps gray border lines and the
    // thumb ignores width/height once appearance:none is set), so the slider is
    // drawn with plain divs and driven by pointer events: click to jump, drag
    // the thumb to scrub. Value runs bottom (0) to top (1).
    function VolumeSlider() {
      const s = useStore();
      const trackRef = useRef(null);
      const draggingRef = useRef(false);
      const valueFor = (clientY) => {
        const el = trackRef.current;
        if (el === null) return s.volume;
        const r = el.getBoundingClientRect();
        if (r.height <= 0) return s.volume;
        const ratio = 1 - (clientY - r.top) / r.height;
        return Math.min(1, Math.max(0, ratio));
      };
      const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        changeVolume(valueFor(e.clientY));
      };
      const onPointerMove = (e) => {
        if (!draggingRef.current) return;
        changeVolume(valueFor(e.clientY));
      };
      const onPointerUp = (e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };
      const pct = Math.round(s.volume * 100);
      return React.createElement('div',
        { className: 'dsh-music-vol-slider', ref: trackRef,
          onPointerDown, onPointerMove, onPointerUp,
          title: '\u97f3\u91cf ' + pct + '%' },
        React.createElement('div', { className: 'dsh-music-vol-track' }),
        React.createElement('div', { className: 'dsh-music-vol-fill', style: { height: pct + '%' } }),
        React.createElement('div', { className: 'dsh-music-vol-thumb', style: { bottom: 'calc(' + pct + '% - 7px)' } }),
      );
    }
    function NowPlayingBar() {
      const s = useStore();
      const [volOpen, setVolOpen] = useState(false);
      const volRef = useRef(null);
      useEffect(() => {
        if (!volOpen) return;
        const onClick = (e) => { if (volRef.current !== null && !volRef.current.contains(e.target)) setVolOpen(false); };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
      }, [volOpen]);
      const hasTrack = s.currentName !== null || s.pendingName !== null;
      const name = s.currentName || s.pendingName;
      const showHint = s.pendingName !== null && s.currentId === null;
      const panelCls = 'dsh-music-mode-trigger' + (s.panelOpen ? ' active' : '');
      let vizBadge = null;
      if (hasTrack && s.vizState === 'unavailable') {
        vizBadge = React.createElement('button', {
          className: 'dsh-music-bar-warn',
          title: '\u9891\u8c31\u4e0d\u53ef\u7528\uff0c\u70b9\u51fb\u91cd\u8bd5',
          onClick: () => { const t = trackById(s.currentId); if (t !== null) loadEnvelope(t.id, t.url); },
        }, '\u9891\u8c31\u4e0d\u53ef\u7528\uff0c\u70b9\u51fb\u91cd\u8bd5');
      }
      const note = React.createElement(MusicNote, { className: 'dsh-music-note' });
      return React.createElement('div', { className: 'dsh-music-bar-wrap' },
        React.createElement('div', { className: 'dsh-music-bar' },
          hasTrack
            ? React.createElement('span', { className: 'dsh-music-bar-name', title: name }, note, ' ', name)
            : React.createElement('span', { className: 'dsh-music-bar-idle' }, note, ' \u672c\u5730\u97f3\u4e50\u64ad\u653e\u5668'),
          hasTrack && s.playing ? React.createElement('canvas', { className: 'dsh-music-viz', width: 64, height: 14, ref: (el) => { barCanvasNode = el; } }) : null,
          vizBadge,
          hasTrack
            ? (showHint
                ? React.createElement('span', { className: 'dsh-music-bar-hint' }, '\u26a0 \u81ea\u52a8\u64ad\u653e\u88ab\u62e6\u622a\uff0c\u70b9\u51fb\u25b6\u89e3\u9501')
                : React.createElement('span', { className: 'dsh-music-bar-time' }, fmtTime(s.position) + ' / ' + fmtTime(s.duration)))
            : null,
          hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '\u4e0a\u4e00\u9996', onClick: () => step(-1) }, '\u23ee') : null,
          hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '\u64ad\u653e/\u6682\u505c', onClick: togglePlay }, s.playing ? '\u23f8' : '\u25b6') : null,
          hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '\u4e0b\u4e00\u9996', onClick: () => step(1) }, '\u23ed') : null,
          hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '\u505c\u6b62', onClick: stop }, '\u23f9') : null,
          React.createElement(ModeDropdown, null),
          React.createElement('div', { className: 'dsh-music-bar-vol', ref: volRef },
            React.createElement('button', {
              className: 'dsh-music-mode-trigger' + (volOpen ? ' active' : ''),
              title: '\u97f3\u91cf',
              onClick: () => setVolOpen((o) => !o),
            }, React.createElement('svg', {
              viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
            }, React.createElement('path', { d: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z' }))),
            volOpen ? React.createElement('div', { className: 'dsh-music-bar-vol-pop' },
              React.createElement(VolumeSlider, null),
            ) : null,
          ),
          React.createElement('button', {
            className: panelCls,
            title: s.panelOpen ? '\u5173\u95ed\u64ad\u653e\u5217\u8868' : '\u6253\u5f00\u64ad\u653e\u5217\u8868',
            onClick: () => set({ panelOpen: !s.panelOpen }),
          }, React.createElement('svg', {
            viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
          }, React.createElement('path', {
            d: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
          }))),
        ),
      );
    }
    // Playback-mode metadata + an icon-only dropdown. Icons are inline SVGs filled
    // with currentColor so they match the accent of the other round transport
    // buttons (green), which a native <select> cannot color.
    const MODES = [
      { id: 'single', label: '\u5355\u66f2\u5faa\u73af', title: '\u5355\u66f2\u5faa\u73af\uff1a\u64ad\u653e\u7ed3\u675f\u91cd\u590d\u5f53\u524d\u66f2\u76ee', d: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z' },
      { id: 'order', label: '\u987a\u5e8f\u64ad\u653e', title: '\u987a\u5e8f\u64ad\u653e\uff1a\u81ea\u52a8\u64ad\u653e\u5217\u8868\u4e2d\u7684\u4e0b\u4e00\u9996', d: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm14-10v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z' },
      { id: 'shuffle', label: '\u4e71\u5e8f\u64ad\u653e', title: '\u4e71\u5e8f\u64ad\u653e\uff1a\u968f\u673a\u6311\u9009\u4e0b\u4e00\u9996', d: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z' },
    ];
    function ModeIcon(props) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
      }, React.createElement('path', { d: props.d }));
    }
    function ModeDropdown() {
      const s = useStore();
      const [open, setOpen] = useState(false);
      const ref = useRef(null);
      useEffect(() => {
        if (!open) return;
        const onClick = (e) => { if (ref.current !== null && !ref.current.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
      }, [open]);
      const cur = MODES.find((m) => m.id === s.mode) || MODES[1];
      // Right-align the mode+volume+panel cluster when there is no track: during
      // playback the time span already carries margin-left:auto to push these
      // right, so only apply the auto margin when a name/pending name is absent.
      const barRight = s.currentName === null && s.pendingName === null;
      return React.createElement('div',
        { className: 'dsh-music-mode-menu' + (barRight ? ' right' : ''), ref },
        React.createElement('button', {
          className: 'dsh-music-mode-trigger' + (open ? ' active' : ''),
          title: cur.label,
          onClick: () => setOpen((o) => !o),
        }, React.createElement(ModeIcon, { d: cur.d })),
        open ? React.createElement('div', { className: 'dsh-music-mode-pop' },
          MODES.map((m) => React.createElement('button', {
            key: m.id,
            className: 'dsh-music-mode-item' + (s.mode === m.id ? ' active' : ''),
            title: m.title,
            onClick: () => { set({ mode: m.id }); setOpen(false); },
          }, React.createElement(ModeIcon, { d: m.d }))),
        ) : null,
      );
    }
    function PlayerPanel() {
      const s = useStore();
      const listRef = useRef(null);
      const panelRef = useRef(null);
      // Draggable panel position ({x, y, h} left/top/height once dragged; null = default right/bottom)
      const [pos, setPos] = useState(loadPanelPos);
      const dragRef = useRef(null);

      // Once the panel is dragged we switch from CSS right/bottom anchoring to an
      // explicit left/top/height. Locking the height matters: with only top+left set
      // and no height, a fixed element whose CSS also sets bottom collapses to fit
      // the leftover space, so the panel's height jumps while dragging.
      const style = pos === null ? null : { left: pos.x, top: pos.y, height: pos.h };

      const onHeadDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        // don't start a drag from the close button
        if (e.target.closest && e.target.closest('.dsh-music-icon-btn')) return;
        const el = panelRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const h = pos !== null ? pos.h : rect.height;
        const next = { x: pos !== null ? pos.x : rect.left, y: pos !== null ? pos.y : rect.top, h };
        dragRef.current = {
          startX: e.clientX, startY: e.clientY,
          originX: next.x, originY: next.y, h,
        };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
        e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onHeadMove = (e) => {
        const d = dragRef.current;
        if (d === null) return;
        let x = d.originX + (e.clientX - d.startX);
        let y = d.originY + (e.clientY - d.startY);
        const el = panelRef.current;
        if (el !== null) {
          x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
          y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
        }
        const next = { x, y, h: d.h };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
      };
      const onHeadUp = (e) => {
        dragRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };

      useEffect(() => {
        if (!s.panelOpen) return;
        // Close the playlist panel when the user clicks outside it
        // (mousedown precedes the toggle's click, so both stay consistent).
        const onDown = (e) => {
          if (panelRef.current !== null && !panelRef.current.contains(e.target)) set({ panelOpen: false });
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [s.panelOpen]);
      useEffect(() => {
        if (!s.panelOpen) return;
        const list = listRef.current;
        if (list === null) return;
        const active = list.querySelector('.dsh-music-track.active');
        if (active !== null && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
      }, [s.panelOpen, s.currentId]);
      if (!s.panelOpen) return null;
      const rows = s.tracks.map((t) => {
        const active = t.id === s.currentId;
        const playing = active && s.playing;
        return React.createElement('button', {
          key: t.id,
          className: 'dsh-music-track' + (active ? ' active' : ''),
          title: t.url,
          onClick: () => { if (active) togglePlay(); else startPlay(t.id); },
        },
          React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '\u25b6 ' : '') + t.name),
          React.createElement('span', { className: 'dsh-music-track-size' }, t.size ? Math.round(t.size / 1024 / 1024 * 10) / 10 + ' MB' : ''),
        );
      });
      return React.createElement('div', { className: 'dsh-music-panel', ref: panelRef, style },
        React.createElement('div', {
          className: 'dsh-music-panel-head dsh-music-panel-drag',
          onPointerDown: onHeadDown, onPointerMove: onHeadMove, onPointerUp: onHeadUp,
        },
          React.createElement('span', { className: 'dsh-music-panel-grip', 'aria-hidden': true }, '\u283f'),
          React.createElement('span', { className: 'dsh-music-panel-title' }, '\u64ad\u653e\u5217\u8868'),
          React.createElement('button', { className: 'dsh-music-icon-btn', title: '\u5173\u95ed', onClick: () => set({ panelOpen: false }) }, '\u2715')),
        React.createElement(DirectorySetting, null),
        s.error ? React.createElement('div', { className: 'dsh-music-error' }, s.error) : null,
        s.loading ? React.createElement('div', { className: 'dsh-music-loading' }, '\u626b\u63cf\u4e2d\u2026') : null,
        React.createElement('div', { className: 'dsh-music-list', ref: (el) => { listRef.current = el; } },
          rows.length > 0 ? rows : React.createElement('div', { className: 'dsh-music-empty' }, '\u6682\u65e0\u97f3\u4e50\u3002\u70b9\u51fb\u4e0a\u65b9\u201c\u9009\u62e9\u97f3\u4e50\u76ee\u5f55\u201d\u5e76\u9009\u62e9\u76ee\u5f55\u540e\u81ea\u52a8\u626b\u63cf\u3002')),
      );
    }
    // Directory setting block, embedded in the player panel (the former
    // 设置 → 音乐播放器 page moved in-panel so all library config lives in one place).
    function DirectorySetting() {
      const s = useStore();
      const [pickerOpen, setPickerOpen] = useState(false);
      const [dirs, setDirs] = useState([]);
      const [curPath, setCurPath] = useState('');
      const [curName, setCurName] = useState('');
      const [curUp, setCurUp] = useState(null);
      const [dirError, setDirError] = useState(null);
      return React.createElement('div', { className: 'dsh-music-settings' },
        React.createElement('div', { className: 'dsh-music-settings-row' },
          React.createElement('span', { className: 'dsh-music-settings-cur', title: s.root || '' },
            '\ud83d\udcc1 ' + (s.root || '\u672a\u914d\u7f6e')),
          React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => openPicker() }, '\u9009\u62e9\u97f3\u4e50\u76ee\u5f55')),
        s.error ? React.createElement('p', { className: 'dsh-music-error' }, s.error) : null,
        React.createElement('p', { className: 'dsh-music-hint' }, '\u652f\u6301 mp3 / m4a / flac / wav / ogg / opus / aac / webm \u7b49\u683c\u5f0f\uff0c\u81ea\u52a8\u9012\u5f52\u626b\u63cf\u5b50\u76ee\u5f55\u3002'),
        pickerOpen ? React.createElement('div', { className: 'dsh-music-picker-overlay' },
          React.createElement('div', { className: 'dsh-music-picker' },
            React.createElement('div', { className: 'dsh-music-picker-head' },
              React.createElement('span', { className: 'dsh-music-picker-title' }, '\u9009\u62e9\u97f3\u4e50\u76ee\u5f55')),
            React.createElement('div', { className: 'dsh-music-picker-cur', title: curPath },
              curName || curPath || '\u5bb6\u76ee\u5f55'),
            React.createElement('div', { className: 'dsh-music-picker-list' },
              dirs.length > 0
                ? dirs.map((d) => React.createElement('button', {
                  key: d.path,
                  className: 'dsh-music-picker-item',
                  title: d.path,
                  onClick: () => browse(d.path),
                }, '\ud83d\udcc1 ' + d.name))
                : React.createElement('div', { className: 'dsh-music-picker-empty' }, '\u672c\u76ee\u5f55\u4e0b\u65e0\u5b50\u76ee\u5f55\uff0c\u53ef\u76f4\u63a5\u9009\u62e9\u3002'),
              dirError ? React.createElement('div', { className: 'dsh-music-error' }, dirError) : null,
            ),
            React.createElement('div', { className: 'dsh-music-picker-foot' },
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => goUp() }, '\u8fd4\u56de\u4e0a\u7ea7'),
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => pickCurrent() }, '\u9009\u62e9\u6b64\u76ee\u5f55'),
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => setPickerOpen(false) }, '\u53d6\u6d88'),
            ),
          ),
        ) : null,
      );
      function openPicker() {
        setPickerOpen(true);
        setDirError(null);
        // Open directly at the currently configured root so the user sees the
        // existing choice first; fall back to the home directory when unset.
        browse(s.root || '');
      }
      async function browse(path) {
        setDirError(null);
        try {
          const data = await jsonGet('/dsh-music/dir?path=' + encodeURIComponent(path || ''));
          if (data && data.error) { setDirError(data.error); return; }
          setCurPath(data.path || '');
          setCurName(data.name || '');
          setCurUp(data.up || null);
          setDirs(data.dirs || []);
        } catch (err) {
          setDirError('读取目录失败：' + String((err && err.message) || err));
        }
      }
      function goUp() {
        // Prefer the parent path computed by the host (correct separators per OS).
        // At a drive root the host reports the "__drives__" sentinel, so "up"
        // jumps to the drive list and lets the user switch disks.
        if (curUp === '__drives__') { browse('__drives__'); return; }
        if (curUp !== null && curUp !== undefined && curUp !== '') { browse(curUp); return; }
        // fallback: derive the parent locally when the host omitted `up`.
        // Handle both "\" and "/" so Windows paths never dead-end (the old
        // POSIX-only parse did nothing on backslash paths like C:\Users\x).
        if (curPath === '' || curPath === '/' || /^[A-Za-z]:[\\/]?$/.test(curPath)) return;
        const idx = Math.max(curPath.lastIndexOf('/'), curPath.lastIndexOf('\\'));
        if (idx <= 0) return;
        browse(curPath.slice(0, idx));
      }
      function pickCurrent() {
        const p = curPath;
        // The drive-list view ("__drives__") is not a real directory.
        if (p === '' || p === '__drives__') return;
        setPickerOpen(false);
        saveRoot(p);
      }
    }

    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-music-player');
        styleEl.textContent = PLAYER_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      });

      ctx.effect(() => {
        const unbind = bindAudio();
        startRaf();
        return () => { stopRaf(); unbind(); closeDecodeCtx(); };
      }, 'music-player: audio + viz engine');

      loadTracks();

      const intentTimer = setInterval(() => {
        jsonGet('/dsh-music/intent').then((intent) => {
          if (intent === null || typeof intent !== 'object' || intent.id === undefined) return;
          set({ pendingId: intent.id, pendingName: intent.name || '' });
          const track = trackById(intent.id);
          if (track !== null) {
            audio.src = track.url;
            audio.load();
            set({ currentId: intent.id, currentName: track.name, error: null });
            loadEnvelope(intent.id, track.url);
            prefetchNext();
            savePlayback();
            const promise = audio.play();
            if (promise !== undefined && typeof promise.catch === 'function') {
              promise.catch(() => set({ error: '\u6d4f\u89c8\u5668\u62e6\u622a\u4e86\u81ea\u52a8\u64ad\u653e\uff0c\u8bf7\u5728\u64ad\u653e\u6761\u70b9\u51fb\u25b6\u89e3\u9501', pendingId: intent.id, pendingName: track.name }));
            }
          }
        }).catch(() => {});
      }, 2000);

      ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'music-player-bar', order: 40 },
        () => React.createElement(NowPlayingBar),
      )), 'music-player: now playing bar');
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'music-player-panel', order: 20 },
        () => React.createElement(PlayerPanel),
      )), 'music-player: overlay panel');

      ctx.effect(() => () => clearInterval(intentTimer), 'music-player: intent poll stop');
    }

    exports.apply = apply;
    exports.inject = inject;

    // ---- CSS ----
    const PLAYER_CSS = '\n' +
      '.dsh-music-bar-wrap { box-sizing: border-box; width: 100%; padding: 0 var(--dsh-composer-side-clearance, 16px); }\n' +
      '.dsh-music-bar { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; max-width: var(--dsh-composer-card-max-width, 780px); margin: 0 auto; padding: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius: 8px; }\n' +
      '.dsh-music-bar-idle { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 500; display: inline-flex; align-items: center; }\n' +
      '.dsh-music-bar-name { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; min-width: 0; }\n' +
      '.dsh-music-note { color: var(--dsh-music-accent, #2f9e6e); flex: none; margin-right: 4px; }\n' +
      '.dsh-music-viz { flex: none; width: 64px; height: 14px; }\n' +
      '.dsh-music-bar-warn { background: transparent; border: none; color: var(--dsw-alias-state-warn-primary, #d9a441); font-size: 12px; cursor: pointer; padding: 0; white-space: nowrap; }\n' +
      '.dsh-music-bar-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; height: 20px; background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 4px; border-radius: 4px; }\n' +
      '.dsh-music-bar-btn:hover { color: var(--dsw-alias-brand-primary, #4f8cff); }\n' +
      '.dsh-music-bar-btn.active { color: var(--dsw-alias-brand-primary, #4f8cff); }\n' +
      '.dsh-music-bar-vol { position: relative; flex: none; display: inline-flex; align-self: center; }\n' +
      '.dsh-music-bar-vol-pop { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); display: flex; align-items: center; justify-content: center; width: 36px; height: 108px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,0.3); z-index: 60; }\n' +
      '.dsh-music-vol-slider { position: relative; width: 24px; height: 84px; cursor: pointer; touch-action: none; }\n' +
      '.dsh-music-vol-track { position: absolute; left: 50%; top: 0; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.14)); }\n' +
      '.dsh-music-vol-fill { position: absolute; left: 50%; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-vol-thumb { position: absolute; left: 50%; transform: translateX(-50%); width: 14px; height: 14px; border-radius: 50%; background: var(--dsh-music-accent, #2f9e6e); box-shadow: 0 1px 3px rgba(0,0,0,0.4); }\n' +
      '.dsh-music-bar-time { margin-left: auto; line-height: 1; font-variant-numeric: tabular-nums; }\n' +
      '.dsh-music-bar-hint { margin-left: auto; color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger { width: 24px; height: 24px; }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger svg { flex: none; }\n' +
      '.dsh-music-bar .dsh-music-mode-menu { align-self: center; }\n' +
      '.dsh-music-panel { position: fixed; right: 24px; bottom: 84px; width: 380px; max-height: 72vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 1000; pointer-events: auto; overflow: hidden; }\n' +
      '.dsh-music-panel-head { display: flex; align-items: center; gap: 6px; }\n' +
      '.dsh-music-panel-drag { cursor: move; touch-action: none; user-select: none; }\n' +
      '.dsh-music-panel-grip { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; letter-spacing: -1px; opacity: 0.7; }\n' +
      '.dsh-music-panel-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-icon-btn { background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }\n' +
      '.dsh-music-icon-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-panel-root { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-mode-menu { position: relative; flex: none; }\n' +
      '.dsh-music-mode-menu.right { margin-left: auto; }\n' +
      '.dsh-music-mode-trigger { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; }\n' +
      '.dsh-music-mode-trigger:hover, .dsh-music-mode-trigger.active { background: var(--dsh-music-accent, #2f9e6e); color: #fff; }\n' +
      '.dsh-music-mode-pop { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% + 6px); z-index: 60; display: flex; flex-direction: column; gap: 4px; padding: 6px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-mode-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; }\n' +
      '.dsh-music-mode-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-mode-item.active { background: var(--dsh-music-accent, #2f9e6e); color: #fff; }\n' +
      '.dsh-music-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; min-height: 60px; max-height: 40vh; }\n' +
      '.dsh-music-track { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-track:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-track.active { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-track-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-track-size { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-empty { padding: 12px; text-align: center; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      '.dsh-music-error { color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 12px; }\n' +
      '.dsh-music-loading { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      '.dsh-music-settings { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.dsh-music-settings-row { display: flex; gap: 8px; align-items: center; }\n' +
      '.dsh-music-settings-cur { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn { padding: 6px 12px; border-radius: 8px; border: none; background: var(--dsh-music-accent, #2f9e6e); color: #fff; cursor: pointer; font-size: 13px; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn.ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-picker-overlay { position: absolute; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); }\n' +
      '.dsh-music-picker { box-sizing: border-box; width: 88%; max-height: 80%; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-picker-head { display: flex; align-items: center; }\n' +
      '.dsh-music-picker-title { font-weight: 600; }\n' +
      '.dsh-music-picker-cur { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-picker-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-picker-item { text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-picker-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-picker-empty { padding: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-picker-foot { display: flex; gap: 8px; justify-content: flex-end; }\n' +
      '.dsh-music-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n';

    return module.exports;
  },
});
