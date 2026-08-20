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

    // This host/environment throws a harmless, unhandled rejection from
    // Chromium's media pipeline — "Cannot read properties of undefined (reading
    // 'getTopURL')" — whenever an <audio> element loads or plays. Playback and
    // position handling are unaffected, so swallow just that specific error to
    // keep the console clean. Registered at module scope (before any media op)
    // and covering all three surfacing paths.
    (() => {
      const isGetTopUrl = (value) => {
        try { return String((value && value.message) || value || '').indexOf('getTopURL') !== -1; } catch { return false; }
      };
      window.addEventListener('unhandledrejection', (ev) => {
        if (isGetTopUrl(ev && ev.reason)) ev.preventDefault();
      });
      window.addEventListener('error', (ev) => {
        if (isGetTopUrl(ev && ev.message)) ev.preventDefault();
      });
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        const origError = console.error.bind(console);
        console.error = (...args) => {
          if (args.some(isGetTopUrl)) return;
          origError(...args);
        };
      }
    })();

    // ---- persisted prefs / playback ----
    const PREF_MODE = 'dsh-music-mode';
    const PREF_VOL = 'dsh-music-volume';
    const PREF_PLAYBACK = 'dsh-music-playback';
    const PREF_BOOKS_PLAYBACK = 'dsh-music-books-playback';
    const PREF_ROOT = 'dsh-music-root';
    const PREF_PANEL_POS = 'dsh-music-panel-pos';
    const PREF_VOICE = 'dsh-music-voice';
    const PREF_SCOPE = 'dsh-music-scope';
    const loadPref = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const savePref = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
    const clearPref = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
    // ---- per-book novel progress (independent from music) ----
    // Every novel remembers its own position, keyed by its filename, so switching
    // between books — or to music — never loses another book's place. Music
    // progress lives in PREF_PLAYBACK and this subsystem never touches it.
    const PREF_BOOK_PLAYBACK = 'dsh-music-book-playback'; // legacy single-book key
    function readBooksPlayback() {
      try {
        const raw = loadPref(PREF_BOOKS_PLAYBACK);
        if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object') return o; }
      } catch (e) {}
      return {};
    }
    function writeBooksPlayback(map) { savePref(PREF_BOOKS_PLAYBACK, JSON.stringify(map)); }
    function getBookPlayback(name) { return readBooksPlayback()[name] || null; }
    function clearBookPlayback(name) {
      const map = readBooksPlayback();
      if (Object.prototype.hasOwnProperty.call(map, name)) { delete map[name]; writeBooksPlayback(map); }
    }
    // Persist the currently playing novel's position into the per-book map.
    function saveCurrentBookPlayback() {
      const id = currentBookId();
      if (id === null) return;
      const book = bookById(id);
      if (book === null) return;
      const map = readBooksPlayback();
      map[book.name] = {
        from: bookFromRef, base: bookBaseTime,
        pos: audio.currentTime || 0, total: bookTotal,
        ts: Date.now(),
      };
      writeBooksPlayback(map);
    }
    // The most recently played novel (largest ts), used by refresh restore.
    function latestBookPlayback() {
      const map = readBooksPlayback();
      let best = null, bestTs = -1;
      for (const [name, e] of Object.entries(map)) {
        if (e && typeof e.from === 'number' && e.ts > bestTs) { best = { name, ...e }; bestTs = e.ts; }
      }
      return best;
    }
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
    // Attach the media element to the document (hidden) so it has a proper DOM /
    // document association (some browsers handle attached media elements more
    // predictably). body may not exist yet at module eval, so defer the attach
    // until apply() runs (body is ready there).
    let audioAttached = false;
    function attachAudioElements() {
      if (audioAttached) return;
      audioAttached = true;
      try {
        audio.style.display = 'none';
        preAudio.style.display = 'none';
        if (audio.parentNode === null) document.body.appendChild(audio);
        if (preAudio.parentNode === null) document.body.appendChild(preAudio);
      } catch (e) { /* non-fatal */ }
    }

    // Autoplay unlock without touching the playing <audio> element (which would
    // interrupt playback). Browsers block <audio>.play() once the synchronous
    // user gesture is gone — which is what happens after the async TTS synthesis
    // takes a second or two. Calling audioCtx.resume() synchronously inside the
    // click grants the page sticky audio activation, so the later async play()
    // is allowed. On macOS the context usually runs anyway; on Windows/Chrome
    // this resume is what makes auto-play work.
    let unlockCtx = null;
    function unlockAutoplay() {
      try {
        if (unlockCtx === null) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor === undefined) return;
          unlockCtx = new Ctor();
        }
        if (unlockCtx.state === 'suspended') {
          const p = unlockCtx.resume();
          if (p && p.catch) p.catch(() => {});
        }
      } catch { /* unlock is best-effort */ }
    }

    const store = {
      root: null, tracks: [], books: [], count: 0, currentId: null, currentName: null,
      playing: false, position: 0, duration: 0, volume: 0.8,
      panelOpen: false, loading: false, error: null, pendingId: null, pendingName: null,
      mode: 'order', vizState: 'ok', tab: 'music', ttsConfigured: false, ttsReason: '',
      bookBuffering: false, bookError: '', bookBufferingSince: 0, bookBufferingSilent: false,
      // chapter table of contents (book reader): section list of the current book,
      // whether the toc popup is open, and the heading of the section now playing.
      tocOpen: false, bookToc: [], currentSection: '',
      // AI 讲书 TTS voice: available voices come from /manifest, the selection
      // persists in localStorage and rides the chunk URL so the host re-synthesizes.
      // voiceSwitching = a new voice is being synthesized in the background.
      voices: [], voice: '白桦', voiceSwitching: false,
      // 自建歌单：manifest.playlists 即数据源；scope 为当前播放范围（曲库/歌单），
      // subTab 为音乐页内的子标签（'library' 或歌单 id）。
      playlists: [], scope: { kind: 'library' }, subTab: 'library',
    };
    const listeners = new Set();
    function set(patch) {
      Object.assign(store, patch);
      if ('mode' in patch) savePref(PREF_MODE, patch.mode);
      if ('volume' in patch) savePref(PREF_VOL, String(patch.volume));
      if ('voice' in patch) savePref(PREF_VOICE, patch.voice);
      if ('scope' in patch) savePref(PREF_SCOPE, JSON.stringify(patch.scope));
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

    // ---- 自建歌单：范围 / 解析 / 收藏 ----
    const FAV_PLAYLIST_ID = 'pl-fav';
    const playlistById = (id) => (store.playlists || []).find((p) => p.id === id) || null;
    // 解析任意可播放对象：歌单成员 id（'p:'+path）优先，其次曲库曲目。
    function resolvePlayable(id) {
      if (id === null || id === undefined) return null;
      if (String(id).startsWith('p:')) {
        for (const p of store.playlists || []) {
          const m = (p.tracks || []).find((t) => t.id === id);
          if (m) return m;
        }
        return null;
      }
      return trackById(id);
    }
    // 当前范围的有序 id 列表：歌单非空则用歌单，否则回退曲库（空/已删歌单优雅回退）。
    function activeIds() {
      const s = store.scope || { kind: 'library' };
      if (s.kind === 'playlist') {
        const pl = playlistById(s.id);
        if (pl && pl.tracks && pl.tracks.length > 0) return pl.tracks.map((t) => t.id);
        return (store.tracks || []).map((t) => t.id);
      }
      return (store.tracks || []).map((t) => t.id);
    }
    function scopeKey() {
      const s = store.scope || { kind: 'library' };
      return s.kind === 'playlist' ? 'pl:' + s.id : 'lib';
    }
    // 当前播放曲目对应的绝对路径（用于收藏判断）。
    function currentTrackPath() {
      if (store.currentId === null) return null;
      if (String(store.currentId).startsWith('p:')) return String(store.currentId).slice(2);
      const t = trackById(store.currentId);
      return t && t.path ? t.path : null;
    }
    function isCurrentFaved() {
      const path = currentTrackPath();
      if (path === null) return false;
      const fav = playlistById(FAV_PLAYLIST_ID);
      return fav !== null && (fav.tracks || []).some((m) => m.path === path);
    }
    function updatePlaylistInStore(pl) {
      if (!pl || !pl.id) return;
      set({ playlists: (store.playlists || []).map((p) => (p.id === pl.id ? pl : p)) });
    }
    function apiPlaylistAdd(id, paths, then) {
      fetch('/dsh-music/playlist/add', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paths }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); if (then) then(r); }).catch(() => {});
    }
    function apiPlaylistRemove(id, paths, then) {
      fetch('/dsh-music/playlist/remove', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paths }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); if (then) then(r); }).catch(() => {});
    }
    function apiPlaylistReorder(id, paths) {
      fetch('/dsh-music/playlist/reorder', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paths }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); }).catch(() => {});
    }
    // 收藏切换：加入/移出「我最喜欢」。
    function toggleFav() {
      const path = currentTrackPath();
      if (path === null) return;
      const fav = playlistById(FAV_PLAYLIST_ID);
      if (fav === null) return;
      if (isCurrentFaved()) apiPlaylistRemove(FAV_PLAYLIST_ID, [path]);
      else apiPlaylistAdd(FAV_PLAYLIST_ID, [path]);
    }
    // 从歌单/曲库点歌：来源即范围。
    function startPlayFrom(id, kind, plId) {
      if (kind === 'playlist') set({ scope: { kind: 'playlist', id: plId } });
      else set({ scope: { kind: 'library' } });
      startPlay(id);
    }
    // 歌单管理：新建 / 重命名 / 删除 / 移动歌曲。
    function onCreatePlaylist() {
      const name = window.prompt('新建歌单名称', '');
      if (name === null) return;
      const trimmed = name.trim();
      if (trimmed === '') return;
      fetch('/dsh-music/playlist', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      }).then((r) => r.json()).then((r) => {
        if (r && r.playlist) {
          set({ playlists: [...(store.playlists || []), r.playlist], subTab: r.playlist.id });
        }
      }).catch(() => {});
    }
    function onRenamePlaylist(pl) {
      const name = window.prompt('重命名歌单「' + pl.name + '」', pl.name);
      if (name === null) return;
      const trimmed = name.trim();
      if (trimmed === '' || trimmed === pl.name) return;
      fetch('/dsh-music/playlist/rename', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: pl.id, name: trimmed }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); }).catch(() => {});
    }
    function onDeletePlaylist(pl) {
      if (!window.confirm('删除歌单「' + pl.name + '」？歌曲文件不会被删除。')) return;
      fetch('/dsh-music/playlist/delete', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: pl.id }),
      }).then((r) => r.json()).then((r) => {
        if (r && r.ok) {
          const next = (store.playlists || []).filter((p) => p.id !== pl.id);
          set({ playlists: next, subTab: 'library' });
          if (store.scope && store.scope.kind === 'playlist' && store.scope.id === pl.id) {
            set({ scope: { kind: 'library' } });
          }
        }
      }).catch(() => {});
    }
    // 一键清空歌单（任何歌单都可用，含系统「我最喜欢」；仅从歌单移除，不删文件）。
    function onClearPlaylist(pl) {
      const n = (pl.tracks || []).length;
      if (n === 0 && !pl.missing) return;
      if (!window.confirm('清空歌单「' + pl.name + '」？将移除全部 ' + n + ' 首歌曲' + (pl.missing > 0 ? '（另有 ' + pl.missing + ' 首已失效一并清除）' : '') + '，歌曲文件不会被删除。')) return;
      fetch('/dsh-music/playlist/clear', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: pl.id }),
      }).then((r) => r.json()).then((r) => {
        if (r && r.playlist) updatePlaylistInStore(r.playlist);
      }).catch(() => {});
    }
    function movePlaylistTrack(pl, path, dir) {
      const paths = (pl.tracks || []).map((t) => t.path);
      const i = paths.indexOf(path);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= paths.length) return;
      const next = paths.slice();
      const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
      apiPlaylistReorder(pl.id, next);
    }

    // restore persisted prefs
    try {
      const m = loadPref(PREF_MODE);
      if (m === 'single' || m === 'order' || m === 'shuffle') store.mode = m;
      const v = parseFloat(loadPref(PREF_VOL));
      if (Number.isFinite(v)) { store.volume = Math.min(1, Math.max(0, v)); audio.volume = store.volume; }
      const voice = loadPref(PREF_VOICE);
      if (typeof voice === 'string' && voice !== '') store.voice = voice;
    } catch (e) {}

    // Migrate legacy single-book progress (pre-0.2.1) into the per-book map once.
    try {
      const legacy = loadPref(PREF_BOOK_PLAYBACK);
      if (legacy) {
        const p = JSON.parse(legacy);
        if (p && typeof p.id === 'string' && typeof p.name === 'string' && p.name !== '') {
          const map = readBooksPlayback();
          if (!Object.prototype.hasOwnProperty.call(map, p.name)) {
            map[p.name] = { from: p.from, base: p.base, pos: p.pos, total: p.total, ts: p.ts || Date.now() };
            writeBooksPlayback(map);
          }
        }
        clearPref(PREF_BOOK_PLAYBACK);
      }
    } catch (e) {}

    // Persist the current playback position. Music and novels are fully separate:
    // music writes PREF_PLAYBACK, novels write into the per-book map — neither
    // clears the other, so switching modes never loses progress.
    function savePlayback() {
      if (store.currentId === null) { clearPref(PREF_PLAYBACK); return; }
      if (String(store.currentId).startsWith('book:')) { saveCurrentBookPlayback(); return; }
      savePref(PREF_PLAYBACK, JSON.stringify({
        id: store.currentId, name: store.currentName,
        // While a restored track is still paused, the <audio> currentTime can
        // transiently read 0 — never persist that over the restored position.
        position: (restoredMusicPos !== null && restoredMusicPos > 0) ? restoredMusicPos : (audio.currentTime || 0),
        // Persist the known duration too: on restore the browser may not have
        // loaded the track's metadata yet, and we don't want a "0:00" readout.
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        ts: Date.now(),
      }));
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
      const ids = activeIds();
      if (ids.length === 0 || store.currentId === null) return;
      let nextId = null;
      if (store.mode === 'shuffle') {
        // Prefetch the queued next track so a shuffle "next" starts instantly.
        ensureShuffleReady();
        if (shuffleQueue.length === ids.length) {
          const pos = shuffleQueue.indexOf(store.currentId);
          if (pos >= 0 && pos + 1 < shuffleQueue.length) nextId = shuffleQueue[pos + 1];
        }
      } else {
        const idx = ids.indexOf(store.currentId);
        const next = ids[(idx + 1) % ids.length];
        if (next !== undefined) nextId = next;
      }
      if (nextId !== null) {
        const next = resolvePlayable(nextId);
        if (next !== undefined && !envCache.has(next.id)) loadEnvelope(next.id, next.url, true);
      }
    }

    // ---- bar color + canvas drawing ----
    let barCanvasNode = null;
    let rafId = null;
    const smoothCur = new Float32Array(SMOOTH_BARS);
    const smoothPeak = new Float32Array(SMOOTH_BARS);
    const targetBuf = new Float32Array(SMOOTH_BARS);
    // Accent color for the spectrum bars. DSH defines its --dsw-alias-* theme
    // tokens on <body> — never on :root — so --dsh-music-accent must be read
    // from body (reading documentElement would always return the fallback and
    // the bars would never follow the theme). The value is cached but the cache
    // is invalidated whenever the theme changes at runtime: the ThemePresenter
    // projects tokens + the dark attribute onto body, so a MutationObserver on
    // body's style/dark-attribute keeps the bars tracking live brand changes.
    let accentColor = null;
    let accentObserver = null;
    function readAccent() {
      const el = document.body || document.documentElement;
      return getComputedStyle(el).getPropertyValue('--dsh-music-accent').trim() || '#2f9e6e';
    }
    function currentAccent() {
      if (accentColor === null) accentColor = readAccent();
      return accentColor;
    }
    function watchAccent() {
      if (accentObserver !== null) return accentObserver;
      if (typeof MutationObserver === 'undefined') return null;
      accentObserver = new MutationObserver(() => { accentColor = readAccent(); });
      accentObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme'] });
      return accentObserver;
    }
    function drawBars(canvas, useCaps) {
      const c = canvas.getContext('2d');
      const w = canvas.width; const h = canvas.height;
      c.clearRect(0, 0, w, h);
      const gap = 2;
      const bw = (w - gap * (SMOOTH_BARS - 1)) / SMOOTH_BARS;
      const color = currentAccent();
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
    let shuffleScopeKey = null;
    function buildShuffleQueue(anchorId) {
      const ids = activeIds();
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
      shuffleScopeKey = scopeKey();
      shufflePos = a !== null && ids[0] === a ? 0 : -1;
    }
    // 确保乱序队列与当前范围一致（范围切换后自动重建）。
    function ensureShuffleReady() {
      if (store.mode !== 'shuffle') return;
      const ids = activeIds();
      if (shuffleScopeKey !== scopeKey() || shuffleQueue.length !== ids.length
        || (store.currentId !== null && !shuffleQueue.includes(store.currentId))) {
        buildShuffleQueue(store.currentId);
      }
      if (store.currentId !== null) shufflePos = shuffleQueue.indexOf(store.currentId);
    }
    function syncShufflePos() {
      if (store.mode !== 'shuffle') return;
      ensureShuffleReady();
    }
    function startPlay(id) {
      const track = resolvePlayable(id);
      if (track === null) return;
      restoredMusicPos = null;
      bookRestorePos = -1;
      audio.src = track.url;
      audio.load();
      set({ currentId: id, currentName: track.name, pendingId: null, pendingName: null, error: null, tocOpen: false, currentSection: '' });
      syncShufflePos();
      loadEnvelope(id, track.url);
      prefetchNext();
      savePlayback();
      const promise = audio.play();
      if (promise !== undefined && typeof promise.catch === 'function') {
        promise.catch(() => { set({ error: '\u6d4f\u89c8\u5668\u62e6\u622a\u4e86\u81ea\u52a8\u64ad\u653e\uff0c\u8bf7\u70b9\u51fb\u4e00\u6b21\u64ad\u653e\u6309\u94ae', pendingId: id, pendingName: track.name }); });
      }
    }
    const bookById = (id) => (store.books || []).find((b) => b.id === id) || null;
    const currentBookId = () => (store.currentId !== null && String(store.currentId).startsWith('book:'))
      ? String(store.currentId).slice('book:'.length)
      : null;
    // Re-synthesize / replay the current chunk after an error.
    function retryBook() {
      const id = currentBookId();
      if (id !== null) {
        unlockAutoplay();
        set({ bookError: '', bookBuffering: true, bookBufferingSince: Date.now() });
        playBookFrom(id, bookFromRef, false);
      }
    }
    // Double-buffered preload: while chunk N plays we synthesize chunk N+1 in
    // the background, so onEnded can start the next chunk with zero network wait.
    // Chunk bounds come from a /meta call (total), not a custom response header —
    // some HTTP layers strip custom headers, which would otherwise make a book
    // stop after the first chunk.
    // Book playback streams each chunk over HTTP directly into <audio> (no blob
    // URLs — those tripped a browser "getTopURL" TypeError in this environment).
    // A hidden companion <audio> warms the next chunk so the switch is near-instant.
    let bookTotal = -1;    // total chunks of the current book (-1 = unknown)
    let bookFromRef = 0;   // current chunk index being played
    // Monotonic token so only the LATEST voice switch applies (a slow synthesis
    // for an older selection must not override a newer one).
    let voiceSwitchSeq = 0;
    let bookBufferedFrom = -1; // chunk index already buffered in preAudio
    let bookBaseTime = 0;  // cumulative seconds of all completed chunks (for a
                           // continuous book-wide time readout that never resets)
    let bookStuckTimer = null; // single synthesis-timeout guard (see playBookFrom)
    let lastPosSaveAt = 0;     // throttle for the periodic playback-state save
    let restoredMusicPos = null; // restored music position to display until the audio truly reaches it
    let bookRestorePos = -1;   // restored book's in-chunk position, seeked on play
    const preAudio = new Audio();
    preAudio.preload = 'auto';
    const bookUrl = (id, from) => {
      const b = bookById(id);
      if (b === null) return null;
      // The chosen TTS voice rides the URL so the host re-synthesizes with it.
      // Only send voices we know (stale localStorage values are dropped; the host
      // then falls back to its default 白桦).
      const known = (store.voices && store.voices.length > 0) ? store.voices : FALLBACK_VOICES;
      const v = store.voice && known.some((x) => x.id === store.voice) ? '&voice=' + encodeURIComponent(store.voice) : '';
      return b.url + '?from=' + from + v;
    };
    // ---- book meta (total chunks + chapter structure) ----
    // /meta now returns { total, title, author, sections } where sections carry a
    // fromChunk per section for the chapter table of contents. Cached per book id
    // (the content never changes within a session, and the synthesis already
    // de-dupes repeat chunks).
    const bookMetaCache = new Map();
    async function ensureBookMeta(id) {
      const hit = bookMetaCache.get(id);
      if (hit !== undefined) return hit;
      const book = bookById(id);
      if (book === null) return null;
      let meta = null;
      try {
        const r = await fetch(book.url + '/meta', { cache: 'no-store' });
        if (r.ok) {
          const m = await r.json();
          meta = {
            total: m && typeof m.total === 'number' ? m.total : -1,
            title: (m && m.title) || '',
            author: (m && m.author) || '',
            sections: (m && Array.isArray(m.sections)) ? m.sections : [],
          };
          bookMetaCache.set(id, meta);
        }
      } catch {}
      return meta;
    }
    async function ensureBookTotal(id) {
      if (bookTotal >= 0) return bookTotal;
      const meta = await ensureBookMeta(id);
      if (meta !== null && meta.total >= 0) bookTotal = meta.total;
      return bookTotal;
    }
    // Label a section type for display in the toc (chapter/分部/前言/后记/分节).
    const sectionTypeLabel = (t) => ({
      chapter: '\u7ae0\u8282', part: '\u5206\u90e8', preface: '\u524d\u8a00',
      epilogue: '\u540e\u8bb0', named: '\u5206\u8282', toc: '\u76ee\u5f55',
    })[t] || '\u6b63\u6587';
    // Heading of the section that contains the given chunk index.
    function sectionForChunk(sections, chunk) {
      if (!Array.isArray(sections) || sections.length === 0) return '';
      let cur = sections[0];
      for (const s of sections) { if (s.fromChunk <= chunk) cur = s; else break; }
      return cur.heading || '';
    }
    // Populate the toc (sections) for the current book; used when a book starts
    // playing and when the toc popup opens.
    async function ensureBookToc(id) {
      const meta = await ensureBookMeta(id);
      if (meta !== null) set({ bookToc: meta.sections || [] });
      return meta;
    }
    function openToc() {
      const id = currentBookId();
      if (id === null) return;
      set({ tocOpen: true });
      void ensureBookToc(id).then((meta) => {
        if (meta === null) return;
        set({ tocOpen: true, bookToc: meta.sections || [] });
      });
    }
    function closeToc() { set({ tocOpen: false }); }
    // Open/close the playback panel. The visible tab is decided purely by the
    // current playback mode: a playing novel shows the 小说 list, anything else
    // (music or idle) shows the 音乐 list. No tab memory is kept.
    function togglePanel() {
      const opening = !store.panelOpen;
      if (opening) {
        const isBook = store.currentId !== null && String(store.currentId).startsWith('book:');
        set({ tab: isBook ? 'book' : 'music' });
      }
      set({ panelOpen: opening });
    }
    // Warm the next chunk in the hidden preAudio (same-origin HTTP -> browser cache).
    function preloadBook(id, from) {
      const url = bookUrl(id, from);
      if (url === null) return;
      // audio.src reports the resolved absolute URL, so compare like-for-like
      // (the old `preAudio.src === url` never matched and re-fired the load).
      if (preAudio.src === new URL(url, window.location.href).href) return; // already preloaded
      preAudio.src = url;
      preAudio.load();
      bookBufferedFrom = from;
    }
    async function playBookFrom(id, from, silent) {
      const book = bookById(id);
      if (book === null) return;
      restoredMusicPos = null;
      const wasFresh = from === 0;
      // `silent` is set for the hidden ended→next auto-advance: the switch is
      // near-instant (server-side synthesis cache) so we don't flash a spinner
      // at every chunk boundary. Only user-initiated plays show it.
      const showBuffer = !silent;
      set({ currentId: 'book:' + id, currentName: book.name, pendingId: null, pendingName: null, error: null, vizState: 'ok' });
      // Load the chapter structure for the toc + the current-section label (the
      // current section is derived from the chunk index once the meta arrives).
      const startFrom = from;
      void ensureBookToc(id).then((meta) => {
        if (meta !== null && meta.sections.length > 0) {
          set({ currentSection: sectionForChunk(meta.sections, startFrom) });
        }
      });
      set(wasFresh
        ? { bookBuffering: true, bookBufferingSilent: !showBuffer, bookError: '', bookBufferingSince: Date.now() }
        : { bookBuffering: true, bookBufferingSilent: !showBuffer, bookBufferingSince: Date.now() });
      // Client-side guard so a hung synthesis can never leave the bar on
      // "合成中…" forever (the host also aborts its own request at 60s). A
      // single shared timer means a retry never inherits a stale timeout.
      if (bookStuckTimer !== null) clearTimeout(bookStuckTimer);
      bookStuckTimer = setTimeout(() => {
        if (store.bookBuffering) set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0, bookError: 'AI 合成超时，请点击「重试」' });
      }, 60000);
      const doneBuffering = () => set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0 });
      const failBook = (message) => set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0, bookError: message || '讲书音频获取失败，请重试' });
      const clearStuck = () => { if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; } };
      try {
        const url = bookUrl(id, from);
        if (url === null) { clearStuck(); failBook('书籍信息缺失'); return; }
        bookFromRef = from;
        audio.src = url;
        audio.load();
        const promise = audio.play();
        if (promise !== undefined && typeof promise.then === 'function') {
          promise.then(() => { clearStuck(); doneBuffering(); }).catch((e) => {
            clearStuck();
            // Distinguish a real autoplay block (NotAllowedError) from a media
            // load/decode failure. Load failures are already surfaced by the
            // <audio> error handler (which fetches the server's real message);
            // here we only need to stop the spinner, not mislabel it as autoplay.
            const isAutoplay = e && (e.name === 'NotAllowedError' || /not allowed|autoplay|gesture/i.test(String(e && e.message)));
            if (isAutoplay) failBook('自动播放被拦截，请在播放条上点击 ▶ 解锁');
            else doneBuffering();
          });
        } else {
          clearStuck();
          doneBuffering();
        }
        // Resolve total in the background — a slow /meta must not stall the
        // initial play (that would leave it "buffering" with no network request).
        void ensureBookTotal(id).then((total) => {
          if (from + 1 < total) preloadBook(id, from + 1);
        });
      } catch (err) {
        clearStuck();
        failBook('无法获取讲书音频：' + String((err && err.message) || err));
      }
    }
    // `from` lets the toc jump straight to a chapter's chunk index.
    function playBook(id, from = 0) { unlockAutoplay(); bookTotal = -1; bookBufferedFrom = -1; bookBaseTime = 0; bookRestorePos = -1; playBookFrom(id, from, false); saveCurrentBookPlayback(); }
    // Play a novel from its saved progress when available (e.g. switching to
    // music and back), otherwise start fresh from the beginning. Explicit
    // chapter jumps keep using playBook(id, fromChunk) and are unaffected.
    function resumeOrPlayBook(id) {
      const book = bookById(id);
      if (book === null) return;
      const entry = getBookPlayback(book.name);
      if (entry === null) { playBook(id); return; }
      // Seed chunk / cumulative clock / in-chunk position from this book's entry.
      restoreBookPlayback(book.name);
      if (String(store.currentId) === 'book:' + id) {
        // Restore applied: play the saved chunk; onTime seeks to the in-chunk pos.
        unlockAutoplay();
        playBookFrom(id, bookFromRef, false);
      } else {
        playBook(id); // restore bailed (book gone) → start fresh
      }
    }
    // When a chunk ends, switch to the next HTTP chunk (warmed by preAudio).
    // The switch is silent: no buffering flash, and the book-wide clock keeps
    // the completed chunk's duration so the readout never resets.
    function maybeAdvanceBook() {
      if (store.currentId === null || !String(store.currentId).startsWith('book:')) return false;
      const id = String(store.currentId).slice('book:'.length);
      if (bookFromRef + 1 < bookTotal) {
        const endedDur = Number.isFinite(audio.duration) ? audio.duration : (audio.currentTime || 0);
        if (Number.isFinite(endedDur)) bookBaseTime += endedDur;
        playBookFrom(id, bookFromRef + 1, true);
        // Persist the new chunk/base immediately so a refresh after the switch
        // resumes from here (with the continuous clock) rather than the old chunk.
        lastPosSaveAt = Date.now();
        savePlayback();
        return true;
      }
      return false;
    }
    function stopBookHelper() {
      preAudio.removeAttribute('src'); preAudio.load();
      if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; }
      bookTotal = -1; bookFromRef = 0; bookBufferedFrom = -1; bookBaseTime = 0; bookRestorePos = -1;
    }
    function togglePlay() {
      if (store.pendingId !== null && store.currentId === null) { startPlay(store.pendingId); return; }
      if (store.currentId === null) { const ids = activeIds(); if (ids.length > 0) startPlay(ids[0]); return; }
      if (audio.paused) {
        // A restored track's <audio> was not pre-loaded (restore never touches
        // the element, to avoid the Chromium 'getTopURL' quirk), so load it now,
        // then apply the deferred seek so it resumes from the saved spot.
        if (restoredMusicPos !== null && restoredMusicPos > 0) {
          const track = resolvePlayable(store.currentId);
          if (track !== null && audio.currentSrc !== new URL(track.url, window.location.href).href) {
            audio.src = track.url;
            audio.load();
          }
          if ((audio.currentTime || 0) < restoredMusicPos - 0.5) {
            try { audio.currentTime = restoredMusicPos; } catch (e) {}
          }
        }
        if (bookRestorePos >= 0 && String(store.currentId).startsWith('book:')) {
          const id = currentBookId();
          const chunkUrl = bookUrl(id, bookFromRef);
          if (chunkUrl !== null && audio.currentSrc !== new URL(chunkUrl, window.location.href).href) {
            audio.src = chunkUrl;
            audio.load();
          }
          if ((audio.currentTime || 0) < bookRestorePos - 0.5) {
            try { audio.currentTime = bookRestorePos; } catch (e) {}
          }
          if (bookTotal >= 0 && bookFromRef + 1 < bookTotal) preloadBook(id, bookFromRef + 1);
        }
        const promise = audio.play();
        if (promise !== undefined && typeof promise.catch === 'function') promise.catch(() => set({ error: '\u6d4f\u89c8\u5668\u62e6\u622a\u4e86\u81ea\u52a8\u64ad\u653e\uff0c\u8bf7\u70b9\u51fb\u64ad\u653e\u6309\u94ae' }));
        // Envelope decoding is deferred to play (see loadTracks) — decode the
        // restored track lazily so its spectrum is ready once it resumes.
        if (!String(store.currentId).startsWith('book:')) {
          const track = resolvePlayable(store.currentId);
          if (track !== null && !envCache.has(track.id)) loadEnvelope(track.id, track.url);
        }
      } else audio.pause();
    }
    function step(delta) {
      const ids = activeIds();
      if (ids.length === 0) return;
      if (store.mode === 'shuffle' && ids.length > 1) {        // Walk the shuffled queue: next plays the next unplayed track, prev
        // returns to the previously played one (not a list-order neighbor).
        ensureShuffleReady();
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
      const idx = ids.indexOf(store.currentId);
      const nextIdx = idx < 0 ? 0 : (idx + delta + ids.length) % ids.length;
      startPlay(ids[nextIdx]);
    }
    // In book (AI 讲书) mode the transport prev/next buttons jump between
    // CHAPTERS instead of music tracks. The current chapter is the section
    // whose fromChunk <= the playing chunk < the next section's fromChunk.
    function stepBook(delta) {
      const id = currentBookId();
      if (id === null) return;
      let sections = store.bookToc || [];
      if (sections.length === 0) {
        // structure not loaded yet: fetch it, then retry the jump once.
        void ensureBookToc(id).then((meta) => {
          if (meta !== null && meta.sections.length > 0 && currentBookId() === id) stepBook(delta);
        });
        return;
      }
      let curIdx = -1;
      for (let i = 0; i < sections.length; i++) {
        if (sections[i].fromChunk <= bookFromRef) curIdx = i; else break;
      }
      if (curIdx < 0) curIdx = 0;
      const nextIdx = Math.max(0, Math.min(sections.length - 1, curIdx + delta));
      if (nextIdx === curIdx) return; // already at the first/last chapter
      playBook(id, sections[nextIdx].fromChunk);
    }
    function seekTo(seconds) {
      if (Number.isFinite(seconds)) { restoredMusicPos = null; audio.currentTime = seconds; set({ position: seconds }); savePlayback(); }
    }
    function changeVolume(value) {
      const v = Math.min(1, Math.max(0, value));
      audio.volume = v;
      set({ volume: v });
    }
    // Switch the AI 讲书 voice. The new voice must be synthesized (seconds), so we
    // pre-synthesize the current chunk in the background and only swap playback
    // once it is ready — the old voice keeps playing meanwhile, so switching never
    // causes a silent gap. On failure we revert the selection and keep the old
    // voice (the current audio is left untouched).
    function setVoice(voice) {
      if (!voice || voice === store.voice) return;
      const prevVoice = store.voice;
      set({ voice, voiceSwitching: false });
      const id = currentBookId();
      if (id === null || store.currentId === null || !String(store.currentId).startsWith('book:')) return;
      const from = bookFromRef;
      const mySeq = ++voiceSwitchSeq;
      set({ voiceSwitching: true });
      fetch(bookUrl(id, from), { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(() => {
          if (mySeq !== voiceSwitchSeq) return; // superseded by a newer switch
          // New-voice wav is synthesized (host cache + browser cache are warm);
          // swap the current chunk now — near-instant.
          set({ voiceSwitching: false });
          if (currentBookId() === id && bookFromRef === from) {
            unlockAutoplay();
            playBookFrom(id, from, true);
          }
        })
        .catch((err) => {
          if (mySeq !== voiceSwitchSeq) return;
          set({ voiceSwitching: false, voice: prevVoice, bookError: '\u58f0\u97f3\u5207\u6362\u5931\u8d25\uff1a' + String((err && err.message) || err) });
        });
    }
    function stop() {
      // Capture the current novel before resetting, so stopping forgets only
      // that one book's position (other novels keep their own progress).
      const stoppedBook = (store.currentId !== null && String(store.currentId).startsWith('book:'))
        ? bookById(currentBookId()) : null;
      envReqId++;
      trackEnv = null;
      restoredMusicPos = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      stopBookHelper();
      set({ currentId: null, currentName: null, playing: false, position: 0, duration: 0, pendingId: null, pendingName: null, vizState: 'ok', bookBuffering: false, bookError: '', bookBufferingSince: 0, bookBufferingSilent: false, tocOpen: false, currentSection: '', voiceSwitching: false });
      clearPref(PREF_PLAYBACK);
      if (stoppedBook !== null) clearBookPlayback(stoppedBook.name);
      releaseWakeLock();
    }

    // ---- Screen Wake Lock: keep the screen awake while music is playing ----
    // While audio plays we request a screen wake lock so the display (and, for
    // most power policies, the system) doesn't blank or sleep mid-song. Tabs
    // can't stop OS-level deep sleep, but holding a wake lock while visible
    // covers the common "screen blanked while I listened" case. Unsupported
    // browsers (e.g. Safari) silently skip it — never fatal.
    let wakeLock = null;
    const wakeLockSupported = (typeof navigator !== 'undefined') && ('wakeLock' in navigator);
    async function acquireWakeLock() {
      if (!wakeLockSupported || !store.playing) return;
      if (wakeLock !== null) return; // already held
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => { if (wakeLock === sentinel) wakeLock = null; });
        wakeLock = sentinel;
      } catch (e) {
        wakeLock = null; // denied or transient — non-fatal
      }
    }
    function releaseWakeLock() {
      if (wakeLock !== null) {
        try { wakeLock.release(); } catch (e) {}
        wakeLock = null;
      }
    }

    function bindAudio() {
      // Books report a continuous, book-wide clock: the cumulative seconds of
      // all completed chunks plus the current chunk's in-chunk position, so the
      // time readout grows across chunk boundaries instead of resetting each
      // block (it reads like one long audiobook). Music is unchanged.
      const bookTimeBase = () => (store.currentId !== null && String(store.currentId).startsWith('book:')) ? bookBaseTime : 0;
      const onTime = () => {
        // A restored music track keeps showing its restored position until real
        // playback has clearly advanced past it. The <audio> currentTime is
        // unreliable right after a restore — it can seek to the spot and then
        // transiently reset to 0 (some browsers do this), so releasing the pin
        // too early makes the readout follow that 0. Release only once
        // currentTime is clearly past the spot (proving genuine progress); while
        // not there yet, show the target — and if playing but stuck behind it
        // (e.g. autoplay started from 0), re-seek so playback resumes from the
        // right place instead of silently from the start.
        if (restoredMusicPos !== null && restoredMusicPos > 0) {
          const ct = audio.currentTime || 0;
          if (ct > restoredMusicPos + 1) {
            restoredMusicPos = null; // real playback advanced past the spot — live time
          } else {
            if (store.playing && ct < restoredMusicPos - 0.5) {
              try { audio.currentTime = restoredMusicPos; } catch (e) {}
            }
            set({ position: bookTimeBase() + restoredMusicPos });
            return;
          }
        }
        // A restored book applies the same pin to its in-chunk position (its
        // deferred seek is applied on play, so currentTime is still at the chunk
        // start until then) — anchored on top of the book-wide clock.
        if (bookRestorePos >= 0 && String(store.currentId).startsWith('book:')) {
          const ct = audio.currentTime || 0;
          if (ct > bookRestorePos + 1) {
            bookRestorePos = -1; // real playback advanced past the spot
          } else {
            if (store.playing && ct < bookRestorePos - 0.5) {
              try { audio.currentTime = bookRestorePos; } catch (e) {}
            }
            set({ position: bookBaseTime + bookRestorePos });
            return;
          }
        }
        set({ position: bookTimeBase() + (audio.currentTime || 0) });
        // Persist the playback spot periodically (≈every 5s) for BOTH music and
        // novels, so a refresh at any moment resumes here instead of jumping
        // back to 0 (books additionally carry chunk + cumulative-clock state).
        if (store.playing && Date.now() - lastPosSaveAt > 5000) {
          lastPosSaveAt = Date.now();
          savePlayback();
        }
      };
      const onDur = () => {
        // Only overwrite when the media actually reports a real duration;
        // before metadata loads audio.duration is NaN and we'd clobber a
        // restored/stored value with 0 (leaving "0:00").
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          set({ duration: (bookTimeBase() + audio.duration) });
        }
      };
      const onPlay = () => { set({ playing: true, error: null }); acquireWakeLock(); };
      const onPause = () => { set({ playing: false }); savePlayback(); releaseWakeLock(); };
      const onEnded = () => {
        // A novel plays chunk-by-chunk: when a chunk ends, auto-advance to the
        // next block until the whole book is done, then stop (never step into
        // the music list). Book ids are 'book:'-prefixed.
        if (store.currentId !== null && String(store.currentId).startsWith('book:')) {
          if (!maybeAdvanceBook()) stop();
          return;
        }
        if (store.mode === 'single' && store.currentId !== null) {
          audio.currentTime = 0;
          const promise = audio.play();
          if (promise !== undefined && typeof promise.catch === 'function') promise.catch(() => set({ error: '\u64ad\u653e\u5931\u8d25', playing: false }));
          return;
        }
        step(1);
      };
      const onError = () => {
        // A novel chunk that fails to load (TTS error / timeout / decode) must
        // clear the "合成中…" spinner and surface a real message instead of
        // leaving the bar stuck buffering forever.
        if (store.currentId !== null && String(store.currentId).startsWith('book:')) {
          set({ bookBuffering: false, bookBufferingSince: 0, playing: false, bookError: '\u8bb2\u4e66\u97f3\u9891\u83b7\u53d6\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5' });
          // Best-effort: fetch the URL to show the server's actual diagnostic
          // (e.g. "TTS 请求失败 401 ..."), which the <audio> error object lacks.
          const id = String(store.currentId).slice('book:'.length);
          const book = bookById(id);
          if (book !== null) {
            fetch(bookUrl(id, bookFromRef), { cache: 'no-store' }).then((r) => {
              if (!r.ok) return r.text().then((t) => {
                const msg = String(t || '').trim();
                if (msg) set({ bookError: msg.slice(0, 240) });
              });
            }).catch(() => {});
          }
        } else {
          set({ error: '\u97f3\u9891\u52a0\u8f7d\u6216\u89e3\u7801\u5931\u8d25', playing: false });
        }
      };
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

    // Restore the persisted playback scope (playlist/library); a stale playlist id falls back.
    function restoreScope(plists) {
      const raw = loadPref(PREF_SCOPE);
      try {
        const o = JSON.parse(raw);
        if (o && o.kind === 'playlist' && (plists || []).some((p) => p.id === o.id)) {
          set({ scope: { kind: 'playlist', id: o.id } });
          return;
        }
      } catch (e) {}
      set({ scope: { kind: 'library' } });
    }

    function restorePlayback(list) {
      const saved = loadPlayback();
      if (saved === null) return;
      // A saved current track may be a library track or a playlist member ('p:'+path).
      let track = list.find((t) => t.id === saved.id);
      let scope = { kind: 'library' };
      if (track === undefined && String(saved.id).startsWith('p:')) {
        for (const p of store.playlists || []) {
          const m = (p.tracks || []).find((t) => t.id === saved.id);
          if (m) { track = m; scope = { kind: 'playlist', id: p.id }; break; }
        }
      }
      if (track === undefined) return;
      const pos = Number.isFinite(saved.position) ? saved.position : 0;
      const savedDur = Number.isFinite(saved.duration) && saved.duration > 0 ? saved.duration : 0;
      // We do NOT touch the <audio> element here: in this environment loading or
      // seeking a media element during restore trips a harmless-but-noisy
      // Chromium 'getTopURL' rejection. The track is set up lazily on play
      // (togglePlay), and the readout is pinned to the restored values.
      set({
        currentId: track.id, currentName: track.name,
        position: pos, duration: savedDur,
        pendingId: null, pendingName: null, error: null, scope,
      });
      if (pos > 0) {
        restoredMusicPos = pos;
      } else {
        restoredMusicPos = null;
      }
      // Save the restored spot explicitly so it survives another refresh.
      savePref(PREF_PLAYBACK, JSON.stringify({ id: track.id, name: track.name, position: pos, duration: savedDur, ts: Date.now() }));
    }

    // Restore a novel's playback after a refresh (or when resuming a book):
    // same book, same chunk, same cumulative clock, and same in-chunk position —
    // paused (tap ▶ to resume), matching how music is restored. When targetName
    // is given, restore that book; otherwise restore the most recently played
    // novel from the per-book map.
    function restoreBookPlayback(targetName) {
      const map = readBooksPlayback();
      let name = targetName;
      let entry = null;
      if (typeof name === 'string' && name !== '') {
        entry = map[name] || null;
      } else {
        for (const [n, e] of Object.entries(map)) {
          if (e && typeof e.from === 'number' && (entry === null || e.ts > entry.ts)) { entry = e; name = n; }
        }
      }
      if (entry === null || !name) return;
      const book = store.books.find((b) => b.name === name);
      if (book === undefined) return; // the book is no longer in the library
      const from = Number.isFinite(entry.from) && entry.from >= 0 ? entry.from : 0;
      const base = Number.isFinite(entry.base) ? entry.base : 0;
      const pos = Number.isFinite(entry.pos) ? entry.pos : 0;
      bookTotal = Number.isFinite(entry.total) ? entry.total : -1;
      bookFromRef = from;
      bookBaseTime = base;
      const url = bookUrl(book.id, from);
      if (url === null) return;
      // Mark the book as current. Like music restore, we do NOT touch the
      // <audio> element here (avoiding the Chromium 'getTopURL' quirk on
      // refresh); togglePlay loads + seeks the chunk when the user resumes.
      set({
        currentId: 'book:' + book.id, currentName: book.name,
        position: base + pos, duration: base + (Number.isFinite(audio.duration) ? audio.duration : 0),
        pendingId: null, pendingName: null, error: null, playing: false,
        bookBuffering: false, bookBufferingSilent: false, bookError: '', bookBufferingSince: 0,
      });
      bookRestorePos = pos;
      // Refresh the chunk total in the background (the book file may have
      // changed since the save); fall back to the saved total on failure.
      const savedTotal = bookTotal;
      bookTotal = -1;
      void ensureBookTotal(book.id).then((total) => {
        if (!Number.isFinite(total) || total < 0) { bookTotal = savedTotal; return; }
        bookTotal = total;
        if (from + 1 < total) preloadBook(book.id, from + 1);
      });
    }

    // Restore whichever (music vs novel) was playing most recently — both now
    // persist independently, so a music interlude never wipes a novel's progress.
    function restoreLatest(list) {
      let musicTs = -1;
      try {
        const p = JSON.parse(loadPref(PREF_PLAYBACK) || 'null');
        if (p && typeof p.ts === 'number') musicTs = p.ts;
      } catch (e) {}
      const book = latestBookPlayback();
      const bookTs = book ? book.ts : -1;
      if (bookTs > musicTs) { restoreBookPlayback(); return; }
      if (musicTs > bookTs) { restorePlayback(list); return; }
      // tie / legacy data without timestamps: restore whatever exists (music
      // first, book last — legacy data only ever had one of the two populated).
      restorePlayback(list);
      restoreBookPlayback();
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
        set({
          root: result.root || null, bookRoot: result.bookRoot || null,
          tracks: result.tracks || [], books: result.books || [],
          playlists: result.playlists || [],
          count: result.count || 0, loading: false, error: result.error || null,
          ttsConfigured: !!result.ttsConfigured, ttsReason: result.ttsReason || '',
          voices: Array.isArray(result.voices) ? result.voices : [],
        });
        const list = result.tracks || [];
        // Envelope (spectrum) decoding is deferred to actual playback — no need
        // to decode several full files eagerly at page load; the current track's
        // envelope decodes on play (startPlay / resume).
        restoreScope(result.playlists || []);
        restoreLatest(list);
      } catch (err) {
        set({ loading: false, error: '\u65e0\u6cd5\u8bfb\u53d6\u97f3\u4e50\u5e93\uff1a' + String((err && err.message) || err) });
      }
    }
    function saveRoot(path, kind) {
      const target = kind === 'book' ? '/dsh-music/set-book-root' : '/dsh-music/set-root';
      set({ loading: true });
      fetch(target, {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      }).then((r) => r.json()).then((result) => {
        if (result && result.ok) {
          if (result.root) savePref(PREF_ROOT, result.root);
          set({
            root: result.root || null, bookRoot: result.bookRoot || null,
            tracks: result.tracks || [], books: result.books || [],
            count: result.count || 0, loading: false, error: null,
          });
          restoreLatest(result.tracks || []);
        } else {
          set({ loading: false, error: (result && result.error) || '\u8bbe\u7f6e\u76ee\u5f55\u5931\u8d25' });
        }
      }).catch((err) => {
        set({ loading: false, error: '\u8bbe\u7f6e\u76ee\u5f55\u5931\u8d25\uff1a' + String((err && err.message) || err) });
      });
    }

    function fmtTime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
      // Books use a continuous book-wide clock that can pass an hour, so show
      // hours when present (e.g. "1:02:03"); music under an hour stays "m:ss".
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const mm = h > 0 && m < 10 ? '0' + m : String(m);
      return h > 0 ? h + ':' + mm + ':' + (s < 10 ? '0' : '') + s : m + ':' + (s < 10 ? '0' : '') + s;
    }
    // Adaptive file-size label for the playlist: MB when >= 1MiB, else KB.
    // Music and novels share this, so a large novel shows "1.6 MB" instead of
    // an unwieldy "1600 KB" and a tiny audio clip no longer reads "0 MB".
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '';
      if (bytes >= 1024 * 1024) {
        const mb = bytes / 1024 / 1024;
        return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB';
      }
      return Math.round(bytes / 1024) + ' KB';
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
    // Fallback voice list if /manifest hasn't delivered one (older host / offline).
    const FALLBACK_VOICES = [
      { id: '\u51b0\u7cd6', label: '\u51b0\u7cd6', gender: '\u5973', lang: '\u4e2d\u6587' },
      { id: '\u8309\u8389', label: '\u8309\u8389', gender: '\u5973', lang: '\u4e2d\u6587' },
      { id: '\u82cf\u6253', label: '\u82cf\u6253', gender: '\u7537', lang: '\u4e2d\u6587' },
      { id: '\u767d\u6866', label: '\u767d\u6866', gender: '\u7537', lang: '\u4e2d\u6587' },
    ];
    // AI 讲书 voice picker, shown in the volume popup only while reading a book.
    function VoicePicker() {
      const s = useStore();
      const voices = (s.voices && s.voices.length > 0) ? s.voices : FALLBACK_VOICES;
      const cur = voices.find((v) => v.id === s.voice);
      const currentLabel = cur ? (cur.label + (cur.gender && cur.gender !== '\u81ea\u52a8' ? '\uff08' + cur.gender + '\uff09' : '')) : s.voice;
      return React.createElement('div', { className: 'dsh-music-voice' },
        React.createElement('span', { className: 'dsh-music-voice-label' }, 'AI \u58f0\u97f3'),
        React.createElement('select', {
          className: 'dsh-music-voice-select',
          value: voices.some((v) => v.id === s.voice) ? s.voice : '\u767d\u6866',
          title: '\u5f53\u524d\uff1a' + currentLabel,
          onChange: (e) => setVoice(e.target.value),
        },
          voices.map((v) => React.createElement('option', {
            key: v.id, value: v.id,
          }, (v.label || v.id) + (v.lang ? '\u00b7' + v.lang : '') + (v.gender && v.gender !== '\u81ea\u52a8' ? '\uff08' + v.gender + '\uff09' : ''))),
        ),
        s.voiceSwitching ? React.createElement('span', { className: 'dsh-music-voice-switching' }, '\u5207\u6362\u4e2d\u2026') : null,
      );
    }
    // Novel status shown after the title on the now-playing bar: a live
    // "AI 合成中… Ns" counter while a user-initiated chunk is being generated
    // (never a bare endless spinner), and on failure the real message plus a
    // retry button. Auto-advance between chunks is silent (bookBufferingSilent),
    // so only the initial click / explicit retry shows the counter.
    function BookStatus() {
      const s = useStore();
      const [now, setNow] = useState(Date.now());
      useEffect(() => {
        if (!s.bookBuffering) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
      }, [s.bookBuffering]);
      if (s.bookBuffering && !s.bookBufferingSilent) {
        const secs = s.bookBufferingSince > 0 ? Math.floor((now - s.bookBufferingSince) / 1000) : 0;
        return React.createElement('span', { className: 'dsh-music-bar-buffering' },
          React.createElement('span', { className: 'dsh-music-spinner' }),
          ' AI \u5408\u6210\u4e2d\u2026 ' + secs + 's');
      }
      if (s.bookError) {
        return React.createElement('span', { className: 'dsh-music-bar-berr', title: s.bookError },
          React.createElement('span', { className: 'dsh-music-bar-berr-text' }, s.bookError),
          React.createElement('button', {
            className: 'dsh-music-bar-btn retry',
            title: '\u91cd\u65b0\u5408\u6210\u5f53\u524d\u6bb5\u843d',
            onClick: retryBook,
          }, '\u91cd\u8bd5'));
      }
      return null;
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
          onClick: () => { const t = resolvePlayable(s.currentId); if (t !== null) loadEnvelope(t.id, t.url); },
        }, '\u9891\u8c31\u4e0d\u53ef\u7528\uff0c\u70b9\u51fb\u91cd\u8bd5');
      }
      const note = React.createElement(MusicNote, { className: 'dsh-music-note' });
      const isBook = s.currentId !== null && String(s.currentId).startsWith('book:');
      // While a novel chunk is being synthesized, show a live "合成中… Ns"
      // counter (so the wait is transparent, not an endless spinner) and, on
      // error, the real message plus a retry button. Music keeps its old UI.
      let afterName = null;
      if (isBook) afterName = React.createElement(BookStatus, null);
      // 当前在读章节徽标（讲书时显示，如"▸ 第三章　泰山压顶"）。
      let sectionBadge = null;
      if (isBook && s.currentSection) {
        sectionBadge = React.createElement('span', { className: 'dsh-music-bar-section', title: s.currentSection },
          '\u25b8 ' + s.currentSection);
      }
      // 自建歌单：收藏爱心按钮（收藏时用主题色）。
      const faved = hasTrack && !isBook && isCurrentFaved();
      const heartBtn = hasTrack && !isBook ? React.createElement('button', {
        className: 'dsh-music-bar-btn fav' + (faved ? ' on' : ''),
        title: faved ? '取消收藏（从「我最喜欢」移除）' : '收藏到「我最喜欢」',
        onClick: toggleFav,
      }, React.createElement('svg', {
        viewBox: '0 0 24 24', width: 14, height: 14,
        fill: faved ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true,
      }, React.createElement('path', { d: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z' }))) : null;
      return React.createElement('div', { className: 'dsh-music-bar-wrap' },
        React.createElement('div', { className: 'dsh-music-bar' + (isBook ? ' book' : '') },
          hasTrack
            ? React.createElement('span', { className: 'dsh-music-bar-name', title: name }, note, ' ', name, afterName)
            : React.createElement('span', { className: 'dsh-music-bar-idle' }, note, ' \u672c\u5730\u97f3\u4e50\u64ad\u653e\u5668'),
          // 章节名独立占一整行、完整显示（不再被省略号截断）。
          sectionBadge,
          !isBook && hasTrack && s.playing ? React.createElement('canvas', { className: 'dsh-music-viz', width: 64, height: 14, ref: (el) => { barCanvasNode = el; } }) : null,
          vizBadge,
          hasTrack
            ? (showHint
                ? React.createElement('span', { className: 'dsh-music-bar-hint' }, '\u26a0 \u81ea\u52a8\u64ad\u653e\u88ab\u62e6\u622a\uff0c\u70b9\u51fb\u25b6\u89e3\u9501')
                : React.createElement('span', { className: 'dsh-music-bar-time' }, fmtTime(s.position) + ' / ' + fmtTime(s.duration)))
            : null,
          heartBtn,
          hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: isBook ? '\u4e0a\u4e00\u7ae0' : '\u4e0a\u4e00\u9996', onClick: () => (isBook ? stepBook(-1) : step(-1)) }, '\u23ee') : null,
          hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '\u64ad\u653e/\u6682\u505c', onClick: togglePlay }, s.playing ? '\u23f8' : '\u25b6') : null,
          hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: isBook ? '\u4e0b\u4e00\u7ae0' : '\u4e0b\u4e00\u9996', onClick: () => (isBook ? stepBook(1) : step(1)) }, '\u23ed') : null,
          hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '\u505c\u6b62', onClick: stop }, '\u23f9') : null,
          // 章节目录按钮：仅讲书（book）时出现，点击弹出章节列表并可跳章。
          // 与音量/播放列表按钮同款圆形样式（dsh-music-mode-trigger）。
          isBook ? React.createElement('button', {
            className: 'dsh-music-mode-trigger' + (s.tocOpen ? ' active' : ''),
            title: '\u7ae0\u8282\u76ee\u5f55',
            onClick: openToc,
          }, React.createElement('svg', {
            viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
          }, React.createElement('path', { d: 'M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z' }))) : null,
          // 音乐播放模式按钮：仅在音乐语境（非讲书）显示，与章节目录按钮互斥。
          !isBook ? React.createElement(ModeDropdown, null) : null,
          React.createElement('div', { className: 'dsh-music-bar-vol', ref: volRef },
            React.createElement('button', {
              className: 'dsh-music-mode-trigger' + (volOpen ? ' active' : ''),
              title: '\u97f3\u91cf',
              onClick: () => setVolOpen((o) => !o),
            }, React.createElement('svg', {
              viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
            }, React.createElement('path', { d: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z' }))),
            volOpen ? React.createElement('div', { className: 'dsh-music-bar-vol-pop' + (isBook ? ' book' : '') },
              isBook ? React.createElement(VoicePicker, null) : null,
              React.createElement(VolumeSlider, null),
            ) : null,
          ),
          React.createElement('button', {
            className: panelCls,
            title: s.panelOpen ? '\u5173\u95ed\u64ad\u653e\u5217\u8868' : '\u6253\u5f00\u64ad\u653e\u5217\u8868',
            onClick: togglePanel,
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
    // 章节目录弹层：列出当前小说的 前言/章节/尾声 等，点击某节从该章开头播放。
    function BookTocPanel() {
      const s = useStore();
      const ref = useRef(null);
      useEffect(() => {
        if (!s.tocOpen) return;
        const onDown = (e) => {
          if (ref.current !== null && !ref.current.contains(e.target)) closeToc();
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [s.tocOpen]);
      if (!s.tocOpen) return null;
      if (s.currentId === null || !String(s.currentId).startsWith('book:')) return null;
      const id = currentBookId();
      const rows = (s.bookToc || []).map((sec, i) => {
        const active = sec.heading === s.currentSection && sec.heading !== '';
        const label = sectionTypeLabel(sec.type);
        return React.createElement('button', {
          key: i,
          className: 'dsh-music-toc-item' + (active ? ' active' : ''),
          title: sec.heading,
          onClick: () => {
            if (id !== null) playBook(id, sec.fromChunk);
            closeToc();
          },
        },
          React.createElement('span', { className: 'dsh-music-toc-type' }, label),
          React.createElement('span', { className: 'dsh-music-toc-heading' }, sec.heading),
        );
      });
      const body = (s.bookToc || []).length > 0
        ? rows
        : React.createElement('div', { className: 'dsh-music-empty' }, '\u6682\u65e0\u7ae0\u8282\u7ed3\u6784\uff08\u8be5\u4e66\u65e0\u6cd5\u8bc6\u522b\u5206\u8282\u3002\uff09');
      return React.createElement('div', { className: 'dsh-music-toc', ref },
        React.createElement('div', { className: 'dsh-music-toc-head' },
          React.createElement('span', { className: 'dsh-music-toc-title' }, '\u7ae0\u8282\u76ee\u5f55'),
          React.createElement('button', { className: 'dsh-music-icon-btn', title: '\u5173\u95ed', onClick: closeToc }, '\u2715')),
        React.createElement('div', { className: 'dsh-music-toc-list' }, body),
      );
    }
    function PlayerPanel() {
      const s = useStore();
      const isBook = s.currentId !== null && String(s.currentId).startsWith('book:');
      const listRef = useRef(null);
      const panelRef = useRef(null);
      // Draggable panel position ({x, y, h} left/top/height once dragged; null = default right/bottom)
      const [pos, setPos] = useState(loadPanelPos);
      const dragRef = useRef(null);
      // 曲库每行「＋」打开的「加入歌单」菜单：{track, x, y}（锚点=按钮右上角视口坐标）。
      const [addMenu, setAddMenu] = useState(null);
      const openAddMenu = (track, e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAddMenu({ track, x: r.right, y: r.top });
      };

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
      // 面板关闭时清掉「加入歌单」弹层状态，避免重开面板时残留。
      useEffect(() => { if (!s.panelOpen) setAddMenu(null); }, [s.panelOpen]);
      if (!s.panelOpen) return null;
      const rows = s.tracks.map((t) => {
        const active = t.id === s.currentId;
        const playing = active && s.playing;
        return React.createElement('div', { key: t.id, className: 'dsh-music-track-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track' + (active ? ' active' : ''),
            title: t.url,
            onClick: () => { if (active) togglePlay(); else startPlayFrom(t.id, 'library'); },
          },
            React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '\u25b6 ' : '') + t.name),
            React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(t.size)),
          ),
          React.createElement('button', {
            className: 'dsh-music-playlist-mini add',
            title: '加入歌单',
            onClick: (e) => { e.stopPropagation(); openAddMenu(t, e); },
          }, '\uff0b'),
        );
      });
      const bookRows = s.books.map((b) => {
        const active = 'book:' + b.id === s.currentId;
        const playing = active && s.playing;
        return React.createElement('button', {
          key: b.id,
          className: 'dsh-music-track' + (active ? ' active' : ''),
          title: b.url,
          onClick: () => { if (active) togglePlay(); else resumeOrPlayBook(b.id); },
        },
          React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '\u25b6 ' : '') + b.name),
          React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(b.size)),
        );
      });
      const tabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-tab' + (s.tab === key ? ' active' : ''),
        onClick: () => set({ tab: key }),
      }, label);
      // 音乐页子标签：曲库 / 我最喜欢 / ＋ / 自建歌单
      const subTabBtn = (key, label, extraCls, rkey) => React.createElement('button', {
        key: rkey,
        className: 'dsh-music-subtab' + (s.subTab === key ? ' active' : '') + (extraCls ? ' ' + extraCls : ''),
        title: label,
        onClick: () => set({ subTab: key }),
      }, label);
      const musicSubTabs = React.createElement('div', { className: 'dsh-music-subtabs' },
        subTabBtn('library', '\u66f2\u5e93'),
        subTabBtn(FAV_PLAYLIST_ID, '\u2665 \u6211\u6700\u559c\u6b22'),
        // 自建歌单排在 ＋ 号之前；＋ 固定在末尾用于新建。
        (s.playlists || []).filter((p) => p.id !== FAV_PLAYLIST_ID).map((p) => subTabBtn(p.id, p.name, null, p.id)),
        React.createElement('button', { className: 'dsh-music-subtab add', title: '新建歌单', onClick: onCreatePlaylist }, '\uff0b'),
      );
      const isPlaylistView = s.subTab !== 'library';
      const plView = isPlaylistView ? playlistById(s.subTab) : null;
      const musicBody = plView
        ? React.createElement(PlaylistDetail, { pl: plView })
        : (rows.length > 0
          ? rows
          : React.createElement('div', { className: 'dsh-music-empty' }, '\u6682\u65e0\u97f3\u4e50\u3002\u70b9\u51fb\u4e0a\u65b9\u201c\u9009\u62e9\u97f3\u4e50\u76ee\u5f55\u201d\u5e76\u9009\u62e9\u76ee\u5f55\u540e\u81ea\u52a8\u626b\u63cf\u3002'));
      const listBody = s.tab === 'music'
        ? musicBody
        : (s.books.length > 0
          ? bookRows
          : (s.ttsConfigured
            ? React.createElement('div', { className: 'dsh-music-empty' }, '\u672a\u53d1\u73b0 .txt \u5c0f\u8bf4\u6587\u4ef6\u3002')
            : React.createElement('div', { className: 'dsh-music-error' }, s.ttsReason || '\u672a\u914d\u7f6e xiaomi/MiMo TTS \u6a21\u578b\u3002')));
      return React.createElement('div', { className: 'dsh-music-panel', ref: panelRef, style },
        React.createElement('div', {
          className: 'dsh-music-panel-head dsh-music-panel-drag',
          onPointerDown: onHeadDown, onPointerMove: onHeadMove, onPointerUp: onHeadUp,
        },
          React.createElement('span', { className: 'dsh-music-panel-grip', 'aria-hidden': true }, '\u283f'),
          React.createElement('span', { className: 'dsh-music-panel-title' }, '\u64ad\u653e\u5217\u8868'),
          React.createElement('button', { className: 'dsh-music-icon-btn', title: '\u5173\u95ed', onClick: () => set({ panelOpen: false }) }, '\u2715')),
        React.createElement('div', { className: 'dsh-music-tabs' }, tabBtn('music', '\u97f3\u4e50'), tabBtn('book', '\u5c0f\u8bf4')),
        React.createElement(DirectorySetting, null),
        s.tab === 'music' ? musicSubTabs : null,
        // While a novel is playing, keep music-only errors/scanning out of the
        // panel (novel status shows on the playback bar instead).
        !isBook && s.error ? React.createElement('div', { className: 'dsh-music-error' }, s.error) : null,
        !isBook && s.loading ? React.createElement('div', { className: 'dsh-music-loading' }, '\u626b\u63cf\u4e2d\u2026') : null,
        React.createElement('div', { className: 'dsh-music-list', ref: (el) => { listRef.current = el; } }, listBody),
        addMenu ? React.createElement(AddToPlaylistMenu, {
          track: addMenu.track, anchor: { x: addMenu.x, y: addMenu.y },
          onClose: () => setAddMenu(null),
        }) : null,
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
      const isBook = s.tab === 'book';
      const activeRoot = isBook ? s.bookRoot : s.root;
      const pickerTitle = isBook ? '\u9009\u62e9\u5c0f\u8bf4\u76ee\u5f55' : '\u9009\u62e9\u97f3\u4e50\u76ee\u5f55';
      const hint = isBook
        ? '\u652f\u6301 .txt \u6587\u4ef6\uff0cAI\u8bed\u97f3\u76ee\u524d\u4ec5\u652f\u6301xiaomi\u63d0\u4f9b\u65b9\uff08\u9650\u65f6\u514d\u8d39\uff09\uff0c\u8bf7\u5728\u8bbe\u7f6e\u4e2d\u914d\u7f6e\u597d\u518d\u4f7f\u7528\u6b64\u529f\u80fd\u3002'
        : '\u652f\u6301 mp3 / m4a / flac / wav / ogg / opus / aac / webm \u7b49\u683c\u5f0f\uff0c\u81ea\u52a8\u9012\u5f52\u626b\u63cf\u5b50\u76ee\u5f55\u3002';
      return React.createElement('div', { className: 'dsh-music-settings' },
        React.createElement('div', { className: 'dsh-music-settings-row' },
          React.createElement('span', { className: 'dsh-music-settings-cur', title: activeRoot || '' },
            '\ud83d\udcc1 ' + (activeRoot || '\u672a\u914d\u7f6e')),
          React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => openPicker() }, pickerTitle)),
        s.error ? React.createElement('p', { className: 'dsh-music-error' }, s.error) : null,
        React.createElement('p', { className: 'dsh-music-hint' }, hint),
        pickerOpen ? React.createElement('div', { className: 'dsh-music-picker-overlay' },
          React.createElement('div', { className: 'dsh-music-picker' },
            React.createElement('div', { className: 'dsh-music-picker-head' },
              React.createElement('span', { className: 'dsh-music-picker-title' }, pickerTitle)),
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
        // Open directly at the currently configured root (for this tab) so the
        // user sees the existing choice first; fall back to the home when unset.
        browse(activeRoot || '');
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
        saveRoot(p, isBook ? 'book' : 'music');
      }
    }
    // 「加入歌单」弹层：曲库每行「＋」点击后出现，列出所有歌单（含我最喜欢）并可新建。
    // 用 fixed 定位（锚点为按钮视口坐标），避免被面板滚动列表裁剪。
    function AddToPlaylistMenu({ track, anchor, onClose }) {
      const ref = useRef(null);
      useEffect(() => {
        const onDown = (e) => { if (ref.current !== null && !ref.current.contains(e.target)) onClose(); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [onClose]);
      const openUp = (anchor.y || 0) > ((window.innerHeight || 0) - 240);
      const style = {
        left: Math.max(8, (anchor.x || 0) - 150),
        top: openUp ? (anchor.y || 0) - 6 : (anchor.y || 0) + 8,
        transform: openUp ? 'translateY(-100%)' : 'none',
      };
      const list = store.playlists || [];
      const addTo = (id) => { apiPlaylistAdd(id, [track.path], () => onClose()); };
      const addNew = () => {
        const name = window.prompt('新建歌单名称', '');
        if (name === null) return;
        const trimmed = name.trim();
        if (trimmed === '') return;
        fetch('/dsh-music/playlist', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        }).then((r) => r.json()).then((r) => {
          if (r && r.playlist) {
            set({ playlists: [...(store.playlists || []), r.playlist] });
            apiPlaylistAdd(r.playlist.id, [track.path], () => onClose());
          }
        }).catch(() => onClose());
      };
      return React.createElement('div', { className: 'dsh-music-add-pop', ref, style },
        list.length > 0 ? list.map((p) => React.createElement('button', {
          key: p.id,
          className: 'dsh-music-add-pop-item',
          title: '加入「' + p.name + '」',
          onClick: () => addTo(p.id),
        }, (p.id === FAV_PLAYLIST_ID ? '\u2665 ' : '') + p.name + '\uff08' + p.count + '\uff09')) : null,
        React.createElement('button', { className: 'dsh-music-add-pop-item new', onClick: addNew }, '\uff0b \u65b0\u5efa\u6b4c\u5355'),
      );
    }
    // 歌单详情：添加歌曲 + 重命名/删除 + 歌曲列表（移除/上移/下移）。
    function PlaylistDetail({ pl }) {
      const [pickerOpen, setPickerOpen] = useState(false);
      const rows = (pl.tracks || []).map((t, idx) => {
        const active = t.id === store.currentId;
        const playing = active && store.playing;
        return React.createElement('div', { key: t.id, className: 'dsh-music-playlist-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track',
            title: t.url,
            onClick: () => { if (active) togglePlay(); else startPlayFrom(t.id, 'playlist', pl.id); },
          },
            React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '\u25b6 ' : '') + (idx + 1) + '. ' + t.name),
            React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(t.size)),
          ),
          React.createElement('button', { className: 'dsh-music-playlist-mini', title: '上移', onClick: (e) => { e.stopPropagation(); movePlaylistTrack(pl, t.path, -1); } }, '\u2191'),
          React.createElement('button', { className: 'dsh-music-playlist-mini', title: '下移', onClick: (e) => { e.stopPropagation(); movePlaylistTrack(pl, t.path, 1); } }, '\u2193'),
          React.createElement('button', { className: 'dsh-music-playlist-mini del', title: '从歌单移除', onClick: (e) => { e.stopPropagation(); apiPlaylistRemove(pl.id, [t.path]); } }, '\u00d7'),
        );
      });
      return React.createElement('div', { className: 'dsh-music-playlist' },
        React.createElement('div', { className: 'dsh-music-playlist-head' },
          React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => setPickerOpen(true) }, '\uff0b \u6dfb\u52a0\u6b4c\u66f2'),
          React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onClearPlaylist(pl) }, '清空'),
          !pl.fixed ? React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onRenamePlaylist(pl) }, '重命名') : null,
          !pl.fixed ? React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onDeletePlaylist(pl) }, '删除') : null,
          pl.missing > 0 ? React.createElement('span', { className: 'dsh-music-playlist-missing', title: '部分歌曲文件已被移动或删除' }, pl.missing + ' 首已失效') : null,
        ),
        rows.length > 0 ? rows : React.createElement('div', { className: 'dsh-music-empty dsh-music-playlist-empty' }, '歌单为空，点击「添加歌曲」从本地文件选择音乐。'),
        pickerOpen ? React.createElement(FilePicker, { pl, onClose: () => setPickerOpen(false) }) : null,
      );
    }
    // 文件系统多选器：浏览目录 + 勾选音频文件，用于歌单「添加歌曲」。
    function FilePicker({ pl, onClose }) {
      const [cur, setCur] = useState({ path: '', name: '', up: null, dirs: [], files: [] });
      const [sel, setSel] = useState(new Set());
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const browse = async (p) => {
        setErr(null);
        try {
          const data = await jsonGet('/dsh-music/files?path=' + encodeURIComponent(p || ''));
          if (data && data.error) { setErr(data.error); return; }
          setCur({ path: data.path || '', name: data.name || '', up: data.up || null, dirs: data.dirs || [], files: data.files || [] });
        } catch (e) { setErr('读取目录失败：' + String((e && e.message) || e)); }
      };
      // 默认定位到音乐目录（store.root），未配置时回退家目录。
      useEffect(() => { browse(store.root || ''); }, []);
      const toggle = (p) => {
        const next = new Set(sel);
        if (next.has(p)) next.delete(p); else next.add(p);
        setSel(next);
      };
      const confirmAdd = async () => {
        const paths = [...sel];
        if (paths.length === 0 || busy) { onClose(); return; }
        setBusy(true);
        apiPlaylistAdd(pl.id, paths, () => onClose());
      };
      return React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker' },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, '\u6dfb\u52a0\u6b4c\u66f2\u5230\u300c' + pl.name + '\u300d'),
          ),
          React.createElement('div', { className: 'dsh-music-picker-cur', title: cur.path }, cur.name || cur.path || '\u5bb6\u76ee\u5f55'),
          React.createElement('div', { className: 'dsh-music-picker-list' },
            (cur.dirs || []).map((d) => React.createElement('button', {
              key: d.path, className: 'dsh-music-picker-item', title: d.path,
              onClick: () => browse(d.path),
            }, '\ud83d\udcc1 ' + d.name)),
            (cur.files || []).map((f) => {
              const checked = sel.has(f.path);
              return React.createElement('button', {
                key: f.path,
                className: 'dsh-music-file-item' + (checked ? ' checked' : ''),
                title: f.path,
                onClick: () => toggle(f.path),
              },
                React.createElement('span', { className: 'dsh-music-file-check' }, checked ? '\u2713' : ''),
                React.createElement('span', { className: 'dsh-music-file-name' }, f.name),
                React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(f.size)),
              );
            }),
            err ? React.createElement('div', { className: 'dsh-music-error' }, err) : null,
          ),
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => goUp() }, '上一级'),
            React.createElement('button', { className: 'dsh-music-settings-btn', onClick: confirmAdd, disabled: busy }, '确定添加（' + sel.size + '）'),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: onClose }, '取消'),
          ),
        ),
      );
      function goUp() {
        const u = cur.up;
        if (u === '__drives__') { browse('__drives__'); return; }
        if (u) { browse(u); return; }
        if (cur.path === '' || cur.path === '/' || /^[A-Za-z]:[\\/]?$/.test(cur.path)) return;
        const idx = Math.max(cur.path.lastIndexOf('/'), cur.path.lastIndexOf('\\'));
        if (idx <= 0) return;
        browse(cur.path.slice(0, idx));
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
        attachAudioElements();
        const unbind = bindAudio();
        startRaf();
        const accentWatch = watchAccent();
        // Browsers auto-release a wake lock when the page is hidden; re-acquire
        // on return if playback is still running, and drop it on hide so we
        // don't hold it while the tab is backgrounded.
        const onVis = () => {
          if (document.hidden) releaseWakeLock();
          else acquireWakeLock();
        };
        // On refresh/unload, stop the media element cleanly BEFORE the document
        // is torn down — otherwise Chromium's media pipeline can race the
        // teardown and throw an internal "getTopURL" error in the console.
        const onPageHide = () => {
          try { audio.pause(); } catch (e) {}
          try { preAudio.pause(); } catch (e) {}
        };
        document.addEventListener('visibilitychange', onVis);
        window.addEventListener('pagehide', onPageHide);
        return () => {
          window.removeEventListener('pagehide', onPageHide);
          document.removeEventListener('visibilitychange', onVis); stopRaf(); unbind(); closeDecodeCtx(); releaseWakeLock();
          if (accentWatch !== null) accentWatch.disconnect();
          accentObserver = null;
        };
      }, 'music-player: audio + viz engine');

      loadTracks();

      const intentTimer = setInterval(() => {
        jsonGet('/dsh-music/intent').then((intent) => {
          if (intent === null || typeof intent !== 'object') return;
          const action = intent.action || 'play';
          // Transport commands operate on the current playback state (no track id).
          if (action === 'pause') { audio.pause(); set({ playing: false }); return; }
          if (action === 'resume') {
            const p = audio.play();
            if (p !== undefined && typeof p.catch === 'function') p.catch(() => set({ error: '\u64ad\u653e\u5931\u8d25' }));
            return;
          }
          if (action === 'stop') { stop(); return; }
          if (action === 'next') {
            // 讲书模式下：下一章；音乐模式下：下一首。
            if (store.currentId !== null && String(store.currentId).startsWith('book:')) stepBook(1); else step(1);
            return;
          }
          if (action === 'prev') {
            if (store.currentId !== null && String(store.currentId).startsWith('book:')) stepBook(-1); else step(-1);
            return;
          }
          // play with a playlist: switch scope to that playlist and start it.
          if (intent.playlistId) {
            const pl = playlistById(intent.playlistId);
            if (pl && pl.tracks && pl.tracks.length > 0) {
              startPlayFrom(pl.tracks[0].id, 'playlist', pl.id);
            }
            return;
          }
          // play (default): needs an id — a book id (e.g. "b0") starts AI 讲书.
          if (intent.id === undefined) return;
          const book = bookById(intent.id);
          if (book !== null) {
            set({ pendingId: 'book:' + book.id, pendingName: intent.name || book.name, error: null });
            resumeOrPlayBook(book.id);
            return;
          }
          const track = resolvePlayable(intent.id);
          if (track !== null) {
            audio.src = track.url;
            audio.load();
            set({ currentId: intent.id, currentName: track.name, error: null, scope: { kind: 'library' } });
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
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'music-player-book-toc', order: 19 },
        () => React.createElement(BookTocPanel),
      )), 'music-player: book toc panel');

      ctx.effect(() => () => clearInterval(intentTimer), 'music-player: intent poll stop');
    }

    exports.apply = apply;
    exports.inject = inject;

    // ---- CSS ----
    const PLAYER_CSS = '\n' +
      // Accent follows the host app's theme brand color (stable from the start —
      // no green-default-to-sampled-blue flash); green is only the fallback when
      // the app exposes no brand color. The alias must be declared on BODY, not
      // :root: DSH defines its --dsw-alias-* theme tokens on <body> only, and a
      // var() reference resolves against the element that declares it — on
      // :root (html) it cannot see body's tokens and would always fall back to
      // green. Declared on body, the reference resolves and children inherit
      // the theme's actual brand color.
      'body { --dsh-music-accent: var(--dsw-alias-brand-primary, #2f9e6e); }\n' +
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
      // 讲书时音量弹层加宽，容纳 AI 声音选择 + 音量条。
      '.dsh-music-bar-vol-pop.book { width: 136px; height: auto; padding: 10px; flex-direction: column; gap: 10px; align-items: stretch; }\n' +
      '.dsh-music-voice { display: flex; flex-direction: column; gap: 4px; }\n' +
      '.dsh-music-voice-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-voice-select { width: 100%; padding: 4px 6px; font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.3)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; cursor: pointer; }\n' +
      '.dsh-music-voice-switching { font-size: 10px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-vol-pop.book .dsh-music-vol-slider { align-self: center; }\n' +
      '.dsh-music-vol-slider { position: relative; width: 24px; height: 84px; cursor: pointer; touch-action: none; }\n' +
      '.dsh-music-vol-track { position: absolute; left: 50%; top: 0; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.14)); }\n' +
      '.dsh-music-vol-fill { position: absolute; left: 50%; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-vol-thumb { position: absolute; left: 50%; transform: translateX(-50%); width: 14px; height: 14px; border-radius: 50%; background: var(--dsh-music-accent, #2f9e6e); box-shadow: 0 1px 3px rgba(0,0,0,0.4); }\n' +
      '.dsh-music-bar-time { margin-left: auto; line-height: 1; font-variant-numeric: tabular-nums; }\n' +
      '.dsh-music-bar-hint { margin-left: auto; color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      '.dsh-music-bar-buffering { display: inline-flex; align-items: center; gap: 5px; margin-left: 8px; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }\n' +
      '.dsh-music-spinner { width: 12px; height: 12px; border: 2px solid var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.2)); border-top-color: var(--dsh-music-accent, #2f9e6e); border-radius: 50%; animation: dsh-music-spin 0.8s linear infinite; flex: none; }\n' +
      '@keyframes dsh-music-spin { to { transform: rotate(360deg); } }\n' +
      '.dsh-music-bar-berr { margin-left: 8px; color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; display: inline-flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-bar-berr-text { overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-bar-btn.retry { color: var(--dsw-alias-state-error-primary, #e5534b); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; padding: 0 6px; height: 18px; flex: none; }\n' +
      '.dsh-music-bar-btn.retry:hover { background: var(--dsw-alias-state-error-primary, #e5534b); color: #fff; }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger { width: 24px; height: 24px; }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger svg { flex: none; }\n' +
      '.dsh-music-bar .dsh-music-mode-menu { align-self: center; }\n' +
      '.dsh-music-panel { position: fixed; right: 24px; bottom: 84px; width: 380px; max-height: 72vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 1000; pointer-events: auto; overflow: hidden; }\n' +
      '.dsh-music-panel-head { display: flex; align-items: center; gap: 6px; }\n' +
      '.dsh-music-tabs { display: flex; gap: 4px; }\n' +
      '.dsh-music-tab { flex: 1; padding: 5px 0; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-tab:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-tab.active { background: var(--dsh-music-accent, #2f9e6e); color: #fff; }\n' +
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
      '.dsh-music-picker-overlay { position: absolute; inset: 0; z-index: 70; display: flex; overflow: auto; padding: 16px; background: rgba(0,0,0,0.45); }\n' +
      '.dsh-music-picker { box-sizing: border-box; width: 88%; max-height: 100%; margin: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-picker-head { display: flex; align-items: center; flex: none; }\n' +
      '.dsh-music-picker-title { font-weight: 600; }\n' +
      '.dsh-music-picker-cur { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-picker-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-picker-item { text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-picker-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-picker-empty { padding: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-picker-foot { display: flex; gap: 8px; justify-content: flex-end; }\n' +
      '.dsh-music-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      // 讲书时章节名是主信息：占满剩余弹性空间、尽量完整显示；书名让出空间（可截断）。
      '.dsh-music-bar.book .dsh-music-bar-name { max-width: 24%; }\n' +
      '.dsh-music-bar-section { margin-left: 8px; flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 6px; padding: 0 6px; line-height: 16px; }\n' +
      '.dsh-music-toc { position: fixed; right: 24px; bottom: 148px; width: 380px; max-height: 60vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 1000; }\n' +
      '.dsh-music-toc-head { display: flex; align-items: center; gap: 6px; }\n' +
      '.dsh-music-toc-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-toc-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-toc-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-toc-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-toc-item.active { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-toc-type { flex: none; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-toc-item.active .dsh-music-toc-type { background: var(--dsh-music-accent, #2f9e6e); color: #fff; }\n' +
      '.dsh-music-toc-heading { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 自建歌单：音乐页子标签 / 歌单详情 / 文件多选 / 播放条收藏
      '.dsh-music-subtabs { display: flex; gap: 4px; flex-wrap: wrap; }\n' +
      '.dsh-music-subtab { flex: none; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; border-radius: 16px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-subtab:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-subtab.active { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: #fff; }\n' +
      '.dsh-music-subtab.add { width: 30px; padding: 4px 0; text-align: center; color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist { display: flex; flex-direction: column; flex: 1; }\n' +
      '.dsh-music-playlist-empty { flex: 1; display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-playlist-head { display: flex; align-items: center; gap: 6px; padding: 2px 2px 0; }\n' +
      '.dsh-music-playlist-btn { flex: none; background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; padding: 2px 8px; }\n' +
      '.dsh-music-playlist-btn:hover { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-missing { flex: none; margin-left: auto; font-size: 11px; color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      '.dsh-music-playlist-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-playlist-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-playlist-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini { flex: none; width: 20px; height: 20px; padding: 0; border: none; background: transparent; border-radius: 4px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; line-height: 1; }\n' +
      '.dsh-music-playlist-mini:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.del:hover { color: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '.dsh-music-file-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-file-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-file-item.checked { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.1)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-file-check { flex: none; width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4)); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; }\n' +
      '.dsh-music-file-item.checked .dsh-music-file-check { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: #fff; }\n' +
      '.dsh-music-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 曲库每行：track 按钮 + 行尾「＋」（加入歌单）
      '.dsh-music-track-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-track-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-track-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.add { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-add-pop { position: fixed; z-index: 1200; min-width: 150px; max-width: 210px; display: flex; flex-direction: column; gap: 2px; padding: 6px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-add-pop-item { display: block; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-add-pop-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-add-pop-item.new { color: var(--dsh-music-accent, #2f9e6e); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); margin-top: 2px; padding-top: 6px; }\n' +
      '.dsh-music-bar-btn.fav { color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-btn.fav.on { color: var(--dsh-music-accent, #2f9e6e); }\n';

    return module.exports;
  },
});
