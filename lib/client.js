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
    const ReactDOM = require('react-dom');
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    // Directory/file pickers are rendered into the panel DOM, but the panel's
    // initial height is small (empty track list => only ~200px + 60px), which
    // would clamp the picker and show just a few directory rows. Portal the
    // overlay to <body> (position: fixed; inset: 0) so it spans the whole DSH
    // window instead of the panel, regardless of the panel size.
    const createPortal = (ReactDOM && typeof ReactDOM.createPortal === 'function')
      ? (node, container) => ReactDOM.createPortal(node, container)
      : (node) => node; // defensive fallback (react-dom is always provided by DSH)
    const portalToBody = (node) => createPortal(node, document.body);

    // 把弹层锚定在某个按钮/容器正上方（fixed 定位，居中于其水平中心）。
    // 用于音量/模式/章节目录等从播放条上弹出的弹层：这些弹层所在的按钮组
    // 在折叠（overflow:hidden）容器内，弹层需 portal 到 body 并以 fixed 定位
    // 才能不被裁剪。maxW 为弹层的最大宽度，用于水平 clamp 防止宽弹层溢出视口。
    // 无目标元素时回退到视口底部中央。
    const anchorAbove = (el, maxW = 380) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = (el && typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      const cx = (r && r.width > 0) ? r.left + r.width / 2 : vw / 2;
      const margin = 8;
      const clampLeft = Math.max(margin, Math.min(vw - margin, cx));
      const top = (r && r.height > 0) ? Math.max(0, r.top - 6) : vh - 40;
      // 居中后 clamp 左边缘，让最大 maxW 宽的弹层完整落在视口内。
      const half = Math.min(maxW / 2, vw / 2 - margin);
      const left = Math.max(margin + half, Math.min(vw - margin - half, clampLeft));
      return { position: 'fixed', left: Math.round(left), top: Math.round(top), transform: 'translate(-50%, -100%)' };
    };

    // 以播放面板中心为基准的固定定位样式（面板可拖拽，弹窗随其居中）。
    // halfW 为目标弹窗的近似半宽；maxH 为弹窗最大高度（px）：垂直 clamp 用
    // maxH 的一半，保证 translate 居中后弹窗完整落在视口内；内容超过 maxH 时
    // 由内部 .dsh-music-picker-list 滚动承载（底部按钮保持固定可见）。
    // 面板不可见/无尺寸（如关闭态）时回退到视口中心。on 控制是否真正计算。
    const panelCenterStyle = (panelRef, on, halfW, maxH) => {
      if (!on) return null;
      const pr = (panelRef && panelRef.current) ? panelRef.current.getBoundingClientRect() : null;
      const vw = window.innerWidth, vh = window.innerHeight;
      const cx = (pr && pr.width > 0) ? pr.left + pr.width / 2 : vw / 2;
      const cy = (pr && pr.height > 0) ? pr.top + pr.height / 2 : vh / 2;
      const clampC = (v, lo, hi) => (lo <= hi ? Math.max(lo, Math.min(v, hi)) : v);
      const halfWm = Math.min(halfW, vw / 2);
      const halfHm = Math.min(maxH / 2, vh / 2);
      return {
        position: 'fixed',
        left: clampC(cx, halfWm, vw - halfWm),
        top: clampC(cy, halfHm, vh - halfHm),
        transform: 'translate(-50%, -50%)',
        maxHeight: maxH + 'px',
        margin: 0,
      };
    };

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
    const PREF_QQ_FAV = 'dsh-music-qq-fav'; // 「我喜欢」收藏 songid/songmid（本地兜底，服务器读失败也可用）
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
    // Playback-panel geometry: default CSS width (must match .dsh-music-panel),
    // resize bounds, and the viewport-height fraction cap when user-resized.
    const PANEL_W = 460;
    const PANEL_MIN_W = 320;
    const PANEL_MAX_W = 720;
    const PANEL_MIN_H = 200;
    const PANEL_MAX_H_VH = 0.8;
    // Restore the playback-panel position ({x,y,w,h}) previously saved by
    // dragging/resizing, if any. Old saves ({x,y,h}) migrate with a default width.
    function loadPanelPos() {
      const raw = loadPref(PREF_PANEL_POS);
      if (raw === null) return null;
      try {
        const p = JSON.parse(raw);
        if (p && typeof p.x === 'number' && typeof p.y === 'number'
          && typeof p.h === 'number' && p.h > 0) {
          return { x: p.x, y: p.y, w: (typeof p.w === 'number' && p.w > 0) ? p.w : PANEL_W, h: p.h };
        }
      } catch (e) {}
      return null;
    }
    const jsonGet = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json());
    const jsonPost = (url, body) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then((r) => r.json());

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
      // 播放模式弹层是否打开（portal 到 body 时让播放条按钮保持展开、不因移出而收起）。
      modeMenuOpen: false,
      // AI 讲书 TTS voice: available voices come from /manifest, the selection
      // persists in localStorage and rides the chunk URL so the host re-synthesizes.
      // voiceSwitching = a new voice is being synthesized in the background.
      voices: [], voice: '白桦', voiceSwitching: false,
      // 自建歌单：manifest.playlists 即数据源；scope 为当前播放范围（曲库/歌单），
      // subTab 为音乐页内的子标签（'library' 或歌单 id）。
      playlists: [], scope: { kind: 'library' }, subTab: 'library',
      // 在线 QQ 曲目是否已收藏到「我喜欢」（仅当播放 qq: 曲目时有意义）。
      qqFaved: false,
      // 已收藏到「我喜欢」的歌曲 songid / songmid 集合（用于判断当前曲目是否已收藏）。
      qqFavIds: [],
      qqFavMids: [],
      // 「我喜欢」收藏成功/取消成功后的递增计数，供 QQ 面板刷新该歌单数目。
      qqFavRev: 0,
      // 自定义输入弹窗（替代浏览器 prompt）：{ id, title, initial, onOk } | null。
      prompt: null,
      // 自定义确认弹窗（替代浏览器 confirm）：{ title, message, onOk, okText, danger } | null。
      confirm: null,
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
    // 自定义输入弹窗（替代浏览器 prompt）：openPrompt 打开、closePrompt 关闭，
    // onOk(value) 在用户点「确定」时收到去空格后的值；点「取消」/关闭不回调。
    let promptSeq = 0;
    function openPrompt(title, initial, onOk) {
      set({ prompt: { id: ++promptSeq, title, initial: (initial || ''), onOk } });
    }
    function closePrompt() {
      set({ prompt: null });
    }
    // 自定义确认弹窗（替代浏览器 confirm）：点「确定」回调 onOk()；
    // 点「取消」/关闭/Esc 不回调。danger=true 时确定按钮用危险色提示。
    function openConfirm(title, message, onOk, okText, danger) {
      set({ confirm: { title, message: (message || ''), onOk, okText: (okText || '确定'), danger: !!danger } });
    }
    function closeConfirm() {
      set({ confirm: null });
    }

    const trackById = (id) => (store.tracks || []).find((t) => t.id === id) || null;

    // ---- 自建歌单：范围 / 解析 / 收藏 ----
    const FAV_PLAYLIST_ID = 'pl-fav';
    const playlistById = (id) => (store.playlists || []).find((p) => p.id === id) || null;
    // 解析任意可播放对象：歌单成员 id（'p:'+path）优先，其次曲库曲目。
    function resolvePlayable(id) {
      if (id === null || id === undefined) return null;
      if (String(id).startsWith('qq:')) {
        const mid = String(id).slice(3);
        const song = (store.qqQueue || []).find((t) => String(t.songmid || t.id) === mid);
        return { id, name: (song && song.title) || store.currentName || 'QQ音乐', url: '/dsh-music/qq/play/' + mid, artists: (song && song.artists) || [] };
      }
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
      if (s.kind === 'qq') return (store.qqQueue || []).map((t) => 'qq:' + String(t.songmid || t.id)); // 在线队列
      if (s.kind === 'playlist') {
        const pl = playlistById(s.id);
        if (pl && pl.tracks && pl.tracks.length > 0) return pl.tracks.map((t) => t.id);
        return (store.tracks || []).map((t) => t.id);
      }
      return (store.tracks || []).map((t) => t.id);
    }
    function scopeKey() {
      const s = store.scope || { kind: 'library' };
      if (s.kind === 'qq') return 'qq';
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
      // 在线 QQ 曲目：收藏状态走 store.qqFaved（QQ 音乐「我喜欢」）。
      if (store.currentId !== null && String(store.currentId).startsWith('qq:')) return !!store.qqFaved;
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
    // 本地持久化「我喜欢」songid/songmid 集合：即使服务器读接口失败（如
    // 缺少 enc_host_uin），已收藏歌曲的爱心状态依然可靠；服务器读到后以服务器为准。
    function persistQQFav(ids, mids) {
      try { savePref(PREF_QQ_FAV, JSON.stringify({ ids: ids || [], mids: mids || [] })); } catch (e) {}
    }
    function loadQQFavLocal() {
      try {
        const raw = loadPref(PREF_QQ_FAV);
        if (raw) { const d = JSON.parse(raw); return { ids: Array.isArray(d.ids) ? d.ids : [], mids: Array.isArray(d.mids) ? d.mids : [] }; }
      } catch (e) {}
      return { ids: [], mids: [] };
    }
    // 在线 QQ 曲目收藏切换：加入/移出 QQ 音乐「我喜欢」。
    function toggleQQFav() {
      if (store.currentId === null || !String(store.currentId).startsWith('qq:')) return;
      const mid = String(store.currentId).slice(3);
      const song = (store.qqQueue || []).find((t) => String(t.songmid || t.id) === mid);
      if (!song) return;
      const sid = Number(song.songid) || 0;
      const smid = String(song.songmid || '');
      const action = store.qqFaved ? 'remove' : 'add';
      fetch('/dsh-music/qq/fav', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, song }),
      })
        .then((r) => r.json().then((d) => ({ d, status: r.status })).catch(() => ({ d: null, status: r.status })))
        .then(({ d, status }) => {
          if (d && d.ok) {
            set({ qqFaved: !!d.faved });
            // 同步本地「我喜欢」id/mid 集合，便于后续曲目判断（并持久化兜底）。
            if (sid || smid) {
              const ids = new Set(store.qqFavIds || []);
              const mids = new Set(store.qqFavMids || []);
              if (action === 'add') { if (sid) ids.add(sid); if (smid) mids.add(smid); }
              else { if (sid) ids.delete(sid); if (smid) mids.delete(smid); }
              const idsA = [...ids], midsA = [...mids];
              set({ qqFavIds: idsA, qqFavMids: midsA });
              persistQQFav(idsA, midsA);
            }
            // 通知 QQ 面板刷新「我喜欢」歌单的数目。
            set({ qqFavRev: (store.qqFavRev || 0) + 1 });
          }
          else if (d && d.error) set({ error: d.error });
          else set({ error: '收藏失败（HTTP ' + status + '），请重试' });
        })
        .catch(() => { set({ error: '收藏失败，请重试' }); });
    }
    // 拉取「我喜欢」已收藏 songid/songmid 集合（每个会话只拉一次）。
    // 读失败时回退到本地持久化集合，保证爱心状态可靠。
    let qqFavFetched = false;
    function ensureQQFavIds() {
      if (qqFavFetched) return Promise.resolve({ ids: store.qqFavIds || [], mids: store.qqFavMids || [] });
      qqFavFetched = true;
      return fetch('/dsh-music/qq/liked', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (d && d.ok && Array.isArray(d.ids)) {
            const ids = d.ids, mids = Array.isArray(d.mids) ? d.mids : [];
            set({ qqFavIds: ids, qqFavMids: mids });
            persistQQFav(ids, mids);
            return { ids, mids };
          }
          // 服务器读失败：回退本地持久化集合。
          const local = loadQQFavLocal();
          set({ qqFavIds: local.ids, qqFavMids: local.mids });
          return local;
        })
        .catch(() => {
          const local = loadQQFavLocal();
          set({ qqFavIds: local.ids, qqFavMids: local.mids });
          return local;
        });
    }
    // 登录成功后可强制重新拉取「我喜欢」集合（此前可能因未登录而缓存了空数组）。
    function refreshQQFavIds() {
      qqFavFetched = false;
      return ensureQQFavIds();
    }
    // 判断当前在线曲目是否已收藏，据此点亮爱心。
    function checkQQFavForCurrent() {
      if (store.currentId === null || !String(store.currentId).startsWith('qq:')) return;
      const mid = String(store.currentId).slice(3);
      const song = (store.qqQueue || []).find((t) => String(t.songmid || t.id) === mid);
      const smid = (song && String(song.songmid || '')) || '';
      const sid = (song && Number(song.songid)) || 0;
      if (!smid && !sid) { set({ qqFaved: false }); return; }
      ensureQQFavIds().then(({ ids, mids }) => {
        if (store.currentId !== 'qq:' + mid) return; // 已切歌，忽略过期结果
        const liked = (smid !== '' && (mids || []).includes(smid)) || (sid > 0 && (ids || []).includes(sid));
        set({ qqFaved: !!liked });
      });
    }
    // 收藏切换：加入/移出「我最喜欢」。在线 QQ 曲目走 QQ 音乐「我喜欢」。
    function toggleFav() {
      if (store.currentId !== null && String(store.currentId).startsWith('qq:')) { toggleQQFav(); return; }
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
      openPrompt('新建歌单名称', '', (trimmed) => {
        if (!trimmed) return;
        fetch('/dsh-music/playlist', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        }).then((r) => r.json()).then((r) => {
          if (r && r.playlist) {
            set({ playlists: [...(store.playlists || []), r.playlist], subTab: r.playlist.id });
          }
        }).catch(() => {});
      });
    }
    function onRenamePlaylist(pl) {
      openPrompt('重命名歌单「' + pl.name + '」', pl.name, (trimmed) => {
        if (trimmed === pl.name) return;
        fetch('/dsh-music/playlist/rename', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: pl.id, name: trimmed }),
        }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); }).catch(() => {});
      });
    }
    function onDeletePlaylist(pl) {
      openConfirm('删除歌单', '删除歌单「' + pl.name + '」？歌曲文件不会被删除。', () => {
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
      }, '删除', true);
    }
    // 一键清空歌单（任何歌单都可用，含系统「我最喜欢」；仅从歌单移除，不删文件）。
    function onClearPlaylist(pl) {
      const n = (pl.tracks || []).length;
      if (n === 0 && !pl.missing) return;
      openConfirm('清空歌单', '清空歌单「' + pl.name + '」？将移除全部 ' + n + ' 首歌曲' + (pl.missing > 0 ? '（另有 ' + pl.missing + ' 首已失效一并清除）' : '') + '，歌曲文件不会被删除。', () => {
        fetch('/dsh-music/playlist/clear', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: pl.id }),
        }).then((r) => r.json()).then((r) => {
          if (r && r.playlist) updatePlaylistInStore(r.playlist);
        }).catch(() => {});
      }, '确定', true);
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
      if (String(store.currentId).startsWith('qq:')) {
        // 在线曲目：保存曲目 + 队列（刷新后可恢复）。流地址每次经代理重新获取，可续播。
        const mid = String(store.currentId).slice(3);
        const song = (store.qqQueue || []).find((t) => String(t.songmid || t.id) === mid);
        if (!song) return;
        savePref(PREF_PLAYBACK, JSON.stringify({
          kind: 'qq', id: store.currentId, name: store.currentName,
          artists: store.currentArtists || [],
          queue: store.qqQueue || [], source: store.qqSource || '在线',
          ts: Date.now(),
        }));
        return;
      }
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
      // 在线曲目：为避免为频谱预取而把下一首整段下载，跳过。
      if (store.scope && store.scope.kind === 'qq') return;
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
    // 在线 QQ 队列连续失败的跳过次数：某首歌因版权下架/拿不到地址而触发
    // <audio> error 时自动跳到下一首；连续跳过次数达到队列长度（整列都试过）
    // 即停止报错——且停止后不再 step，杜绝无限循环跳歌。成功播放(onPlay)清零。
    let qqErrorSkipCount = 0;
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
    // play() 的失败原因五花八门：AbortError（被 pause()/load()/切歌中断）、
    // “interrupted by ...”等都不是自动播放被拦截。这里**反向判断**：只有错误
    // 明确是自动播放被拦截（NotAllowedError，或 Chromium 的 not-allowed 文案）才
    // 提示“浏览器拦截了自动播放”。这样双击/连点/快速切歌产生的中断一律不会误报
    // （本环境里中断错误未必是标准 AbortError，只过滤 AbortError 会漏网）。
    function isAutoplayBlocked(err) {
      try {
        if (!err) return false;
        const n = String(err.name || '');
        const m = String((err && err.message) || '');
        if (n === 'NotAllowedError') return true;
        return /not allowed|autoplay|user (gesture|interaction|activation)|didn'?t interact|play\(\) failed/i.test(m);
      } catch (e) { return false; }
    }
    // 播放被主动中断（pause/stop/切歌）：用于抑制“播放失败”这类误导提示。
    function isPlayAborted(err) {
      try {
        return !!err && (err.name === 'AbortError' || /abort|interrupted/i.test(String((err && err.message) || '')));
      } catch (e) { return false; }
    }
    // 最近一次点击启动曲目的时刻。双击的第二次点击会落在已激活的行上；部分
    // 浏览器/环境里那次点击的 detail 仍为 1，仅靠 detail>=2 判断不可靠，这里用
    // 时间窗兜底：刚（600ms 内）通过点击启动的曲目被再次点击，一律视为双击的
    // 第二次点击而忽略，避免把它当成“再点一次=暂停/重播”并触发上面的误报。
    let lastPlayStartTs = 0;
    function shouldIgnoreRowClick(e, isActive) {
      if (e && e.detail >= 2) return true;
      if (isActive && Date.now() - lastPlayStartTs < 600) return true;
      return false;
    }
    function startPlay(id) {
      const track = resolvePlayable(id);
      if (track === null) return;
      lastPlayStartTs = Date.now();
      restoredMusicPos = null;
      bookRestorePos = -1;
      audio.src = track.url;
      audio.load();
      set({ currentId: id, currentName: track.name, currentArtists: track.artists || [], pendingId: null, pendingName: null, error: null, tocOpen: false, currentSection: '', qqFaved: false });
      syncShufflePos();
      loadEnvelope(id, track.url);
      prefetchNext();
      savePlayback();
      // 在线曲目：判断当前曲目是否已收藏到「我喜欢」，点亮爱心。
      if (String(id).startsWith('qq:')) checkQQFavForCurrent();
      const promise = audio.play();
      if (promise !== undefined && typeof promise.catch === 'function') {
        promise.catch((err) => {
          if (!isAutoplayBlocked(err)) return;
          set({ error: '浏览器拦截了自动播放，请点击一次播放按钮', pendingId: id, pendingName: track.name });
        });
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
        bookAutoRetried = false; // manual retry resets the auto-retry budget
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
    // 单块时长上限：分块是 ≤150 字的散文，实测全书块长 10~36 秒，极端慢读也不
    // 会超过 2 分钟。若浏览器报的 duration 远超此值，说明该块 WAV 异常（截断/
    // 字节率错误导致时长虚高）——否则 <audio> 会「播静音」直到虚高时长走完。
    // 注意：这只是兜底。命中时仅静音重试一次；重试后仍超长则正常播放、不报错
    // （万一真是极慢的真实长块也不会被误杀）。主防御在 Host 的 WAV 头/静音校验。
    const BOOK_MAX_CHUNK_SEC = 180;
    let restoredMusicPos = null; // restored music position to display until the audio truly reaches it
    let bookRestorePos = -1;   // restored book's in-chunk position, seeked on play
    // 当前块是否已自动重试过一次（瞬时 LLM 合成失败时先静音重试一次，
    // 只有重试仍失败才弹错误 + 手动重试）。成功播放后复位。
    let bookAutoRetried = false;
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
      chapter: '章节', part: '分部', preface: '前言',
      epilogue: '后记', named: '分节', toc: '目录',
    })[t] || '正文';
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
        const cid = store.currentId;
        const isBook = cid !== null && String(cid).startsWith('book:');
        const isQQ = cid !== null && String(cid).startsWith('qq:');
        // 在线曲目：点播放条上的播放列表按钮 → 打开「在线」tab（并恢复上次所在层）。
        set({ tab: isBook ? 'book' : (isQQ ? 'qq' : 'music') });
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
      // 用户点击/跳章启动小说同样刷新双击时间窗（与音乐 startPlay 对齐），
      // 保证 detail 不可靠的环境里双击小说的第二次点击也能被忽略。
      lastPlayStartTs = Date.now();
      restoredMusicPos = null;
      const wasFresh = from === 0;
      // `silent` is set for the hidden ended→next auto-advance: the switch is
      // near-instant (server-side synthesis cache) so we don't flash a spinner
      // at every chunk boundary. Only user-initiated plays show it.
      const showBuffer = !silent;
      set({ currentId: 'book:' + id, currentName: book.name, currentArtists: [], pendingId: null, pendingName: null, error: null, vizState: 'ok' });
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
    function playBook(id, from = 0) { unlockAutoplay(); bookTotal = -1; bookBufferedFrom = -1; bookBaseTime = 0; bookRestorePos = -1; bookAutoRetried = false; playBookFrom(id, from, false); saveCurrentBookPlayback(); }
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
        // 进入新块：每个块各拥有一次自动重试的机会。
        bookAutoRetried = false;
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
        // 在线 QQ 曲目：刷新恢复后没有保存进度，但需要主动加载流地址才能播放
        // （在线流每次经代理重新获取，不能沿用旧的 audio.src）。
        if (String(store.currentId).startsWith('qq:')) {
          const track = resolvePlayable(store.currentId);
          if (track !== null && audio.currentSrc !== new URL(track.url, window.location.href).href) {
            audio.src = track.url;
            audio.load();
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
        if (promise !== undefined && typeof promise.catch === 'function') promise.catch((err) => { if (isAutoplayBlocked(err)) set({ error: '浏览器拦截了自动播放，请点击播放按钮' }); });
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
          set({ voiceSwitching: false, voice: prevVoice, bookError: '声音切换失败：' + String((err && err.message) || err) });
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
      bookAutoRetried = false;
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
          // 讲书块兜底：若浏览器报的时长远超正常范围，先静音重试一次（坏 WAV
          // 可能靠重试恢复）。重试后仍超长则按真实长块正常播放——Host 已做
          // WAV 头/静音校验，能到这里的几乎不可能是坏 WAV，因此绝不误杀。
          if (store.currentId !== null && String(store.currentId).startsWith('book:')
            && audio.duration > BOOK_MAX_CHUNK_SEC) {
            if (!bookAutoRetried) {
              bookAutoRetried = true;
              const id = String(store.currentId).slice('book:'.length);
              unlockAutoplay();
              playBookFrom(id, bookFromRef, true);
              return; // retry re-loads; don't clobber duration yet
            }
          }
          set({ duration: (bookTimeBase() + audio.duration) });
        }
      };
      const onPlay = () => { qqErrorSkipCount = 0; set({ playing: true, error: null }); acquireWakeLock(); };
      const onPause = () => { set({ playing: false }); savePlayback(); releaseWakeLock(); };
      const onEnded = () => {
        // A novel plays chunk-by-chunk: when a chunk ends, auto-advance to the
        // next block until the whole book is done, then stop (never step into
        // the music list). Book ids are 'book:'-prefixed.
        if (store.currentId !== null && String(store.currentId).startsWith('book:')) {
          // 切块进行中（bookBuffering 为真，新块还没开始播放）忽略旧块的
          // ended：防止陈旧事件重复触发导致跳块/时间空走。
          if (store.bookBuffering) return;
          if (!maybeAdvanceBook()) stop();
          return;
        }
        if (store.mode === 'single' && store.currentId !== null) {
          audio.currentTime = 0;
          const promise = audio.play();
          if (promise !== undefined && typeof promise.catch === 'function') promise.catch((err) => { if (!isPlayAborted(err)) set({ error: '播放失败', playing: false }); });
          return;
        }
        step(1);
      };
      const onError = () => {
        // A novel chunk that fails to load (TTS error / timeout / decode) must
        // clear the "合成中…" spinner and surface a real message instead of
        // leaving the bar stuck buffering forever.
        if (store.currentId !== null && String(store.currentId).startsWith('book:')) {
          // 瞬时 LLM 合成失败：先自动静音重试一次当前块（听书不中断），
          // 重试仍失败才进入错误 + 手动重试。
          if (!bookAutoRetried) {
            bookAutoRetried = true;
            const retryId = String(store.currentId).slice('book:'.length);
            unlockAutoplay();
            playBookFrom(retryId, bookFromRef, true);
            return;
          }
          set({ bookBuffering: false, bookBufferingSince: 0, playing: false, bookError: '讲书音频获取失败，请重试' });
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
          // 在线 QQ 队列：某首歌因版权下架/拿不到播放地址而加载失败时，自动
          // 跳到下一首继续播放（不因单曲失败中断整个队列）；只有队列里就这一
          // 首、或连续跳过次数已达队列长度（整列都试过）才停下报错——且停止后
          // 不再 step，杜绝无限循环跳歌。
          const isQQTrack = store.currentId !== null && String(store.currentId).startsWith('qq:');
          const qLen = (store.qqQueue || []).length;
          if (isQQTrack && qLen > 1 && qqErrorSkipCount < qLen) {
            qqErrorSkipCount++;
            step(1);
            return;
          }
          set({ error: '音频加载或解码失败', playing: false });
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
        if (o && o.kind === 'qq') { set({ scope: { kind: 'qq' } }); return; }
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
      // 在线 QQ 曲目：恢复当前曲目 + 队列 + 在线 scope + 在线 tab。
      if (saved.kind === 'qq' || (saved.id && String(saved.id).startsWith('qq:'))) {
        set({
          currentId: saved.id,
          currentName: saved.name || 'QQ音乐',
          currentArtists: Array.isArray(saved.artists) ? saved.artists : [],
          scope: { kind: 'qq' },
          qqQueue: Array.isArray(saved.queue) ? saved.queue : [],
          qqSource: saved.source || '在线',
          pendingId: null, pendingName: null, error: null,
          tab: 'qq',
        });
        // 更新时间戳，避免被当作旧数据。
        savePref(PREF_PLAYBACK, JSON.stringify({ ...saved, ts: Date.now() }));
        // 恢复在线曲目后按「我喜欢」集合刷新爱心状态。
        checkQQFavForCurrent();
        return;
      }
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
        currentArtists: track.artists || [],
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
        currentId: 'book:' + book.id, currentName: book.name, currentArtists: [],
        position: base + pos, duration: base + (Number.isFinite(audio.duration) ? audio.duration : 0),
        pendingId: null, pendingName: null, error: null, playing: false,
        bookBuffering: false, bookBufferingSilent: false, bookError: '', bookBufferingSince: 0,
      });
      bookRestorePos = pos;
      // 恢复后立即加载章节结构并计算当前章节：让播放条章节徽标与章节目录
      // 立刻显示正在播放的章节（而不是等用户点 ▶、playBookFrom 才开始加载）。
      // ensureBookToc 内部会 set bookToc；这里再补上 currentSection。
      void ensureBookToc(book.id).then((meta) => {
        if (meta === null || meta.sections.length === 0) return;
        set({ currentSection: sectionForChunk(meta.sections, from) });
      });
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
        set({ loading: false, error: '无法读取音乐库：' + String((err && err.message) || err) });
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
          // 换目录只刷新列表，不调用 restoreLatest：否则播放中的在线 QQ 曲目会
          // 触发 restorePlayback 把 tab 强制切回「QQ音乐」（选完目录被跳回的问题）。
        } else {
          set({ loading: false, error: (result && result.error) || '设置目录失败' });
        }
      }).catch((err) => {
        set({ loading: false, error: '设置目录失败：' + String((err && err.message) || err) });
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
    // 目录面包屑：把绝对路径渲染成逐个可点击的目录名，点击任一段即可直接跳到
    // 该目录；最后一段（当前目录）高亮展示、不可点击。crumbs 为空时回退显示
    // 目录名/路径纯文本（例如驱动列表或家目录未配置）。
    function renderCrumbs(crumbs, path, name, onGo) {
      if (!crumbs || crumbs.length === 0) {
        return React.createElement('span', { className: 'dsh-music-crumb-plain' }, name || path || '家目录');
      }
      const els = [];
      crumbs.forEach((c, i) => {
        if (i > 0) els.push(React.createElement('span', { key: 'sep' + i, className: 'dsh-music-crumb-sep' }, '\u203A'));
        const isLast = i === crumbs.length - 1;
        if (isLast) {
          els.push(React.createElement('span', { key: 'c' + i, className: 'dsh-music-crumb cur', title: c.path }, c.name));
        } else {
          els.push(React.createElement('button', {
            key: 'c' + i,
            className: 'dsh-music-crumb',
            title: c.path,
            onClick: () => onGo(c.path),
          }, c.name));
        }
      });
      return els;
    }
    function MusicNote(props) {
      const cls = props.className || '';
      return React.createElement('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        React.createElement('path', { d: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z' }));
    }
    // 讲书（AI 听书）时名称前的话筒图标，贴合「朗读/播讲」功能，
    // 与音乐的音符图标区分。
    function MicIcon(props) {
      const cls = props.className || '';
      return React.createElement('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        React.createElement('path', { d: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z' }));
    }
    // 播放控制图标（上一首/播放/暂停/下一首/停止）：用 SVG 替代 ⏮▶⏸⏭⏹ 文本字形。
    // 这些 Unicode 符号（尤其 ⏸ 常以 emoji 呈现）宽高/基线不一致，点击切换会让按钮
    // 大小与位置偏移；统一用同尺寸 viewBox=24 的 SVG，保证按钮恒定尺寸、图标精确居中。
    const iconSvg = (path, w = 14) => (props) => React.createElement('svg', { className: props.className || '', width: w, height: w, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
      React.createElement('path', { d: path }));
    const PlayIcon = iconSvg('M8 5v14l11-7z');
    const PauseIcon = iconSvg('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    const PrevIcon = iconSvg('M6 6h2v12H6zm3.5 6l8.5 6V6z');
    const NextIcon = iconSvg('M6 18l8.5-6L6 6v12zM16 6h2v12h-2z');
    const StopIcon = iconSvg('M6 6h12v12H6z');

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
          title: '音量 ' + pct + '%' },
        React.createElement('div', { className: 'dsh-music-vol-track' }),
        React.createElement('div', { className: 'dsh-music-vol-fill', style: { height: pct + '%' } }),
        React.createElement('div', { className: 'dsh-music-vol-thumb', style: { bottom: 'calc(' + pct + '% - 7px)' } }),
      );
    }
    // Fallback voice list if /manifest hasn't delivered one (older host / offline).
    const FALLBACK_VOICES = [
      { id: '冰糖', label: '冰糖', gender: '女', lang: '中文' },
      { id: '茉莉', label: '茉莉', gender: '女', lang: '中文' },
      { id: '苏打', label: '苏打', gender: '男', lang: '中文' },
      { id: '白桦', label: '白桦', gender: '男', lang: '中文' },
    ];
    // AI 讲书 voice picker, shown in the volume popup only while reading a book.
    function VoicePicker() {
      const s = useStore();
      const voices = (s.voices && s.voices.length > 0) ? s.voices : FALLBACK_VOICES;
      const cur = voices.find((v) => v.id === s.voice);
      const currentLabel = cur ? (cur.label + (cur.gender && cur.gender !== '自动' ? '（' + cur.gender + '）' : '')) : s.voice;
      return React.createElement('div', { className: 'dsh-music-voice' },
        React.createElement('span', { className: 'dsh-music-voice-label' }, 'AI 声音'),
        React.createElement('select', {
          className: 'dsh-music-voice-select',
          value: voices.some((v) => v.id === s.voice) ? s.voice : '白桦',
          title: '当前：' + currentLabel,
          onChange: (e) => setVoice(e.target.value),
        },
          voices.map((v) => React.createElement('option', {
            key: v.id, value: v.id,
          }, (v.label || v.id) + (v.lang ? '·' + v.lang : '') + (v.gender && v.gender !== '自动' ? '（' + v.gender + '）' : ''))),
        ),
        s.voiceSwitching ? React.createElement('span', { className: 'dsh-music-voice-switching' }, '切换中…') : null,
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
          ' AI 合成中… ' + secs + 's');
      }
      if (s.bookError) {
        return React.createElement('span', { className: 'dsh-music-bar-berr', title: s.bookError },
          React.createElement('span', { className: 'dsh-music-bar-berr-text' }, s.bookError),
          React.createElement('button', {
            className: 'dsh-music-bar-btn retry',
            title: '重新合成当前段落',
            onClick: retryBook,
          }, '重试'));
      }
      return null;
    }
    function NowPlayingBar() {
      const s = useStore();
      const [volOpen, setVolOpen] = useState(false);
      const volRef = useRef(null);
      const volPopRef = useRef(null);
      const [barHover, setBarHover] = useState(false);
      // 滑出延迟：鼠标离开播放条后等 1s 再隐藏控制按钮，防止误移出导致按钮组收回。
      // 若在延迟内重新进入，取消定时器、保持展开。
      const hoverTimerRef = useRef(null);
      useEffect(() => () => { if (hoverTimerRef.current !== null) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } }, []);
      const tocTriggerRef = useRef(null);
      useEffect(() => {
        if (!volOpen) return;
        // 点击外部关闭：目标在按钮容器内、或 portal 到 body 的弹窗内（弹窗已不在
        // 按钮容器的 DOM 子树上，需用 ref 单独判断，否则点击弹窗内部也会误关闭）。
        const onClick = (e) => {
          if (volRef.current !== null && volRef.current.contains(e.target)) return;
          if (volPopRef.current !== null && volPopRef.current.contains(e.target)) return;
          setVolOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
      }, [volOpen]);
      const hasTrack = s.currentName !== null || s.pendingName !== null;
      const name = s.currentName || s.pendingName;
      const showHint = s.pendingName !== null && s.currentId === null;
      const panelCls = 'dsh-music-mode-trigger' + (s.panelOpen ? ' active' : '');
      let vizBadge = null;
      // 频谱不可用提示仅对本地/讲书曲目有效（重试能重新拉取独立音频源）。
      // 在线 QQ 曲目与音频走同一代理流：频谱解码失败几乎必然意味着整段流
      // 播放失败，此时由音频 error 展示真实原因（如「音频加载或解码失败」），
      // 这里不再误导性地显示「频谱不可用，点击重试」。
      const isQQTrack = s.currentId !== null && String(s.currentId).startsWith('qq:');
      if (hasTrack && s.vizState === 'unavailable' && !isQQTrack) {
        vizBadge = React.createElement('button', {
          className: 'dsh-music-bar-warn',
          title: '频谱不可用，点击重试',
          onClick: () => { const t = resolvePlayable(s.currentId); if (t !== null) loadEnvelope(t.id, t.url); },
        }, '频谱不可用，点击重试');
      }
      const isBook = s.currentId !== null && String(s.currentId).startsWith('book:');
      // 名称前的图标：讲书用话筒图标，音乐用音符图标（空闲态无曲目 = 音乐）。
      const note = React.createElement(isBook ? MicIcon : MusicNote, { className: 'dsh-music-note' });
      // While a novel chunk is being synthesized, show a live "合成中… Ns"
      // counter (so the wait is transparent, not an endless spinner) and, on
      // error, the real message plus a retry button. Music keeps its old UI.
      let afterName = null;
      if (isBook) afterName = React.createElement(BookStatus, null);
      // 当前在读章节徽标（讲书时显示，如"▸ 第三章　泰山压顶"）。
      let sectionBadge = null;
      if (isBook && s.currentSection) {
        sectionBadge = React.createElement('span', { className: 'dsh-music-bar-section', title: s.currentSection },
          '▸ ' + s.currentSection);
      }
      // 音乐来源徽标：在线 QQ 曲目在歌名后标「QQ音乐」，便于区分本地/在线。
      let sourceBadge = null;
      if (s.currentId !== null && String(s.currentId).startsWith('qq:')) {
        sourceBadge = React.createElement('span', { className: 'dsh-music-bar-src', title: 'QQ音乐（在线）' }, 'QQ音乐');
      }
      // 歌手名（在线歌曲有 artists；本地/讲书通常没有，则不显示）。
      const artistText = hasTrack ? (s.currentArtists || []).join(' / ') : '';
      const artistEl = artistText ? React.createElement('span', { className: 'dsh-music-bar-artist' },
        '-',
        React.createElement('span', { className: 'dsh-music-bar-artist-name' }, artistText)) : null;
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
      const showBarBtns = () => { if (hoverTimerRef.current !== null) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } setBarHover(true); };
      // 任一弹层打开时保持按钮展开（弹层 portal 到 body，鼠标可能在弹层上）。
      // 注意：barHover 只反映鼠标是否停留在播放条上；弹层打开期间由 anyPopOpen
      // 让 .on 保持 true，弹层关闭后 .on 随 anyPopOpen 立即收起，无需额外触发。
      const anyPopOpen = volOpen || s.modeMenuOpen || s.tocOpen;
      const hideBarBtns = () => {
        // 滑出延迟 1s：鼠标离开后暂不收起按钮组；若延迟内重新进入则取消。
        if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => { hoverTimerRef.current = null; setBarHover(false); }, 1000);
      };
      const onBarLeave = () => hideBarBtns();
      // 播放条整体透明度：鼠标在播放条上（或任一弹层打开）时完全不透明；离开 1s
      // 收起控件组的同时变半透明（50%），营造「后台静默播放」效果，不干扰用户其它工作。
      // 与控件组 .on 完全同源（barHover || anyPopOpen），保证两者同步变化。
      const barDimmed = !(barHover || anyPopOpen);
      return React.createElement('div', { className: 'dsh-music-bar-wrap' },
        React.createElement('div',
          { className: 'dsh-music-bar' + (isBook ? ' book' : '') + (barDimmed ? ' dimmed' : ''), onMouseEnter: showBarBtns, onMouseLeave: onBarLeave },
          hasTrack
            ? React.createElement('span', { className: 'dsh-music-bar-name', title: name + (artistText ? ' - ' + artistText : '') }, note, ' ', name, artistEl, sourceBadge, afterName)
            : React.createElement('span', { className: 'dsh-music-bar-idle' }, note, ' DSH音乐播放器'),
          // 章节名独立占一整行、完整显示（不再被省略号截断）。
          sectionBadge,
          !isBook && hasTrack && s.playing ? React.createElement('canvas', { className: 'dsh-music-viz', width: 64, height: 14, ref: (el) => { barCanvasNode = el; } }) : null,
          vizBadge,
          // 时长 + 右侧控制按钮是一个组合：右对齐（margin-left:auto）。鼠标进入播放条
          // 时按钮组从右向左滑入，离开时按钮组折叠、时长自动滚到最右。时长始终显示。
          React.createElement('div', { className: 'dsh-music-bar-controls' + ((barHover || anyPopOpen) ? ' on' : '') },
            hasTrack
              ? (showHint
                  ? React.createElement('span', { className: 'dsh-music-bar-hint' }, '⚠ 自动播放被拦截，点击▶解锁')
                  : React.createElement('span', { className: 'dsh-music-bar-time' }, fmtTime(s.position) + ' / ' + fmtTime(s.duration)))
              : null,
            React.createElement('div', { className: 'dsh-music-bar-btns' },
              heartBtn,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: isBook ? '上一章' : '上一首', onClick: () => (isBook ? stepBook(-1) : step(-1)) }, React.createElement(PrevIcon, null)) : null,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '播放/暂停', onClick: togglePlay }, React.createElement(s.playing ? PauseIcon : PlayIcon, null)) : null,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: isBook ? '下一章' : '下一首', onClick: () => (isBook ? stepBook(1) : step(1)) }, React.createElement(NextIcon, null)) : null,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '停止', onClick: stop }, React.createElement(StopIcon, null)) : null,
              // 章节目录按钮：仅讲书（book）时出现，点击弹出章节列表并可跳章。
              // 与音量/播放模式按钮同款圆形样式（dsh-music-mode-trigger）。
              isBook ? React.createElement('div', { className: 'dsh-music-toc-trigger', ref: tocTriggerRef },
                React.createElement('button', {
                  className: 'dsh-music-mode-trigger' + (s.tocOpen ? ' active' : ''),
                  title: '章节目录',
                  onClick: openToc,
                }, React.createElement('svg', {
                  viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
                }, React.createElement('path', { d: 'M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z' }))),
                React.createElement(BookTocPanel, { anchorRef: tocTriggerRef }),
              ) : null,
              // 音乐播放模式按钮：仅在音乐语境（非讲书）显示，与章节目录按钮互斥。
              !isBook ? React.createElement(ModeDropdown, null) : null,
              React.createElement('div', { className: 'dsh-music-bar-vol', ref: volRef },
                React.createElement('button', {
                  className: 'dsh-music-mode-trigger' + (volOpen ? ' active' : ''),
                  title: '音量',
                  onClick: () => setVolOpen((o) => !o),
                }, React.createElement('svg', {
                  viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
                }, React.createElement('path', { d: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z' }))),
              ),
              React.createElement('button', {
                className: panelCls,
                title: s.panelOpen ? '关闭播放列表' : '打开播放列表',
                onClick: togglePanel,
              }, React.createElement('svg', {
                viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
              }, React.createElement('path', {
                d: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
              }))),
            ),
          ),
          // 音量弹层：portal 到 body + fixed 定位，锚定在音量按钮正上方。放在
          // .dsh-music-bar-btns（overflow:hidden 折叠容器）之外，避免被折叠裁剪。
          volOpen ? portalToBody(React.createElement('div', {
            className: 'dsh-music-bar-vol-pop' + (isBook ? ' book' : ''),
            style: anchorAbove(volRef.current, isBook ? 136 : 36),
            ref: volPopRef,
          },
            isBook ? React.createElement(VoicePicker, null) : null,
            React.createElement(VolumeSlider, null),
          )) : null,
        ),
      );
    }
    // Playback-mode metadata + an icon-only dropdown. Icons are inline SVGs filled
    // with currentColor so they match the accent of the other round transport
    // buttons (green), which a native <select> cannot color.
    const MODES = [
      { id: 'single', label: '单曲循环', title: '单曲循环：播放结束重复当前曲目', d: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z' },
      { id: 'order', label: '顺序播放', title: '顺序播放：自动播放列表中的下一首', d: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm14-10v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z' },
      { id: 'shuffle', label: '乱序播放', title: '乱序播放：随机挑选下一首', d: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z' },
    ];
    function ModeIcon(props) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
      }, React.createElement('path', { d: props.d }));
    }
    function ModeDropdown() {
      const s = useStore();
      const open = s.modeMenuOpen;
      const ref = useRef(null);
      const popRef = useRef(null);
      useEffect(() => {
        if (!open) return;
        // 点击外部关闭：目标在按钮容器内、或 portal 到 body 的弹窗内（弹窗已不在
        // 按钮容器的 DOM 子树上，需用 popRef 单独判断，否则点击弹窗内选项也会误关闭）。
        const onClick = (e) => {
          if (ref.current !== null && ref.current.contains(e.target)) return;
          if (popRef.current !== null && popRef.current.contains(e.target)) return;
          set({ modeMenuOpen: false });
        };
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
          onClick: () => set({ modeMenuOpen: !open }),
        }, React.createElement(ModeIcon, { d: cur.d })),
        // 模式弹层 portal 到 body（fixed 定位，锚定按钮正上方）：按钮组在折叠
        // （overflow:hidden）容器内，弹层需逃逸才能不被裁剪。
        open ? portalToBody(React.createElement('div', { className: 'dsh-music-mode-pop', style: anchorAbove(ref.current, 120), ref: popRef },
          MODES.map((m) => React.createElement('button', {
            key: m.id,
            className: 'dsh-music-mode-item' + (s.mode === m.id ? ' active' : ''),
            title: m.title,
            onClick: () => { set({ mode: m.id, modeMenuOpen: false }); },
          }, React.createElement(ModeIcon, { d: m.d }))),
        )) : null,
      );
    }
    // 章节目录弹层：列出当前小说的 前言/章节/尾声 等，点击某节从该章开头播放。
    function BookTocPanel({ anchorRef }) {
      const s = useStore();
      const ref = useRef(null);
      const listRef = useRef(null);
      useEffect(() => {
        if (!s.tocOpen) return;
        const onDown = (e) => {
          if (ref.current !== null && !ref.current.contains(e.target)) closeToc();
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [s.tocOpen]);
      // 打开章节目录时定位到正在播放的章节：把高亮的当前章节滚动进可视区，
      // 而不是从列表顶部开始。依赖 bookToc（打开时可能先为空、随后异步到达）。
      useEffect(() => {
        if (!s.tocOpen) return;
        const list = listRef.current;
        if (list === null) return;
        const active = list.querySelector('.dsh-music-toc-item.active');
        if (active !== null && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
      }, [s.tocOpen, s.bookToc]);
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
          // Same double-click guard as the track/book rows: the second click of a
          // dblclick must not re-start the chapter (which would re-synthesize the
          // same chunk and visibly restart it).
          onClick: (e) => {
            if (e.detail >= 2) return;
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
        : React.createElement('div', { className: 'dsh-music-empty' }, '暂无章节结构（该书无法识别分节。）');
      // 弹层 portal 到 body + fixed 定位，锚定在「章节目录」按钮正上方：
      // 按钮组在折叠（overflow:hidden）容器内，弹层需逃逸才能不被裁剪。
      return portalToBody(React.createElement('div', { className: 'dsh-music-toc', ref, style: anchorAbove(anchorRef ? anchorRef.current : null) },
        React.createElement('div', { className: 'dsh-music-toc-head' },
          React.createElement('span', { className: 'dsh-music-toc-title' }, '章节目录'),
          React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: closeToc }, '✕')),
        React.createElement('div', { className: 'dsh-music-toc-list', ref: listRef }, body),
      ));
    }
    // ---- 在线 QQ 音乐：扫码登录 + 搜索 + 播放（登录后可播 VIP/高音质） ----
    // 播放一首 QQ 在线歌曲（单曲搜索与歌单详情共用）；代理为同源流，走频谱解码。
    // queue：可选，当前来源的歌单/搜索结果，用于播完自动接下一首；不传则只播这一首。
    // 播放一首 QQ 在线歌曲（搜索/歌单/工具共用）；代理为同源流，走频谱解码。
    // queue：当前来源队列（搜索结果或歌单歌曲），播完自动接下一首；sourceLabel：队列来源名。
    function startQQPlayback(song, queue, sourceLabel) {
      const id = String(song.songmid || song.id);
      const url = '/dsh-music/qq/play/' + id;
      const q = (Array.isArray(queue) && queue.length > 0) ? queue.slice() : [song];
      audio.src = url;
      audio.load();
      set({ currentId: 'qq:' + id, currentName: song.title, currentArtists: (song.artists || []), scope: { kind: 'qq' }, qqQueue: q, qqSource: sourceLabel || (q.length > 1 ? '在线' : ''), error: null, qqFaved: false });
      loadEnvelope('qq:' + id, url);
      checkQQFavForCurrent();
      savePlayback();
      const p = audio.play();
      if (p !== undefined && typeof p.catch === 'function') {
        p.catch((err) => { if (!isAutoplayBlocked(err)) return; set({ error: '浏览器拦截了自动播放，请在播放条点击▶解锁', pendingId: 'qq:' + id, pendingName: song.title }); });
      }
    }

    // 在线 QQ 面板的「上次所在层」只在本次会话首次挂载时恢复一次，避免切 tab
    // （QQ 音乐 ↔ 本地音乐/AI讲书）重新挂载时又被 localStorage 里的旧层拉回播放列表页。
    let qqUiRestored = false;
    function QQOnlinePanel({ panelRef }) {
      const s = useStore();
      const [loggedIn, setLoggedIn] = useState(s.qqLoggedIn || false);
      const [uin, setUin] = useState(s.qqUin || '');
      const [nickname, setNickname] = useState(s.qqNickname || '');
      // 两层 UI：layer='main' 主UI（登录/搜索/推荐/分类）；layer='playlist' 播放列表UI（当前队列或某歌单）。
      const [layer, setLayer] = useState('main');
      const [activePl, setActivePl] = useState(null); // { id?, name, creator?, songs, source }
      const [plLoading, setPlLoading] = useState(false); // 播放列表歌曲加载中
      const [browseTab, setBrowseTab] = useState('mine'); // mine | recommend | category | tops | new | search
      // 搜索（统一：歌曲 + 歌单）。
      const [q, setQ] = useState('');
      const [searched, setSearched] = useState(false);
      const [searching, setSearching] = useState(false);
      const [results, setResults] = useState([]);
      const [plResults, setPlResults] = useState([]);
      const [qError, setQError] = useState('');
      const [resultTab, setResultTab] = useState('songs'); // 搜索结果内：songs | playlists
      // 搜索分页：page 从 1 起、每页 20。「是否还有下一页」由最近一页是否返回满页判断，
      // 不依赖 QQ 接口必返的 totalnum（歌单搜索的 totalnum 可能缺失/不可靠）。
      const QQLIST_PAGE = 20;
      const [searchPage, setSearchPage] = useState(1);
      const [searchLastLen, setSearchLastLen] = useState(0);
      const [searchingMore, setSearchingMore] = useState(false);
      const [plSearchPage, setPlSearchPage] = useState(1);
      const [plSearchLastLen, setPlSearchLastLen] = useState(0);
      const [plSearchingMore, setPlSearchingMore] = useState(false);
      // 搜索历史（localStorage 持久化，最近在前）。
      const [hist, setHist] = useState([]);
      const [histOpen, setHistOpen] = useState(false);
      const histRef = useRef(null);
      // 浏览。
      const [minePlays, setMinePlays] = useState([]);
      const [mineLoaded, setMineLoaded] = useState(false);
      const [recommended, setRecommended] = useState([]);
      const [categories, setCategories] = useState([]);
      const [catPlays, setCatPlays] = useState([]);
      const [curCategory, setCurCategory] = useState(null);
      const [browseErr, setBrowseErr] = useState('');
      const [browseLoading, setBrowseLoading] = useState(false);
      // 「加入歌单」弹窗：{ song, x, y }（锚点=「＋」按钮的视口坐标），点击弹出我的歌单列表。
      const [qqJoin, setQqJoin] = useState(null);
      const [qqJoinMsg, setQqJoinMsg] = useState('');
      const qqJoinRef = useRef(null);
      // 点击弹窗外关闭「加入歌单」弹窗。
      useEffect(() => {
        if (qqJoin === null) return;
        const onDown = (e) => { if (qqJoinRef.current !== null && !qqJoinRef.current.contains(e.target)) setQqJoin(null); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [qqJoin]);
      // QQ 播放列表层：进入或切换播放曲目时，把正在播放的那一行滚动到可见位置。
      useEffect(() => {
        const list = qqPlRef.current;
        if (list === null) return;
        const active = list.querySelector('.dsh-music-track-row.active');
        if (active !== null && typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ block: 'nearest' });
        }
      }, [layer, s.currentId, activePl]);
      // 推荐歌单加载更多：热门推荐 12 条后用「全部分类」分页续载。
      const [recPage, setRecPage] = useState(1);
      const [recLoadingMore, setRecLoadingMore] = useState(false);
      const [recHasMore, setRecHasMore] = useState(true);
      // 分类歌单加载更多：每页 20 条，可翻页续载。
      const [catPage, setCatPage] = useState(1);
      const [catLoadingMore, setCatLoadingMore] = useState(false);
      const [catHasMore, setCatHasMore] = useState(true);
      // 分类 chips 折叠/展开：默认折叠只显示少量，展开显示全部。
      const [catExpanded, setCatExpanded] = useState(false);
      // 排行榜 + 新歌（发现页签）。
      const [topGroups, setTopGroups] = useState([]);
      const [topLoaded, setTopLoaded] = useState(false);
      const [topDetail, setTopDetail] = useState(null); // { id, name, songs }
      const [topLoading, setTopLoading] = useState(false);
      // 榜单详情分页：已加载歌曲总数 / 是否还有下一页 / 加载更多进行中。
      const [topTotal, setTopTotal] = useState(0);
      const [topHasMore, setTopHasMore] = useState(false);
      const [topLoadingMore, setTopLoadingMore] = useState(false);
      const [newSongs, setNewSongs] = useState([]);
      const [newLoaded, setNewLoaded] = useState(false);
      // 登录。
      const [loginMode, setLoginMode] = useState(null);
      const [qrImage, setQrImage] = useState('');
      const [loginStatus, setLoginStatus] = useState('');
      const [loginBusy, setLoginBusy] = useState(false);
      const [playingId, setPlayingId] = useState('');
      const pollRef = useRef(null);
      const qrKeyRef = useRef('');
      const loginModeRef = useRef(null);
      // QQ 播放列表层（layer='playlist'）的滚动容器（.dsh-music-qq-body）引用，
      // 用于进入/切歌时把正在播放的曲目滚动到可见位置。
      const qqPlRef = useRef(null);

      const json = (url) => jsonGet(url).catch(() => ({ ok: false, error: '网络错误' }));
      // 搜索历史（localStorage 持久化，最近在前，最多 10 条）。
      const HIST_KEY = 'dsh-music-qq-history';
      const loadHist = () => { try { const a = JSON.parse(localStorage.getItem(HIST_KEY)); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : []; } catch { return []; } };
      const saveHist = (kw) => {
        kw = (kw || '').trim();
        if (!kw) return;
        const next = [kw, ...loadHist().filter((x) => x !== kw)].slice(0, 10);
        try { localStorage.setItem(HIST_KEY, JSON.stringify(next)); } catch {}
        setHist(next);
      };
      const clearHist = () => { try { localStorage.removeItem(HIST_KEY); } catch {} setHist([]); };
      const clearPoll = () => { if (pollRef.current !== null) { try { clearInterval(pollRef.current); } catch {} try { clearTimeout(pollRef.current); } catch {} pollRef.current = null; } };
      // 记住当前操作所在层（主UI / 播放列表UI），下次弹窗恢复。
      const UI_KEY = 'dsh-music-qq-ui';
      const saveUi = (layer2, plId, plName) => { try { localStorage.setItem(UI_KEY, JSON.stringify({ layer: layer2, plId: plId || '', plName: plName || '' })); } catch {} };
      const loadUi = () => { try { return JSON.parse(localStorage.getItem(UI_KEY)); } catch { return null } };
      const restoreUi = (ui) => {
        if (!ui || ui.layer !== 'playlist') return;
        setLayer('playlist');
        if (ui.plId) {
          json('/dsh-music/qq/playlist/' + encodeURIComponent(ui.plId)).then((d) => { if (d && d.ok) setActivePl({ ...d.playlist, source: ui.plName || '歌单' }); });
        } else {
          setActivePl({ name: s.qqSource || '在线播放列表', songs: s.qqQueue || [], source: s.qqSource || '在线' });
        }
      };
      // ① 挂载时只做本地初始化：读搜索历史（localStorage）+ 查登录态（status 由
      // host 读本地 cookie 文件，不发任何外部网络请求）。外部数据（分类/推荐/我的
      // 歌单）一律延后到登录后（见下方 [loggedIn] effect），未登录零外部请求——
      // 本插件 QQ 在线功能以「登录」为门槛。
      useEffect(() => {
        setHist(loadHist());
        jsonGet('/dsh-music/qq/status').then((d) => { if (d) { setLoggedIn(!!d.loggedIn); setUin(d.uin || ''); setNickname(d.nickname || ''); } }).catch(() => {});
        // 点击搜索框外时关闭历史下拉。
        const onDocClick = (e) => { if (histRef.current !== null && !histRef.current.contains(e.target)) setHistOpen(false); };
        document.addEventListener('mousedown', onDocClick);
        return () => { clearPoll(); document.removeEventListener('mousedown', onDocClick); };
      }, []);
      // ② 登录态变化时才加载在线数据：未登录（loggedIn=false）一个外部请求都不发；
      // 登录成功（setLoggedIn(true)）或已登录刷新页面（status 返回 true）时自动加载
      // 分类 / 我的歌单 / 推荐，并恢复上次所在层。登出后不再加载。
      useEffect(() => {
        if (!loggedIn) return;
        json('/dsh-music/qq/playlist-categories').then((d) => { if (d && d.ok) setCategories(d.categories || []); });
        // 默认落在「我的歌单」tab：登录态下加载我的歌单；未登录时主 UI 不显示。
        loadMine();
        loadRecommended();
        // 仅本次会话首次登录时恢复上次所在层；之后切 tab 重挂不再拉回旧层。
        if (!qqUiRestored) { qqUiRestored = true; restoreUi(loadUi()); }
      }, [loggedIn]);
      // ③ 收藏/取消收藏「我喜欢」后刷新「我的歌单」，让「我喜欢」歌单数目随之更新。
      useEffect(() => {
        if (s.qqFavRev > 0 && loggedIn) loadMine();
      }, [s.qqFavRev]);

      async function loadRecommended() {
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/qq/playlists');
        if (d && d.ok) setRecommended(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setBrowseLoading(false);
      }
      // 加载更多推荐歌单：热门推荐固定 12 条，续载「全部分类」的分页歌单并去重。
      async function loadMoreRecommended() {
        if (recLoadingMore || !recHasMore) return;
        setRecLoadingMore(true); setBrowseErr('');
        const nextPage = recPage + 1;
        const d = await json('/dsh-music/qq/playlists?category=10000000&page=' + nextPage);
        if (d && d.ok && Array.isArray(d.playlists)) {
          const existing = new Set(recommended.map((p) => String(p.id)));
          const fresh = d.playlists.filter((p) => !existing.has(String(p.id)));
          setRecommended((prev) => [...prev, ...fresh]);
          setRecPage(nextPage);
          if (fresh.length === 0 || d.playlists.length < 20) setRecHasMore(false);
        } else {
          setBrowseErr((d && d.error) || '加载更多失败');
          setRecHasMore(false);
        }
        setRecLoadingMore(false);
      }
      async function loadMine() {
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/qq/my-playlists');
        if (d && d.ok) setMinePlays(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setMineLoaded(true);
        setBrowseLoading(false);
      }
      // 删除自建歌单（DelPlaylist / PlaylistBaseWrite）。二次确认后调 Host，成功后本地移除。
      async function deleteMinePlaylist(pl) {
        const dirId = Number(pl && (pl.dirId || pl.tid || pl.id)) || 0;
        if (!dirId) { setBrowseErr('缺少歌单 dirId，无法删除'); return; }
        openConfirm('删除歌单', '确定删除 QQ 歌单「' + (pl.name || '') + '」？删除后不可恢复。', async () => {
          setBrowseLoading(true); setBrowseErr('');
          try {
            const d = await jsonPost('/dsh-music/qq/playlist-delete', { dirId });
            if (!d || !d.ok) throw new Error((d && d.error) || '删除歌单失败');
            setMinePlays((prev) => prev.filter((p) => String(p.id) !== String(pl.id)));
          } catch (err) {
            setBrowseErr(String((err && err.message) || err));
          }
          setBrowseLoading(false);
        }, '删除', true);
      }
      async function loadCategory(cat) {
        setCurCategory(cat); setCatPlays([]); setBrowseLoading(true); setBrowseErr('');
        setCatPage(1); setCatHasMore(true);
        const d = await json('/dsh-music/qq/playlists?category=' + encodeURIComponent(cat.id) + '&page=1');
        if (d && d.ok) setCatPlays(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setBrowseLoading(false);
      }
      // 分类歌单加载更多：同分类翻页续载并去重。
      async function loadMoreCategory() {
        if (!curCategory || catLoadingMore || !catHasMore) return;
        setCatLoadingMore(true); setBrowseErr('');
        const nextPage = catPage + 1;
        const d = await json('/dsh-music/qq/playlists?category=' + encodeURIComponent(curCategory.id) + '&page=' + nextPage);
        if (d && d.ok && Array.isArray(d.playlists)) {
          const existing = new Set(catPlays.map((p) => String(p.id)));
          const fresh = d.playlists.filter((p) => !existing.has(String(p.id)));
          setCatPlays((prev) => [...prev, ...fresh]);
          setCatPage(nextPage);
          if (fresh.length === 0 || d.playlists.length < 20) setCatHasMore(false);
        } else {
          setBrowseErr((d && d.error) || '加载更多失败');
          setCatHasMore(false);
        }
        setCatLoadingMore(false);
      }
      async function loadTopLists() {
        if (topLoaded) return;
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/qq/top-lists');
        if (d && d.ok) setTopGroups(d.groups || []); else setBrowseErr((d && d.error) || '加载排行榜失败');
        setTopLoaded(true);
        setBrowseLoading(false);
      }
      const TOP_PAGE = 30;
      async function loadTopSongs(top) {
        setTopDetail(null); setTopLoading(true); setBrowseErr('');
        setTopTotal(0); setTopHasMore(false);
        const d = await json('/dsh-music/qq/top-songs?topId=' + encodeURIComponent(top.id) + '&offset=0&num=' + TOP_PAGE);
        if (d && d.ok) {
          const t = d.toplist || {};
          setTopDetail({ ...t, id: top.id, name: t.name || top.name, cover: t.cover || top.cover || '' });
          setTopTotal(Number(t.total) || (t.songs || []).length);
          setTopHasMore(!!t.hasMore);
        } else setBrowseErr((d && d.error) || '加载榜单失败');
        setTopLoading(false);
      }
      // 榜单「加载更多」：从当前已加载数量继续取下一页并追加，更新 total/hasMore。
      async function loadMoreTopSongs() {
        if (topLoadingMore || !topDetail) return;
        setTopLoadingMore(true); setBrowseErr('');
        const offset = (topDetail.songs || []).length;
        const d = await json('/dsh-music/qq/top-songs?topId=' + encodeURIComponent(topDetail.id || topDetail.topId) + '&offset=' + offset + '&num=' + TOP_PAGE);
        if (d && d.ok) {
          const t = d.toplist || {};
          setTopDetail((cur) => (cur ? { ...cur, songs: [...(cur.songs || []), ...((t.songs || []))] } : cur));
          setTopTotal(Number(t.total) || offset + (t.songs || []).length);
          setTopHasMore(!!t.hasMore);
        } else setBrowseErr((d && d.error) || '加载更多失败');
        setTopLoadingMore(false);
      }
      async function loadNewSongs() {
        if (newLoaded) return;
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/qq/new-songs?type=5');
        if (d && d.ok) setNewSongs((d.result && d.result.songs) || []); else setBrowseErr((d && d.error) || '加载新歌失败');
        setNewLoaded(true);
        setBrowseLoading(false);
      }
      function backToTops() { setTopDetail(null); setTopTotal(0); setTopHasMore(false); }
      async function openPlaylist(pl, mine) {
        setActivePl(null); setLayer('playlist'); setPlLoading(true); saveUi('playlist', pl.id, pl.name);
        // _dirId：从歌单移除歌曲需要 QQ 歌单的目录 id（「我的歌单」卡片带 dirId）；
        // mine 标记这是「我自己的歌单」（含「我喜欢」），详情里才允许用「−」从该歌单移除。
        const _dirId = Number((pl && (pl.dirId || pl.tid || pl.id))) || 0;
        const d = await json('/dsh-music/qq/playlist/' + encodeURIComponent(pl.id));
        if (d && d.ok) setActivePl({ ...d.playlist, source: pl.name || '歌单', mine: !!mine, _dirId });
        else setBrowseErr((d && d.error) || '加载失败');
        setPlLoading(false);
      }
      function openQueue() {
        setActivePl({ name: s.qqSource || '在线播放列表', songs: s.qqQueue || [], source: s.qqSource || '播放中' });
        setLayer('playlist'); saveUi('playlist', '', '');
      }
      function backToMain() { setLayer('main'); setActivePl(null); saveUi('main', '', ''); }
      async function doSearch(kwOverride) {
        const kw = (kwOverride !== undefined ? String(kwOverride) : q).trim();
        if (kw === '') { setSearched(false); setQError(''); return; }
        setHistOpen(false);
        saveHist(kw);
        setSearching(true); setQError(''); setResults([]); setPlResults([]); setSearched(true); setCurCategory(null);
        setSearchPage(1); setSearchLastLen(0); setPlSearchPage(1); setPlSearchLastLen(0);
        const [songs, pls] = await Promise.all([
          json('/dsh-music/qq/search?w=' + encodeURIComponent(kw) + '&page=1'),
          json('/dsh-music/qq/playlist-search?w=' + encodeURIComponent(kw) + '&page=1'),
        ]);
        if (songs && songs.ok) { setResults(songs.results || []); setSearchLastLen((songs.results || []).length); setSearchPage(songs.page || 1); }
        else setQError((songs && songs.error) || '歌曲搜索失败');
        if (pls && pls.ok) { setPlResults(pls.playlists || []); setPlSearchLastLen((pls.playlists || []).length); setPlSearchPage(pls.page || 1); }
        // 默认打开「有结果」的那个 tab（歌曲优先）。
        const sLen = (songs && songs.ok && (songs.results || []).length) || 0;
        const pLen = (pls && pls.ok && (pls.playlists || []).length) || 0;
        if (sLen > 0) setResultTab('songs');
        else if (pLen > 0) setResultTab('playlists');
        setSearching(false);
      }
      // 搜索结果「加载更多」：追加下一页（共用当前关键词 q）。
      async function loadMoreSongs() {
        const kw = q.trim();
        if (kw === '' || searchingMore) return;
        const next = searchPage + 1;
        setSearchingMore(true);
        try {
          const d = await json('/dsh-music/qq/search?w=' + encodeURIComponent(kw) + '&page=' + next);
          if (d && d.ok) {
            setResults((cur) => cur.concat(d.results || []));
            setSearchLastLen((d.results || []).length);
            setSearchPage(d.page || next);
          }
        } catch {}
        setSearchingMore(false);
      }
      async function loadMorePls() {
        const kw = q.trim();
        if (kw === '' || plSearchingMore) return;
        const next = plSearchPage + 1;
        setPlSearchingMore(true);
        try {
          const d = await json('/dsh-music/qq/playlist-search?w=' + encodeURIComponent(kw) + '&page=' + next);
          if (d && d.ok) {
            setPlResults((cur) => cur.concat(d.playlists || []));
            setPlSearchLastLen((d.playlists || []).length);
            setPlSearchPage(d.page || next);
          }
        } catch {}
        setPlSearchingMore(false);
      }
      function playSong(song, queue, sourceLabel) {
        // 未登录时点击 VIP 歌曲：不要启动注定失败的播放（否则播放条会误报
        // 「频谱不可用/音频加载失败」，重试也无济于事），改为提示并弹出登录。
        const isVip = song.payplay === 1 || (song.pay && song.pay.payplay === 1);
        if (isVip && !loggedIn) {
          setQError('VIP 歌曲需先登录才能播放，请扫码登录');
          startLogin('wx');
          return;
        }
        setPlayingId(String(song.songmid || song.id)); startQQPlayback(song, queue, sourceLabel);
      }

      // ---- 登录（扫码/轮询/退出）----
      async function startLogin(mode) {
        clearPoll();
        loginModeRef.current = mode; qrKeyRef.current = '';
        setLoginMode(mode); setLoginStatus('正在生成二维码…'); setLoginBusy(true); setQrImage('');
        try {
          const d = await jsonPost('/dsh-music/qq/login/start', { mode });
          if (!d || !d.ok) throw new Error((d && d.error) || '二维码创建失败');
          qrKeyRef.current = d.key || '';
          setQrImage(d.image || '');
          setLoginStatus(mode === 'qq' ? '请用 QQ App 扫码' : '请用微信 App 扫码');
          setLoginBusy(false);
          schedulePoll();
        } catch (e) { setLoginStatus(String((e && e.message) || e)); setLoginBusy(false); }
      }
      function schedulePoll() { if (loginModeRef.current === null || qrKeyRef.current === '') return; clearPoll(); pollRef.current = setTimeout(pollLogin, 1500); }
      async function pollLogin() {
        const key = qrKeyRef.current;
        if (!key) return;
        try {
          const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          const timer = ctrl ? setTimeout(() => ctrl.abort(), 30000) : null;
          let d;
          try {
            d = await fetch('/dsh-music/qq/login/check?key=' + encodeURIComponent(key), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then((r) => r.json());
          } finally { if (timer) clearTimeout(timer); }
          if (!d || !d.ok) { setLoginStatus((d && d.error) || '查询失败，正在重试…'); schedulePoll(); return; }
          if (d.status === 'success') { clearPoll(); setLoggedIn(true); setUin(d.uin || ''); setNickname(d.nickname || ''); setLayer('main'); setActivePl(null); saveUi('main', '', ''); setLoginStatus('登录成功'); setTimeout(closeLogin, 800); refreshQQFavIds(); }
          else if (d.status === 'scanned') { setLoginStatus('已扫码，请在手机上确认'); schedulePoll(); }
          else if (d.status === 'expired') { clearPoll(); setLoginStatus('二维码已过期，请重新扫码'); }
          else if (d.status === 'failed') { clearPoll(); setLoginStatus(d.message || '登录失败'); }
          else if (d.status === 'waiting') { setLoginStatus('等待扫码…'); schedulePoll(); }
          else { schedulePoll(); }
        } catch (e) { setLoginStatus('获取登录状态超时，正在自动重试…'); schedulePoll(); }
      }
      function closeLogin() { clearPoll(); loginModeRef.current = null; qrKeyRef.current = ''; setLoginMode(null); setLoginStatus(''); setQrImage(''); }
      async function logout() { try { await jsonPost('/dsh-music/qq/login/logout', {}); } catch {} setLoggedIn(false); setUin(''); setNickname(''); }

      // ---- 渲染辅助 ----
      const fmtCount = (n) => { const v = Number(n) || 0; if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'; if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万'; return String(v); };
      const songRow = (song, queue, sourceLabel, inMine) => {
        const id = String(song.songmid || song.id);
        const active = s.currentId === 'qq:' + id;
        const playing = active && s.playing;
        const vip = song.payplay === 1;
        const artists = (song.artists || []).join('/');
        return React.createElement('div', { key: id, className: 'dsh-music-track-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track' + (active ? ' active' : ''), title: song.title + ' - ' + artists,
            onClick: () => { if (active) togglePlay(); else playSong(song, queue, sourceLabel); },
          },
            React.createElement('span', { className: 'dsh-music-track-name qq' },
              React.createElement('span', { className: 'dsh-music-track-title' }, (playing ? '▶ ' : '') + song.title),
              vip ? React.createElement('span', { className: 'dsh-music-online-tag vip' }, 'VIP') : null),
            React.createElement('span', { className: 'dsh-music-online-tag' }, artists || 'QQ')),
          // 我的歌单详情：歌曲已在该歌单 → 显示「−」从该歌单移除；其它场景显示「＋」加入歌单。
          inMine
            ? React.createElement('button', {
              className: 'dsh-music-playlist-mini remove',
              title: '从「' + ((activePl && activePl.name) || '当前歌单') + '」移除',
              onClick: (e) => { e.stopPropagation(); removeFromActivePlaylist(song); },
            }, '−')
            : React.createElement('button', {
              className: 'dsh-music-playlist-mini add',
              title: '加入我的歌单',
              onClick: (e) => { e.stopPropagation(); openQqJoin(song, e); },
            }, '＋'));
      };
      // 从「我的歌单」当前歌单移除歌曲（DelSonglist）；「我喜欢」(dirId=201) 等同取消收藏。
      async function removeFromActivePlaylist(song) {
        const pl = activePl;
        if (!pl) return;
        const id = String(song.songmid || song.id);
        const dirId = Number(pl._dirId || pl.dirId || pl.id) || 0;
        try {
          const d = await jsonPost('/dsh-music/qq/playlist-remove', { song, dirId, tid: 0 });
          if (!d || !d.ok) throw new Error((d && d.error) || '从歌单移除失败');
          // 就地移除该行，并刷新「我的歌单」数目。
          setActivePl((cur) => (cur ? { ...cur, songs: (cur.songs || []).filter((t) => String(t.songmid || t.id) !== id) } : cur));
          loadMine();
          // 「我喜欢」：同步收藏集合并把当前播放的这首歌标记为未收藏。
          if (dirId === 201) {
            refreshQQFavIds();
            if (String(s.currentId) === 'qq:' + id) set({ qqFaved: false });
          }
        } catch (err) { setQError(String((err && err.message) || err)); }
      }
      // 「加入歌单」：打开弹窗（列出我的歌单），并把歌曲加入所选歌单 / 新建歌单。
      function openQqJoin(song, e) {
        const r = e.currentTarget.getBoundingClientRect();
        if (minePlays.length === 0 && !mineLoaded) loadMine();
        setQqJoinMsg('');
        setQqJoin({ song, x: r.right, y: r.top });
      }
      async function qqJoinAddTo(pl) {
        const song = qqJoin && qqJoin.song;
        if (!song) return;
        try {
          // dirId 用歌单的权威 dirId（dirid），tid 固定 0（「我喜欢」dirId=201,tid=0 的可用模式）。
          const d = await jsonPost('/dsh-music/qq/playlist-add', { song, dirId: (pl && (pl.dirId || pl.tid || pl.id)) || 0, tid: 0 });
          if (!d || !d.ok) throw new Error((d && d.error) || '加入歌单失败');
          // 本地乐观 +1，并异步刷新「我的歌单」，让数目与实际一致。
          if (pl) {
            const pid = String(pl.id);
            setMinePlays((cur) => cur.map((p) => (String(p.id) === pid ? { ...p, trackCount: (Number(p.trackCount) || 0) + 1 } : p)));
            loadMine();
          }
          setQqJoin(null);
        } catch (err) { setQqJoinMsg(String((err && err.message) || err)); }
      }
      async function qqJoinCreate() {
        const song = qqJoin && qqJoin.song;
        openPrompt('新建歌单名称', '', async (trimmed) => {
          if (!trimmed) return;
          try {
            const d = await jsonPost('/dsh-music/qq/playlist-create', { name: trimmed });
            if (!d || !d.ok || !d.playlist) throw new Error((d && d.error) || '创建歌单失败');
            const created = d.playlist;
            // AddPlaylist 返回的 id 即新歌单 dirid；AddSonglist 用该 dirid + tid=0 加歌。
            if (song) {
              const add = await jsonPost('/dsh-music/qq/playlist-add', { song, dirId: Number(created.id) || 0, tid: 0 });
              if (!add || !add.ok) throw new Error((add && add.error) || '加入新歌单失败');
            }
            loadMine();
            setQqJoin(null);
          } catch (err) { setQqJoinMsg(String((err && err.message) || err)); }
        });
      }
      const qqJoinMenu = qqJoin ? portalToBody((() => {
        const openUp = (qqJoin.y || 0) > ((window.innerHeight || 0) - 240);
        const style = {
          left: Math.max(8, (qqJoin.x || 0) - 150),
          top: openUp ? (qqJoin.y || 0) - 6 : (qqJoin.y || 0) + 8,
          transform: openUp ? 'translateY(-100%)' : 'none',
        };
        return React.createElement('div', { className: 'dsh-music-add-pop', ref: qqJoinRef, style },
          qqJoinMsg ? React.createElement('div', { className: 'dsh-music-hint', style: { padding: '2px 8px', color: 'var(--dsw-alias-state-error-primary, #e5534b)' } }, qqJoinMsg) : null,
          minePlays.length > 0 ? minePlays.map((p) => React.createElement('button', {
            key: p.id, className: 'dsh-music-add-pop-item',
            title: '加入「' + p.name + '」',
            onClick: () => qqJoinAddTo(p),
          }, p.name + (p.trackCount ? '（' + p.trackCount + '）' : ''))) : React.createElement('div', { className: 'dsh-music-hint', style: { padding: '2px 8px' } }, '暂无我的歌单，请先创建。'),
          React.createElement('button', { className: 'dsh-music-add-pop-item new', onClick: qqJoinCreate }, '＋ 新建歌单'),
        );
      })()) : null;
      const playRow = (pl, mine) => {
        // 注意：map((pl) => playRow(pl)) 会把数组下标作为第二个参数传入（Array#map 传
        // (element, index, array)）。这里必须用严格 true 判断「我的歌单」，否则推荐/分类/
        // 搜索等来源里除第一项外的卡片会把下标当真值，误显示删除按钮。
        const isMine = mine === true;
        const meta = (pl.trackCount > 0 ? pl.trackCount + ' 首' : '')
          + (pl.playCount ? ' · 播放 ' + fmtCount(pl.playCount) : '');
        const card = React.createElement('button', {
          key: pl.id, className: 'dsh-music-playlist-card', title: pl.name + ' - ' + (pl.creator || ''),
          onClick: () => openPlaylist(pl, isMine),
        },
          React.createElement('img', {
            className: 'dsh-music-playlist-cover',
            src: pl.cover || '', alt: '', loading: 'lazy',
            onError: (e) => { e.currentTarget.style.display = 'none'; },
          }),
          React.createElement('span', { className: 'dsh-music-playlist-info' },
            React.createElement('span', { className: 'dsh-music-playlist-name' }, pl.name),
            React.createElement('span', { className: 'dsh-music-playlist-meta' },
              (pl.creator ? pl.creator + ' · ' : '') + meta)));
        // 「我的歌单」卡片：右上角提供删除按钮（仅本人创建的歌单，「我喜欢」dirId=201 除外）。
        if (!isMine) return card;
        const dirId = Number(pl && (pl.dirId || pl.tid || pl.id)) || 0;
        const deletable = dirId !== 0 && dirId !== 201;
        return React.createElement('div', { key: pl.id, className: 'dsh-music-qq-mine-card' },
          card,
          deletable ? React.createElement('button', {
            className: 'dsh-music-qq-mine-del', title: '删除歌单「' + pl.name + '」',
            onClick: (e) => { e.stopPropagation(); deleteMinePlaylist(pl); },
          }, '✕') : null);
      };
      const catTab = (cat) => React.createElement('button', {
        key: cat.id, className: 'dsh-music-qq-cat' + (curCategory && curCategory.id === cat.id ? ' active' : ''),
        onClick: () => loadCategory(cat),
      }, cat.name);
      const browseTabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-qq-viewtab' + (browseTab === key ? ' active' : ''),
        onClick: () => {
          setBrowseTab(key);
          if (key === 'recommend' && recommended.length === 0) loadRecommended();
          else if (key === 'mine' && minePlays.length === 0) loadMine();
          else if (key === 'tops' && !topLoaded) loadTopLists();
          else if (key === 'new' && !newLoaded) loadNewSongs();
        },
      }, label);
      // 搜索结果内的「歌曲 / 相关歌单」切换 tab。
      const resultTabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-qq-viewtab' + (resultTab === key ? ' active' : ''),
        onClick: () => setResultTab(key),
      }, label);

      // 搜索框（放在「搜索」子tab内容里）。点击聚焦显示历史下拉，可直接输入或选历史。
      const searchBox = React.createElement('div', { className: 'dsh-music-qq-search', ref: histRef },
        React.createElement('input', {
          className: 'dsh-music-qq-input', type: 'text', placeholder: '搜索 QQ 音乐（歌曲 / 歌单）',
          value: q,
          onChange: (e) => { setQ(e.target.value); if (e.target.value === '') setSearched(false); },
          onKeyDown: (e) => { if (e.key === 'Enter') doSearch(); },
          onFocus: () => { if (hist.length > 0) setHistOpen(true); },
        }),
        React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => doSearch() }, searching ? '搜索中…' : '搜索'),
        histOpen && hist.length > 0
          ? React.createElement('div', { className: 'dsh-music-qq-hist' },
            React.createElement('div', { className: 'dsh-music-qq-hist-head' },
              React.createElement('span', { className: 'dsh-music-hint' }, '搜索历史'),
              React.createElement('button', { className: 'dsh-music-qq-hist-clear', title: '清空历史', onClick: clearHist }, '清空')),
            hist.map((kw, idx) => React.createElement('button', {
              key: idx, className: 'dsh-music-qq-hist-item',
              onClick: () => { setQ(kw); doSearch(kw); },
            }, kw)))
          : null);

      // 扫码框以面板中心为基准居中（面板可拖拽），贴边时 clamp 不被裁掉。
      const qqLoginStyle = panelCenterStyle(panelRef, loginMode !== null, 170, 460);
      const loginModal = loginMode !== null ? portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker qq-login', style: qqLoginStyle },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, 'QQ 音乐登录'),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: closeLogin }, '✕')),
          React.createElement('div', { className: 'dsh-music-qq-login-body' },
            loginBusy && qrImage === '' ? React.createElement('div', { className: 'dsh-music-loading' }, '生成二维码…')
              : qrImage ? React.createElement('img', { className: 'dsh-music-qq-qr', src: qrImage, alt: '二维码' }) : null,
            React.createElement('div', { className: 'dsh-music-qq-login-status' }, loginStatus || ''),
            loginStatus !== '登录成功' ? React.createElement('div', { className: 'dsh-music-qq-login-actions' },
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => startLogin(loginMode) }, '刷新二维码'),
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: closeLogin }, '取消')) : null,
            React.createElement('p', { className: 'dsh-music-hint' }, '用官方 App 扫码并确认。扫码登录走第三方接口，存在账号风控/合规风险，仅供个人试听。'),
          )))) : null;

      // ---- 未登录：只显示居中两个登录按钮（QQ 登录 / 微信登录，分两行）+ 风险提示 ----
      if (!loggedIn) {
        return React.createElement('div', { className: 'dsh-music-qq dsh-music-qq-login' },
          React.createElement('div', { className: 'dsh-music-qq-login-center' },
            React.createElement('button', { className: 'dsh-music-qq-login-btn', onClick: () => startLogin('qq') }, 'QQ 登录'),
            React.createElement('button', { className: 'dsh-music-qq-login-btn', onClick: () => startLogin('wx') }, '微信登录'),
            React.createElement('div', { className: 'dsh-music-qq-login-warn' },
              React.createElement('div', { className: 'dsh-music-qq-login-warn-title' }, '使用声明（重要）'),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-p' },
                '在线 QQ 音乐功能通过非官方接口访问 QQ 音乐资源，所播放/收藏的内容版权归版权方及 QQ 音乐平台所有。本功能仅供个人学习、技术研究、日常试听使用，严禁用于任何商业用途、公开传播、二次分发或盈利行为。使用本功能即表示您已知悉并同意：'),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '1'),
                React.createElement('span', null, '您应对自己的使用行为及其后果负责。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '2'),
                React.createElement('span', null, '因使用非官方接口登录/播放导致的账号风控、封禁、限流，以及可能引发的法律、版权纠纷，均由使用者自行承担。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '3'),
                React.createElement('span', null, '本项目作者不承担任何因此产生的直接或间接责任。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-p' },
                '如您不同意以上条款，请勿使用本功能。'))),
          loginModal,
          qqJoinMenu);
      }

      // ---- 播放列表UI（第 2 层）：返回 + 可滚动歌曲列表 ----
      if (layer === 'playlist') {
        const pl = activePl || { name: '在线播放列表', songs: [], source: '在线' };
        return React.createElement('div', { className: 'dsh-music-qq' },
          React.createElement('div', { className: 'dsh-music-qq-head' },
            React.createElement('div', { className: 'dsh-music-qq-detail-head' },
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: backToMain }, '← 返回'),
              React.createElement('span', { className: 'dsh-music-settings-cur', title: pl.name }, pl.source === '歌单' ? '▸ 歌单：' + pl.name : pl.name),
              React.createElement('span', { className: 'dsh-music-hint' }, (pl.creator ? (pl.creator + ' · ') : '') + ((pl.songs || []).length + ' 首'))),
            pl.description ? React.createElement('p', { className: 'dsh-music-hint' }, pl.description) : null),
          React.createElement('div', { className: 'dsh-music-qq-body', ref: qqPlRef },
            plLoading
              ? React.createElement('div', { className: 'dsh-music-hint' }, '加载中…')
              : (pl.songs && pl.songs.length
                ? React.createElement('div', null, pl.songs.map((song) => songRow(song, pl.songs, pl.name, pl.mine)))
                : React.createElement('div', { className: 'dsh-music-hint' }, '暂无歌曲。'))),
          loginModal,
          qqJoinMenu);
      }

      // ---- 主UI（第 1 层）：顶部工具栏 + 4 个子tab，只滚动子tab内容区 ----
      let body;
      if (browseTab === 'search') {
        const hasSongs = results.length > 0;
        const hasPls = plResults.length > 0;
        let resultContent = null;
        // 搜索分页「加载更多」按钮：最近一页返回满页（==20）就认为还有下一页。
        const songMoreBtn = (searchLastLen >= QQLIST_PAGE)
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreSongs },
              searchingMore ? '加载中…' : '加载更多'))
          : null;
        const plMoreBtn = (plSearchLastLen >= QQLIST_PAGE)
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMorePls },
              plSearchingMore ? '加载中…' : '加载更多'))
          : null;
        if (searching) {
          resultContent = React.createElement('div', { className: 'dsh-music-hint' }, '搜索中…');
        } else if (qError || !(hasSongs || hasPls)) {
          resultContent = React.createElement('div', { className: 'dsh-music-error' }, qError || '未找到相关结果。');
        } else if (hasSongs && hasPls) {
          // 歌曲 + 歌单都有结果 → 用 tab 切换显示。
          resultContent = React.createElement('div', null,
            React.createElement('div', { className: 'dsh-music-qq-viewtabs' },
              resultTabBtn('songs', '歌曲'),
              resultTabBtn('playlists', '相关歌单')),
            resultTab === 'playlists'
              ? React.createElement('div', null, plResults.map((p) => playRow(p)), plMoreBtn)
              : React.createElement('div', null, results.map((song) => songRow(song, results, '搜索结果')), songMoreBtn));
        } else if (hasSongs) {
          resultContent = React.createElement('div', null, results.map((song) => songRow(song, results, '搜索结果')), songMoreBtn);
        } else {
          resultContent = React.createElement('div', null, plResults.map((p) => playRow(p)), plMoreBtn);
        }
        body = React.createElement('div', null, searchBox,
          searched ? React.createElement('div', null, resultContent) : null);
      } else {
        let content;
        if (browseTab === 'mine') {
          const listEl = !mineLoaded
            ? React.createElement('div', { className: 'dsh-music-hint' }, '加载我的歌单…')
            : (minePlays.length > 0
              ? minePlays.map((p) => playRow(p, true))
              : React.createElement('div', { className: 'dsh-music-hint' }, '暂无歌单。可到 QQ 音乐 App 创建或收藏歌单后再来查看。'));
          content = React.createElement('div', null, listEl);
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else if (browseTab === 'category') {
          const catMoreBtn = curCategory && catPlays.length > 0 && catHasMore
            ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
              React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreCategory },
                catLoadingMore ? '加载中…' : '加载更多'))
            : null;
          const CAT_COLLAPSED_COUNT = 8;
          const shownCats = catExpanded ? categories : categories.slice(0, CAT_COLLAPSED_COUNT);
          const catToggle = categories.length > CAT_COLLAPSED_COUNT
            ? React.createElement('button', { className: 'dsh-music-qq-cat-toggle', onClick: () => setCatExpanded((v) => !v) },
              catExpanded ? '收起' : '展开全部分类（' + categories.length + '）')
            : null;
          content = React.createElement('div', null,
            React.createElement('div', { className: 'dsh-music-qq-cats' }, shownCats.length ? shownCats.map(catTab) : React.createElement('span', { className: 'dsh-music-hint' }, '加载分类中…')),
            catToggle,
            curCategory ? React.createElement('div', null,
              (catPlays.length ? catPlays.map((p) => playRow(p)) : React.createElement('div', { className: 'dsh-music-hint' }, '该分类暂无歌单。')),
              catMoreBtn) : null);
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else if (browseTab === 'tops') {
          let content;
          if (topDetail) {
            // 榜单详情：返回 + 歌曲列表（支持「加载更多」分页续载）。
            const rows = topDetail.songs && topDetail.songs.length
              ? topDetail.songs.map((song) => songRow(song, topDetail.songs, topDetail.name))
              : React.createElement('div', { className: 'dsh-music-hint' }, '该榜单暂无歌曲。');
            const moreBtn = topHasMore
              ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
                React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreTopSongs },
                  topLoadingMore ? '加载中…' : '加载更多'))
              : null;
            content = React.createElement('div', null,
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: backToTops }, '← 返回'),
              React.createElement('div', { className: 'dsh-music-qq-topdetail-head' },
                topDetail.cover ? React.createElement('img', {
                  className: 'dsh-music-playlist-cover', src: topDetail.cover, alt: '', loading: 'lazy',
                  onError: (e) => { e.currentTarget.style.display = 'none'; },
                }) : null,
                React.createElement('div', null,
                  React.createElement('div', { className: 'dsh-music-playlist-name' }, topDetail.name),
                  React.createElement('div', { className: 'dsh-music-hint' },
                    (topDetail.updateTime ? '更新于 ' + topDetail.updateTime + ' · ' : '')
                    + (topTotal ? (topDetail.songs || []).length + ' / ' + topTotal + ' 首' : '')))),
              rows,
              moreBtn);
          } else {
            const topCards = (tl) => tl.map((t) => {
              const meta = t.listenNum ? ((t.listenNum / 1e4).toFixed(0) + '万收听') : (t.totalNum ? t.totalNum + ' 首' : '');
              return React.createElement('button', {
                key: t.id, className: 'dsh-music-playlist-card',
                onClick: () => loadTopSongs(t),
                title: t.intro || '',
              },
                React.createElement('img', {
                  className: 'dsh-music-playlist-cover',
                  src: t.cover || '', alt: '', loading: 'lazy',
                  onError: (e) => { e.currentTarget.style.display = 'none'; },
                }),
                React.createElement('span', { className: 'dsh-music-playlist-info' },
                  React.createElement('span', { className: 'dsh-music-playlist-name' }, t.name),
                  React.createElement('span', { className: 'dsh-music-playlist-meta' }, meta)));
            });
            const rows = topGroups.map((g) =>
              React.createElement('div', { key: g.id || g.name, className: 'dsh-music-qq-topgroup' },
                React.createElement('div', { className: 'dsh-music-hint' }, g.name),
                React.createElement('div', null, topCards(g.toplists))));
            content = React.createElement('div', null,
              topGroups.length ? rows : React.createElement('div', { className: 'dsh-music-hint' }, '加载排行榜…'),
              topLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载榜单中…') : null);
          }
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else if (browseTab === 'new') {
          const rows = newSongs.length
            ? newSongs.map((song) => songRow(song, newSongs, '新歌速递'))
            : React.createElement('div', { className: 'dsh-music-hint' }, '加载新歌速递…');
          body = React.createElement('div', null, rows,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else {
          const recCards = recommended.length > 0 ? recommended.map((p) => playRow(p)) : React.createElement('div', { className: 'dsh-music-hint' }, '加载推荐歌单…');
          const moreBtn = recommended.length > 0 && recHasMore
            ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
              React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreRecommended },
                recLoadingMore ? '加载中…' : '加载更多'))
            : null;
          content = React.createElement('div', null, recCards, moreBtn);
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        }
      }

      const head = React.createElement('div', { className: 'dsh-music-qq-head' },
        React.createElement('div', { className: 'dsh-music-qq-toolbar' },
          React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: openQueue }, '播放列表'),
          React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: logout }, '退出登录')),
        React.createElement('div', { className: 'dsh-music-qq-viewtabs' },
          browseTabBtn('mine', '我的歌单'),
          browseTabBtn('recommend', '推荐歌单'),
          browseTabBtn('category', '分类歌单'),
          browseTabBtn('tops', '排行榜'),
          browseTabBtn('new', '新歌'),
          browseTabBtn('search', '搜索')));

      return React.createElement('div', { className: 'dsh-music-qq' },
        head,
        React.createElement('div', { className: 'dsh-music-qq-body' }, body),
        loginModal,
        qqJoinMenu,
      );
    }

    function PlayerPanel() {
      const s = useStore();
      const isBook = s.currentId !== null && String(s.currentId).startsWith('book:');
      const listRef = useRef(null);
      const panelRef = useRef(null);
      // Draggable panel position + size ({x, y, w, h} left/top/width/height once
      // dragged or resized; null = CSS default: centered, 380px, auto height).
      const [pos, setPos] = useState(loadPanelPos);
      const dragRef = useRef(null);   // head-drag state
      const resizeRef = useRef(null); // corner-resize state
      // 曲库每行「＋」打开的「加入歌单」菜单：{track, x, y}（锚点=按钮右上角视口坐标）。
      const [addMenu, setAddMenu] = useState(null);
      const openAddMenu = (track, e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAddMenu({ track, x: r.right, y: r.top });
      };

      // Once the panel is dragged/resized we switch from CSS centering
      // (left:50%; top:50%; translate(-50%,-50%)) to explicit left/top/width/height.
      // Locking height, clearing max-height and nulling the CSS translate matters:
      // with only top+left and the CSS max-height:72vh still applying, a fixed
      // element whose CSS also sets the translate would collapse/clamp and shift
      // by half its own size while dragging.
      // 面板常驻不卸载：关闭时仅用 display:none 隐藏（子树、QQ 面板状态全保留），
      // 重新打开时按播放类别重设 tab（见 togglePanel）并恢复显示。因此组件不会
      // 在关闭时 unmount，切 tab / 关面板重开都不会丢内部 useState 状态。
      const rootStyle = { ...(pos === null ? null : { left: pos.x, top: pos.y, width: pos.w, height: pos.h, maxHeight: 'none', transform: 'none' }), display: s.panelOpen ? '' : 'none' };

      const onHeadDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        // don't start a drag from the close button
        if (e.target.closest && e.target.closest('.dsh-music-icon-btn')) return;
        const el = panelRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const w = pos !== null ? pos.w : PANEL_W;
        const h = pos !== null ? pos.h : rect.height;
        const next = { x: pos !== null ? pos.x : rect.left, y: pos !== null ? pos.y : rect.top, w, h };
        dragRef.current = {
          startX: e.clientX, startY: e.clientY,
          originX: next.x, originY: next.y, w, h,
        };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
        if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
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
        const next = { x, y, w: d.w, h: d.h };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
      };
      const onHeadUp = (e) => {
        dragRef.current = null;
        if (typeof e.currentTarget.releasePointerCapture === 'function'
          && typeof e.currentTarget.hasPointerCapture === 'function'
          && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };

      // Corner drag-to-resize: grow/shrink width & height from the bottom-right
      // handle, clamped to [min, max] and kept inside the viewport. The panel's
      // top-left (x/y) is untouched by a resize.
      const onResizeDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const el = panelRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const cur = {
          x: pos !== null ? pos.x : rect.left,
          y: pos !== null ? pos.y : rect.top,
          w: pos !== null ? pos.w : PANEL_W,
          h: pos !== null ? pos.h : rect.height,
        };
        resizeRef.current = { startX: e.clientX, startY: e.clientY, originW: cur.w, originH: cur.h };
        setPos(cur);
        savePref(PREF_PANEL_POS, JSON.stringify(cur));
        if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onResizeMove = (e) => {
        const d = resizeRef.current;
        if (d === null) return;
        const el = panelRef.current;
        const x = pos !== null ? pos.x : (el !== null ? el.getBoundingClientRect().left : 0);
        const y = pos !== null ? pos.y : (el !== null ? el.getBoundingClientRect().top : 0);
        const vw = window.innerWidth, vh = window.innerHeight;
        const maxW = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, vw - x));
        const maxH = Math.min(Math.floor(vh * PANEL_MAX_H_VH), Math.max(PANEL_MIN_H, vh - y));
        const w = Math.max(PANEL_MIN_W, Math.min(d.originW + (e.clientX - d.startX), maxW));
        const h = Math.max(PANEL_MIN_H, Math.min(d.originH + (e.clientY - d.startY), maxH));
        const next = { x, y, w, h };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
      };
      const onResizeUp = (e) => {
        resizeRef.current = null;
        if (typeof e.currentTarget.releasePointerCapture === 'function'
          && typeof e.currentTarget.hasPointerCapture === 'function'
          && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };

      useEffect(() => {
        if (!s.panelOpen) return;
        // Close the playlist panel when the user clicks outside it
        // (mousedown precedes the toggle's click, so both stay consistent).
        // The directory/file pickers are portaled to <body>, so a click inside
        // them is technically outside the panel's DOM — treat those as "inside"
        // so interacting with the picker never closes the panel underneath.
        // The「加入歌单」弹窗（含本地+QQ）同样 portal 到 body，点击其内菜单不应关面板。
        const onDown = (e) => {
          if (panelRef.current !== null && !panelRef.current.contains(e.target)
            && !(e.target.closest && (e.target.closest('.dsh-music-picker-overlay') || e.target.closest('.dsh-music-add-pop')))) {
            set({ panelOpen: false });
          }
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
      // 面板常驻不卸载：关闭时用根 div 的 display:none 隐藏，而非 return null。
      const rows = s.tracks.map((t) => {
        const active = t.id === s.currentId;
        const playing = active && s.playing;
        return React.createElement('div', { key: t.id, className: 'dsh-music-track-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track' + (active ? ' active' : ''),
            title: t.path,
            // A browser's double-click fires the row's click twice: the first
            // click starts the track, the second lands on the now-active row and
            // would togglePlay() it (pausing it and aborting its pending play
            // promise — historically misreported as an autoplay block). Ignore
            // the repeat click (detail >= 2, plus a time-window fallback) so a
            // double-click keeps playing.
            onClick: (e) => { if (shouldIgnoreRowClick(e, active)) return; if (active) togglePlay(); else startPlayFrom(t.id, 'library'); },
          },
            React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '▶ ' : '') + t.name),
            React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(t.size)),
          ),
          React.createElement('button', {
            className: 'dsh-music-playlist-mini add',
            title: '加入歌单',
            onClick: (e) => { e.stopPropagation(); openAddMenu(t, e); },
          }, '＋'),
        );
      });
      const bookRows = s.books.map((b) => {
        const active = 'book:' + b.id === s.currentId;
        const playing = active && s.playing;
        return React.createElement('button', {
          key: b.id,
          className: 'dsh-music-track' + (active ? ' active' : ''),
          title: b.path || b.name,
          onClick: (e) => { if (shouldIgnoreRowClick(e, active)) return; if (active) togglePlay(); else resumeOrPlayBook(b.id); },
        },
          React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '▶ ' : '') + b.name),
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
        subTabBtn('library', '曲库'),
        subTabBtn(FAV_PLAYLIST_ID, '♥ 我最喜欢'),
        // 自建歌单排在 ＋ 号之前；＋ 固定在末尾用于新建。
        (s.playlists || []).filter((p) => p.id !== FAV_PLAYLIST_ID).map((p) => subTabBtn(p.id, p.name, null, p.id)),
        React.createElement('button', { className: 'dsh-music-subtab add', title: '新建歌单', onClick: onCreatePlaylist }, '＋'),
      );
      const isPlaylistView = s.subTab !== 'library';
      const plView = isPlaylistView ? playlistById(s.subTab) : null;
      const musicBody = plView
        ? React.createElement(PlaylistDetail, { pl: plView, panelRef })
        : (rows.length > 0
          ? rows
          : React.createElement('div', { className: 'dsh-music-empty' }, '暂无音乐。点击上方“选择音乐目录”并选择目录后自动扫描。'));
      // 三个 tab 的内容常驻渲染、非活动 tab 用 display:none 隐藏：这样切 tab 时
      // 不会卸载任何面板（本地音乐 / QQ 面板 / AI 讲书），各自内部 useState 状态
      // 全部保留（例如 QQ 面板当前在「我的歌单/搜索/歌单详情」的哪个 UI）。
      const paneStyle = (key) => ({ display: s.tab === key ? '' : 'none' });
      const bookEmptyBody = s.books.length > 0
        ? bookRows
        : (s.ttsConfigured
          ? React.createElement('div', { className: 'dsh-music-empty' }, '未发现 .txt 小说文件。')
          : React.createElement('div', { className: 'dsh-music-error' }, s.ttsReason || '未配置xiaomi提供方。'));
      // 三个 pane 直接在 .dsh-music-list（flex column）里；仅 QQ pane 设
      // flex:1 + min-height:0 + overflow:hidden（见 .dsh-music-qq-pane），让
      // .dsh-music-qq 撑满 pane 高度、.dsh-music-qq-body 独立滚动：播放列表 UI
      // 只滚歌曲列表，head（返回按钮/歌单名）固定不滚。本地音乐/讲书 pane 保持
      // 普通块级，超高时仍由 .dsh-music-list 滚动。
      const listBody = React.createElement('div', { className: 'dsh-music-list-body' },
        React.createElement('div', { style: paneStyle('music') }, musicBody),
        React.createElement('div', { className: 'dsh-music-qq-pane', style: paneStyle('qq') }, React.createElement(QQOnlinePanel, { panelRef })),
        React.createElement('div', { style: paneStyle('book') }, bookEmptyBody));
      return React.createElement('div', { className: 'dsh-music-panel', ref: panelRef, style: rootStyle },
        React.createElement('div', {
          className: 'dsh-music-panel-head dsh-music-panel-drag',
          onPointerDown: onHeadDown, onPointerMove: onHeadMove, onPointerUp: onHeadUp,
        },
          React.createElement('span', { className: 'dsh-music-panel-grip', 'aria-hidden': true }, '⠿'),
          React.createElement('span', { className: 'dsh-music-panel-title' }, '播放列表'),
          React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: () => set({ panelOpen: false }) }, '✕')),
        React.createElement('div', { className: 'dsh-music-tabs' }, tabBtn('music', '本地音乐'), tabBtn('qq', 'QQ音乐'), tabBtn('book', 'AI讲书')),
        s.tab === 'qq' ? null : React.createElement(DirectorySetting, { panelRef }),
        s.tab === 'music' ? musicSubTabs : null,
        // While a novel is playing, keep music-only errors/scanning out of the
        // panel (novel status shows on the playback bar instead).
        // 音乐/小说统一在主列表区上方显示 error（设置块不再重复/分模式显示）。
        s.error ? React.createElement('div', { className: 'dsh-music-error' }, s.error) : null,
        !isBook && s.loading ? React.createElement('div', { className: 'dsh-music-loading' }, '扫描中…') : null,
        React.createElement('div', { className: 'dsh-music-list', style: pos === null ? null : { maxHeight: 'none' }, ref: (el) => { listRef.current = el; } }, listBody),
        React.createElement('div', { className: 'dsh-music-resize', title: '拖动调整面板大小', onPointerDown: onResizeDown, onPointerMove: onResizeMove, onPointerUp: onResizeUp }),
        addMenu ? React.createElement(AddToPlaylistMenu, {
          track: addMenu.track, anchor: { x: addMenu.x, y: addMenu.y },
          onClose: () => setAddMenu(null),
        }) : null,
        s.prompt ? React.createElement(PromptModal, { key: s.prompt.id, panelRef }) : null,
        s.confirm ? React.createElement(ConfirmModal, { key: s.confirm.title, panelRef }) : null,
      );
    }
    // 自定义输入弹窗（替代浏览器 prompt）：新建/重命名歌单等需要名称输入的场景。
    // 以面板中心为基准居中；回车=确定、Esc/点遮罩/关闭=取消。key 由父级传 id，
    // 保证每次 openPrompt 打开时重新挂载、初始输入值正确。
    function PromptModal({ panelRef }) {
      const s = useStore();
      const p = s.prompt;
      if (p === null) return null;
      const [value, setValue] = useState(p.initial || '');
      const inputRef = useRef(null);
      useEffect(() => { if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, []);
      const submit = () => {
        const v = value.trim();
        if (v === '') return;
        closePrompt();
        if (typeof p.onOk === 'function') p.onOk(v);
      };
      const cancel = () => closePrompt();
      const onKeyDown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      };
      return portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker prompt', style: panelCenterStyle(panelRef, true, 150, 160) },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, p.title),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: cancel }, '✕')),
          React.createElement('input', {
            className: 'dsh-music-prompt-input', ref: inputRef, value,
            placeholder: '请输入名称', onChange: (e) => setValue(e.target.value), onKeyDown,
            'aria-label': p.title,
          }),
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn', onClick: submit }, '确定'),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: cancel }, '取消')),
        )));
    }
    // 自定义确认弹窗（替代浏览器 confirm）：删除/清空歌单等破坏性操作前的确认。
    // 无输入框，仅标题 + 提示消息 + 确定/取消；以面板中心为基准居中。
    function ConfirmModal({ panelRef }) {
      const s = useStore();
      const c = s.confirm;
      if (c === null) return null;
      const ok = () => { closeConfirm(); if (typeof c.onOk === 'function') c.onOk(); };
      const onKeyDown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
      };
      return portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker confirm', style: panelCenterStyle(panelRef, true, 150, 280), onKeyDown },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, c.title),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: closeConfirm }, '✕')),
          c.message ? React.createElement('p', { className: 'dsh-music-hint' }, c.message) : null,
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn' + (c.danger ? ' danger' : ''), onClick: ok }, c.okText),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: closeConfirm }, '取消')),
        )));
    }
    // Directory setting block, embedded in the player panel (the former
    // 设置 → 音乐播放器 page moved in-panel so all library config lives in one place).
    function DirectorySetting({ panelRef }) {
      const s = useStore();
      const [pickerOpen, setPickerOpen] = useState(false);
      const [dirs, setDirs] = useState([]);
      const [files, setFiles] = useState([]);
      const [curPath, setCurPath] = useState('');
      const [curName, setCurName] = useState('');
      const [curCrumbs, setCurCrumbs] = useState([]);
      const [dirError, setDirError] = useState(null);
      const isBook = s.tab === 'book';
      const activeRoot = isBook ? s.bookRoot : s.root;
      const pickerTitle = isBook ? '选择小说目录' : '选择音乐目录';
      const hint = isBook
        ? '支持 .txt 文件，AI语音目前仅支持xiaomi提供方（限时免费），请在设置中配置好再使用此功能。'
        : '支持 mp3 / m4a / flac / wav / ogg / opus / aac / webm 等格式，自动递归扫描子目录。';
      return React.createElement('div', { className: 'dsh-music-settings' },
        React.createElement('div', { className: 'dsh-music-settings-row' },
          React.createElement('span', { className: 'dsh-music-settings-cur', title: activeRoot || '' },
            '📁 ' + (activeRoot || '未配置')),
          React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => openPicker() }, pickerTitle)),
        React.createElement('p', { className: 'dsh-music-hint' }, hint),
        pickerOpen ? portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
          React.createElement('div', { className: 'dsh-music-picker', style: panelCenterStyle(panelRef, pickerOpen, 320, Math.round(window.innerHeight * 0.72)) },
            React.createElement('div', { className: 'dsh-music-picker-head' },
              React.createElement('span', { className: 'dsh-music-picker-title' }, pickerTitle),
              React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: () => setPickerOpen(false) }, '✕')),
            React.createElement('div', { className: 'dsh-music-picker-cur', title: curPath },
              renderCrumbs(curCrumbs, curPath, curName, browse)),
            React.createElement('div', { className: 'dsh-music-picker-list' },
              // 目录排在前（可点击进入），文件排在后（仅作展示，不响应点击）。
              dirs.map((d) => React.createElement('button', {
                key: d.path,
                className: 'dsh-music-picker-item',
                title: d.path,
                onClick: () => browse(d.path),
              }, '📁 ' + d.name)),
              files.map((f) => React.createElement('span', {
                key: f.path,
                className: 'dsh-music-picker-item file',
                title: f.path,
              }, '📄 ' + f.name)),
              dirError ? React.createElement('div', { className: 'dsh-music-error' }, dirError) : null,
            ),
            React.createElement('div', { className: 'dsh-music-picker-foot' },
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => pickCurrent() }, '选择此目录'),
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => setPickerOpen(false) }, '取消'),
            ),
          ),
        )) : null,
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
          setCurCrumbs(data.crumbs || []);
          setDirs(data.dirs || []);
          setFiles(data.files || []);
        } catch (err) {
          setDirError('读取目录失败：' + String((err && err.message) || err));
        }
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
        openPrompt('新建歌单名称', '', (trimmed) => {
          if (!trimmed) return;
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
        });
      };
      return React.createElement('div', { className: 'dsh-music-add-pop', ref, style },
        list.length > 0 ? list.map((p) => React.createElement('button', {
          key: p.id,
          className: 'dsh-music-add-pop-item',
          title: '加入「' + p.name + '」',
          onClick: () => addTo(p.id),
        }, (p.id === FAV_PLAYLIST_ID ? '♥ ' : '') + p.name + '（' + p.count + '）')) : null,
        React.createElement('button', { className: 'dsh-music-add-pop-item new', onClick: addNew }, '＋ 新建歌单'),
      );
    }
    // 歌单详情：添加歌曲 + 重命名/删除 + 歌曲列表（移除/上移/下移）。
    function PlaylistDetail({ pl, panelRef }) {
      const [pickerOpen, setPickerOpen] = useState(false);
      const rows = (pl.tracks || []).map((t, idx) => {
        const active = t.id === store.currentId;
        const playing = active && store.playing;
        return React.createElement('div', { key: t.id, className: 'dsh-music-playlist-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track',
            title: t.path,
            // Same double-click guard as the library rows: the second click of a
            // dblclick must not togglePlay() (pause) the just-started track.
            onClick: (e) => { if (shouldIgnoreRowClick(e, active)) return; if (active) togglePlay(); else startPlayFrom(t.id, 'playlist', pl.id); },
          },
            React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '▶ ' : '') + (idx + 1) + '. ' + t.name),
            React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(t.size)),
          ),
          React.createElement('button', { className: 'dsh-music-playlist-mini', title: '上移', onClick: (e) => { e.stopPropagation(); movePlaylistTrack(pl, t.path, -1); } }, '↑'),
          React.createElement('button', { className: 'dsh-music-playlist-mini', title: '下移', onClick: (e) => { e.stopPropagation(); movePlaylistTrack(pl, t.path, 1); } }, '↓'),
          React.createElement('button', { className: 'dsh-music-playlist-mini del', title: '从歌单移除', onClick: (e) => { e.stopPropagation(); apiPlaylistRemove(pl.id, [t.path]); } }, '×'),
        );
      });
      return React.createElement('div', { className: 'dsh-music-playlist' },
        React.createElement('div', { className: 'dsh-music-playlist-head' },
          React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => setPickerOpen(true) }, '＋ 添加歌曲'),
          React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onClearPlaylist(pl) }, '清空'),
          !pl.fixed ? React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onRenamePlaylist(pl) }, '重命名') : null,
          !pl.fixed ? React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onDeletePlaylist(pl) }, '删除') : null,
          pl.missing > 0 ? React.createElement('span', { className: 'dsh-music-playlist-missing', title: '部分歌曲文件已被移动或删除' }, pl.missing + ' 首已失效') : null,
        ),
        rows.length > 0 ? rows : React.createElement('div', { className: 'dsh-music-empty dsh-music-playlist-empty' }, '歌单为空，点击「添加歌曲」从本地文件选择音乐。'),
        pickerOpen ? React.createElement(FilePicker, { pl, panelRef, onClose: () => setPickerOpen(false) }) : null,
      );
    }
    // 文件系统多选器：浏览目录 + 勾选音频文件，用于歌单「添加歌曲」。
    function FilePicker({ pl, panelRef, onClose }) {
      const [cur, setCur] = useState({ path: '', name: '', dirs: [], files: [], crumbs: [] });
      const [sel, setSel] = useState(new Set());
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const browse = async (p) => {
        setErr(null);
        try {
          const data = await jsonGet('/dsh-music/files?path=' + encodeURIComponent(p || ''));
          if (data && data.error) { setErr(data.error); return; }
          setCur({ path: data.path || '', name: data.name || '', dirs: data.dirs || [], files: data.files || [], crumbs: data.crumbs || [] });
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
      return portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker', style: panelCenterStyle(panelRef, true, 320, Math.round(window.innerHeight * 0.72)) },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, '添加歌曲到「' + pl.name + '」'),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: onClose }, '✕')),
          React.createElement('div', { className: 'dsh-music-picker-cur', title: cur.path },
            renderCrumbs(cur.crumbs, cur.path, cur.name, browse)),
          React.createElement('div', { className: 'dsh-music-picker-list' },
            (cur.dirs || []).map((d) => React.createElement('button', {
              key: d.path, className: 'dsh-music-picker-item', title: d.path,
              onClick: () => browse(d.path),
            }, '📁 ' + d.name)),
            (cur.files || []).map((f) => {
              const checked = sel.has(f.path);
              return React.createElement('button', {
                key: f.path,
                className: 'dsh-music-file-item' + (checked ? ' checked' : ''),
                title: f.path,
                onClick: () => toggle(f.path),
              },
                React.createElement('span', { className: 'dsh-music-file-check' }, checked ? '✓' : ''),
                React.createElement('span', { className: 'dsh-music-file-name' }, f.name),
                React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(f.size)),
              );
            }),
            err ? React.createElement('div', { className: 'dsh-music-error' }, err) : null,
          ),
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn', onClick: confirmAdd, disabled: busy }, '确定添加（' + sel.size + '）'),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: onClose }, '取消'),
          ),
        ),
      ));
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
            if (p !== undefined && typeof p.catch === 'function') p.catch((err) => { if (!isPlayAborted(err)) set({ error: '播放失败' }); });
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
          // online QQ music track (agent requested source=web, or panel click).
          if (intent.kind === 'qq' && typeof intent.id === 'string' && /^[A-Za-z0-9]+$/.test(intent.id)) {
            const song = { id: intent.id, songmid: intent.id, title: intent.name || 'QQ音乐', artists: intent.artists || [], payplay: 0, source: 'qq' };
            startQQPlayback(song, [song], '在线');
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
            set({ currentId: intent.id, currentName: track.name, currentArtists: track.artists || [], error: null, scope: { kind: 'library' } });
            loadEnvelope(intent.id, track.url);
            prefetchNext();
            savePlayback();
            const promise = audio.play();
            if (promise !== undefined && typeof promise.catch === 'function') {
              promise.catch((err) => {
                if (!isAutoplayBlocked(err)) return;
                set({ error: '浏览器拦截了自动播放，请在播放条点击▶解锁', pendingId: intent.id, pendingName: track.name });
              });
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
      // Accent follows the host app's theme brand color (stable from the start —
      // no green-default-to-sampled-blue flash); green is only the fallback when
      // the app exposes no brand color. The alias must be declared on BODY, not
      // :root: DSH defines its --dsw-alias-* theme tokens on <body> only, and a
      // var() reference resolves against the element that declares it — on
      // :root (html) it cannot see body's tokens and would always fall back to
      // green. Declared on body, the reference resolves and children inherit
      // the theme's actual brand color.
      'body { --dsh-music-accent: var(--dsw-alias-brand-primary, #2f9e6e); --dsh-music-accent-fg: var(--dsw-alias-label-primary-foreground, #fff); }\n' +
      '.dsh-music-bar-wrap { box-sizing: border-box; width: 100%; padding: 0 var(--dsh-composer-side-clearance, 16px); }\n' +
      '.dsh-music-bar { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; max-width: var(--dsh-composer-card-max-width, 780px); margin: 0 auto; padding: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius: 8px; transition: opacity 0.3s ease; }\n' +
      '.dsh-music-bar.dimmed { opacity: 0.5; }\n' +
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
      '.dsh-music-bar-time { line-height: 1; font-variant-numeric: tabular-nums; }\n' +
      '.dsh-music-bar-hint { color: var(--dsw-alias-state-warn-primary, #d9a441); white-space: nowrap; }\n' +
      // 时长 + 控制按钮的组合：右对齐（margin-left:auto 把整个组合推到最右）。
      '.dsh-music-bar-controls { display: inline-flex; align-items: center; gap: 8px; flex: none; margin-left: auto; min-width: 0; }\n' +
      // 控制按钮组：默认折叠（max-width:0 + overflow:hidden 裁剪），鼠标进入播放条时
      // 从右向左滑入展开（translateX + opacity）。折叠让时长自动滚到最右。
      // overflow:hidden 只用于裁剪左右滑动的按钮；三个向上弹出的弹层（音量/模式/
      // 章节目录）已改为 portal 渲染到 body，不受此裁剪影响。
      '.dsh-music-bar-btns { display: inline-flex; align-items: center; gap: 8px; overflow: hidden; max-width: 0; opacity: 0; transform: translateX(16px); transition: max-width 0.3s ease, opacity 0.2s ease, transform 0.3s ease; white-space: nowrap; }\n' +
      '.dsh-music-bar-controls.on .dsh-music-bar-btns { max-width: 340px; opacity: 1; transform: translateX(0); }\n' +
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
      '.dsh-music-panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 460px; max-height: 72vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 1000; pointer-events: auto; overflow: hidden; }\n' +
      '.dsh-music-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; z-index: 5; }\n' +
      '.dsh-music-resize::after { content: ""; position: absolute; right: 4px; bottom: 4px; width: 5px; height: 5px; border-right: 2px solid var(--dsw-alias-label-secondary, #8a8f98); border-bottom: 2px solid var(--dsw-alias-label-secondary, #8a8f98); opacity: 0.7; }\n' +
      '.dsh-music-resize:hover::after { opacity: 1; }\n' +
      '.dsh-music-panel-head { display: flex; align-items: center; gap: 6px; }\n' +
      '.dsh-music-tabs { display: flex; gap: 4px; }\n' +
      '.dsh-music-tab { flex: 1; padding: 5px 0; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-tab:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-tab.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-panel-drag { cursor: move; touch-action: none; user-select: none; }\n' +
      '.dsh-music-panel-grip { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; letter-spacing: -1px; opacity: 0.7; }\n' +
      '.dsh-music-panel-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-icon-btn { background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }\n' +
      '.dsh-music-icon-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-panel-root { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-mode-menu { position: relative; flex: none; }\n' +
      '.dsh-music-mode-menu.right { margin-left: auto; }\n' +
      '.dsh-music-mode-trigger { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; }\n' +
      '.dsh-music-mode-trigger:hover, .dsh-music-mode-trigger.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-mode-pop { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% + 6px); z-index: 60; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 6px; height: 108px; box-sizing: border-box; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-mode-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; }\n' +
      '.dsh-music-mode-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-mode-item.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; min-height: 60px; max-height: 40vh; }\n' +
      // pane 层的包裹 div：改成 flex 列容器（否则它是块级元素，QQ pane 的 flex:1
      // 不生效、没有确定高度，导致 .dsh-music-qq-body 不滚动、整棵被 .dsh-music-list
      // 滚走 → 滚动条会盖住固定的 head）。设为 flex:1+min-height:0 撑满列表区高度：
      // QQ pane 内的 .dsh-music-qq-body 成为唯一滚动容器，滚动条只出现在 head 下方。
      // 本地音乐/讲书 pane 因 min-height:auto 不会被压缩、仍超高溢出、由列表滚动，行为不变。
      '.dsh-music-list-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }\n' +
      '.dsh-music-track { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-track:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 正在播放/选中的条目：填充强调色底 + 强调色文字，让当前条目一眼可见（选中态）。
      '.dsh-music-track.active { color: var(--dsh-music-accent, #2f9e6e); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-track.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-track-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 在线 QQ 歌曲行：歌名 + 内嵌 VIP 徽标并排，歌名省略、VIP 徽标不省略。
      '.dsh-music-track-name.qq { display: inline-flex; align-items: center; gap: 5px; overflow: hidden; }\n' +
      '.dsh-music-track-name.qq .dsh-music-track-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-track-name.qq .dsh-music-online-tag { flex: 0 0 auto; margin-left: 0; }\n' +
      // 歌单卡片：封面图 + 名称 + 元信息，网格排布。
      '.dsh-music-playlist-card { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.06)); border-radius: 10px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-playlist-card:hover { border-color: var(--dsh-music-accent, #2f9e6e); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); }\n' +
      // 「我的歌单」卡片：外层相对定位，右上角删除按钮悬浮。
      '.dsh-music-qq-mine-card { position: relative; }\n' +
      '.dsh-music-qq-mine-del { position: absolute; top: 6px; right: 6px; z-index: 2; width: 20px; height: 20px; line-height: 18px; padding: 0; text-align: center; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: var(--dsw-alias-bg-overlay, rgba(0,0,0,0.55)); color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; opacity: 0; transition: opacity 0.15s; }\n' +
      '.dsh-music-qq-mine-card:hover .dsh-music-qq-mine-del { opacity: 1; }\n' +
      '.dsh-music-qq-mine-del:hover { color: #fff; background: #c9352c; border-color: #c9352c; }\n' +
      '.dsh-music-playlist-cover { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-playlist-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }\n' +
      '.dsh-music-playlist-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }\n' +
      '.dsh-music-playlist-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-qq-topdetail-head { display: flex; align-items: center; gap: 10px; margin: 8px 0 6px; }\n' +
      // 「加载更多」：水平居中 + 圆角胶囊按钮。
      '.dsh-music-qq-loadmore { display: flex; justify-content: center; margin: 14px 0 6px; }\n' +
      '.dsh-music-qq-loadmore-btn { padding: 7px 22px; border-radius: 20px; border: 1px solid var(--dsh-music-accent, #2f9e6e); background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; transition: background 0.15s, color 0.15s; }\n' +
      '.dsh-music-qq-loadmore-btn:hover { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-track-size { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-empty { padding: 12px; text-align: center; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      '.dsh-music-error { color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 12px; }\n' +
      '.dsh-music-loading { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      '.dsh-music-settings { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.dsh-music-settings-row { display: flex; gap: 8px; align-items: center; }\n' +
      '.dsh-music-settings-cur { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn { padding: 6px 12px; border-radius: 8px; border: none; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); cursor: pointer; font-size: 13px; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn.ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-settings-btn.danger { background: #c9352c; color: #fff; }\n' +
      '.dsh-music-picker-overlay { position: fixed; inset: 0; z-index: 2000; display: flex; overflow: auto; padding: 16px; background: rgba(0,0,0,0.45); }\n' +
      '.dsh-music-picker { box-sizing: border-box; width: 88%; max-width: 640px; max-height: 100%; margin: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-picker-head { display: flex; align-items: center; flex: none; }\n' +
      '.dsh-music-picker-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-picker-cur { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: nowrap; overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }\n' +
      '.dsh-music-picker-cur::-webkit-scrollbar { height: 4px; }\n' +
      '.dsh-music-picker-cur::-webkit-scrollbar-thumb { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.14)); border-radius: 4px; }\n' +
      '.dsh-music-crumb { display: inline-block; padding: 1px 4px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; border-radius: 4px; }\n' +
      '.dsh-music-crumb:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-crumb.cur { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; cursor: default; }\n' +
      '.dsh-music-crumb-sep { margin: 0 2px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-crumb-plain { color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-picker-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-picker-item { text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-picker-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 文件条目：仅作展示，不可点击（无 hover 高亮，光标为默认）。
      '.dsh-music-picker-item.file { color: var(--dsw-alias-label-secondary, #8a8f98); cursor: default; }\n' +
      '.dsh-music-picker-foot { display: flex; gap: 8px; justify-content: flex-end; flex: none; }\n' +
      // 自定义输入弹窗（新建/重命名歌单）的输入框。
      '.dsh-music-prompt-input { box-sizing: border-box; width: 100%; padding: 8px 10px; font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; outline: none; }\n' +
      '.dsh-music-prompt-input:focus { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 新建/重命名/删除/清空弹窗较窄，不用居中列表那种 640px 宽。
      '.dsh-music-picker.prompt, .dsh-music-picker.confirm { width: 300px; max-width: 90vw; }\n' +
      '.dsh-music-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      // ---- 在线 QQ 音乐 ----
      '.dsh-music-qq { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.dsh-music-settings-row.qq-account { gap: 6px; }\n' +
      '.dsh-music-qq-search { display: flex; gap: 8px; position: relative; }\n' +
      '.dsh-music-qq-hist { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 20; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; padding: 4px; max-height: 240px; overflow-y: auto; box-shadow: 0 8px 20px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-qq-hist-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 4px; }\n' +
      '.dsh-music-qq-hist-clear { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 4px; }\n' +
      '.dsh-music-qq-hist-clear:hover { color: var(--dsw-alias-state-error-primary, #e5534b); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-qq-hist-item { display: block; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-hist-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-qq-input { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; }\n' +
      '.dsh-music-online-tag { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 6px; padding: 0 6px; line-height: 16px; margin-left: 6px; }\n' +
      '.dsh-music-online-tag.vip { color: #e6a23c; border-color: #e6a23c; }\n' +
      '.dsh-music-picker.qq-login { max-width: 340px; }\n' +
      '.dsh-music-qq-login-body { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px 4px; }\n' +
      '.dsh-music-qq-qr { width: 280px; height: 280px; max-width: 70vw; image-rendering: pixelated; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; object-fit: contain; }\n' +
      '.dsh-music-qq-login-status { font-size: 14px; color: var(--dsw-alias-label-primary, #e6e6e6); text-align: center; }\n' +
      '.dsh-music-qq-login-actions { display: flex; gap: 8px; }\n' +
      '.dsh-music-qq-viewtabs { display: flex; gap: 6px; }\n' +
      '.dsh-music-qq-viewtab { padding: 5px 12px; border-radius: 8px; border: none; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-qq-viewtab.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-qq-cats { display: flex; flex-wrap: wrap; gap: 6px; }\n' +
      '.dsh-music-qq-cat { padding: 4px 10px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-cat.active { border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 分类折叠/展开切换按钮：小号、次要色、无边框。
      '.dsh-music-qq-cat-toggle { display: block; margin: 8px auto 0; padding: 3px 12px; border: none; background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-cat-toggle:hover { text-decoration: underline; }\n' +
      '.dsh-music-qq-topgroup { margin-bottom: 8px; }\n' +
      '.dsh-music-qq-topitem { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 7px 10px; margin: 3px 0; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; text-align: left; }\n' +
      '.dsh-music-qq-topitem:hover { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-qq-topname { font-weight: 600; }\n' +
      '.dsh-music-qq-topmeta { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-qq-detail-head { display: flex; gap: 8px; align-items: center; margin: 6px 0; }\n' +
      '.dsh-music-qq { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; }\n' +
      // QQ 面板所在 pane 不设 overflow:hidden（否则它自身会成为一个滚动容器，把
      // sticky 的 head 困在内部、无法吸附到真正滚动的 .dsh-music-list）。pane 保持
      // 普通流式布局，滚动交给 head 下方的 .dsh-music-list / .dsh-music-qq-body。
      '.dsh-music-qq-pane { flex: 1; min-height: 0; overflow: visible; display: flex; flex-direction: column; }\n' +
      // head 用 sticky 固定在滚动区顶部：无论实际滚动容器是 .dsh-music-list
      // 还是 .dsh-music-qq-body，返回按钮行 / 子tab 行都不会被列表滚走（内容在其下方滑动）。
      '.dsh-music-qq-head { flex: none; position: sticky; top: 0; z-index: 3; background: var(--dsw-alias-bg-overlay, #1e1f22); padding-bottom: 4px; }\n' +
      '.dsh-music-qq-body { flex: 1; overflow-y: auto; min-height: 0; }\n' +
      '.dsh-music-qq-section { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); margin: 10px 0 4px; font-weight: 600; }\n' +
      '.dsh-music-qq-now { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-qq-now-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-qq-now-artist { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); margin-left: 4px; }\n' +
      '.dsh-music-qq-now-src { flex: 0 0 auto; color: var(--dsw-alias-label-secondary, #8a8f98); margin-left: auto; }\n' +
      '.dsh-music-qq-toolbar { display: flex; justify-content: space-between; gap: 8px; align-items: center; }\n' +
      '.dsh-music-qq-login { flex: 1; min-height: 200px; display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-qq-login-center { display: flex; flex-direction: column; gap: 12px; align-items: center; max-width: 320px; }\n' +
      '.dsh-music-qq-login-btn { width: 200px; padding: 10px 16px; font-size: 15px; }\n' +
      // 免责声明：居中块内的左对齐编号列表，阅读更清晰。
      '.dsh-music-qq-login-warn { display: flex; flex-direction: column; gap: 4px; width: 100%; max-width: 300px; margin-top: 4px; font-size: 12px; color: var(--dsw-alias-state-warn-primary, #d9a441); line-height: 1.5; text-align: left; box-sizing: border-box; max-height: 30vh; overflow-y: auto; }\n' +
      '.dsh-music-qq-login-warn-title { font-weight: 600; margin-bottom: 2px; }\n' +
      '.dsh-music-qq-login-warn-p { margin: 0; }\n' +
      '.dsh-music-qq-login-warn-item { display: flex; gap: 6px; align-items: flex-start; }\n' +
      '.dsh-music-qq-login-warn-num { flex: none; }\n' +
      // 讲书时章节名是主信息：占满剩余弹性空间、尽量完整显示；书名让出空间（可截断）。
      '.dsh-music-bar.book .dsh-music-bar-name { max-width: 24%; }\n' +
      '.dsh-music-bar-section { margin-left: 8px; flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 6px; padding: 0 6px; line-height: 16px; }\n' +
      '.dsh-music-bar-src { margin-left: 6px; flex: 0 0 auto; white-space: nowrap; color: var(--dsh-music-accent, #2f9e6e); font-size: 11px; border: 1px solid var(--dsh-music-accent, #2f9e6e); border-radius: 6px; padding: 0 6px; line-height: 16px; }\n' +
      '.dsh-music-bar-artist { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; margin-left: 6px; }\n' +
      '.dsh-music-bar-artist-name { margin-left: 6px; }\n' +
      '.dsh-music-toc-trigger { position: relative; flex: none; display: inline-flex; align-self: center; }\n' +
      // 章节目录弹层：与音量/播放模式弹窗同款定位——相对容器 + 绝对定位，
      // bottom:calc(100%+6px) 让其出现在按钮正上方，left:50% 居中。
      '.dsh-music-toc { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% + 6px); width: 380px; max-height: 60vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 60; }\n' +
      '.dsh-music-toc-head { display: flex; align-items: center; gap: 6px; }\n' +
      '.dsh-music-toc-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-toc-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-toc-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-toc-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-toc-item.active { color: var(--dsh-music-accent, #2f9e6e); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-toc-item.active .dsh-music-toc-heading { font-weight: 600; }\n' +
      '.dsh-music-toc-type { flex: none; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-toc-item.active .dsh-music-toc-type { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-toc-heading { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 自建歌单：音乐页子标签 / 歌单详情 / 文件多选 / 播放条收藏
      '.dsh-music-subtabs { display: flex; gap: 4px; flex-wrap: wrap; }\n' +
      '.dsh-music-subtab { flex: none; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; border-radius: 16px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-subtab:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-subtab.active { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-subtab.add { width: 30px; padding: 4px 0; text-align: center; color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist { display: flex; flex-direction: column; flex: 1; }\n' +
      '.dsh-music-playlist-empty { flex: 1; display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-playlist-head { display: flex; align-items: center; gap: 6px; padding: 2px 2px 0; }\n' +
      '.dsh-music-playlist-btn { flex: none; background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; padding: 2px 8px; }\n' +
      '.dsh-music-playlist-btn:hover { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-missing { flex: none; margin-left: auto; font-size: 11px; color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      '.dsh-music-playlist-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-playlist-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-playlist-row.active { border-radius: 6px; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-playlist-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); background: transparent; }\n' +
      '.dsh-music-playlist-row.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-playlist-mini { flex: none; width: 20px; height: 20px; padding: 0; border: none; background: transparent; border-radius: 4px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; line-height: 1; }\n' +
      '.dsh-music-playlist-mini:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.del:hover { color: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '.dsh-music-file-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-file-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-file-item.checked { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.1)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-file-check { flex: none; width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4)); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; }\n' +
      '.dsh-music-file-item.checked .dsh-music-file-check { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 曲库每行：track 按钮 + 行尾「＋」（加入歌单）
      '.dsh-music-track-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-track-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-track-row.active { border-radius: 6px; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-track-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); background: transparent; }\n' +
      '.dsh-music-track-row.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-playlist-mini.add { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.remove { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.remove:hover { color: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '.dsh-music-add-pop { position: fixed; z-index: 1200; min-width: 150px; max-width: 210px; display: flex; flex-direction: column; gap: 2px; padding: 6px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-add-pop-item { display: block; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-add-pop-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-add-pop-item.new { color: var(--dsh-music-accent, #2f9e6e); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); margin-top: 2px; padding-top: 6px; }\n' +
      '.dsh-music-bar-btn.fav { color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-btn.fav.on { color: var(--dsh-music-accent, #2f9e6e); }\n';

    return module.exports;
  },
});
