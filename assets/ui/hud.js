/**
 * HUD state and rendering. Server-authoritative: state comes from hytopia.onData (type: hud, toast, feed, roundSplash).
 * Schema v1: { type:'hud', shards, roundId, status, target, winnerName?, resetEndsAtMs? } etc.
 * Settings (scale, reduce motion, mute UI sounds) persisted in localStorage.
 */
(function () {
  const state = {
    shards: 0,
    roundId: 1,
    roundStatus: 'LOBBY',
    target: 25,
    winnerName: null,
    matchEndsAtMs: null,
    resetEndsAtMs: null,
    feed: [],
    toasts: [],
    splashText: null,
    scores: []
  };

  const FEED_MAX = 6;
  const TOAST_DURATION_MS = 3200;
  const TOAST_MAX = 5;
  const STREAK_WINDOW_MS = 2000;
  const HUD_SETTINGS_KEY = 'patternisle-hud-settings';

  let timerTickIntervalId = null;
  let root = null;
  let lastPickupTime = 0;
  let streakCount = 0;

  /** Default and persisted HUD settings. */
  function getSettings() {
    try {
      const raw = localStorage.getItem(HUD_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          scale: [0.8, 1, 1.2].includes(Number(parsed.scale)) ? Number(parsed.scale) : 1,
          reduceMotion: Boolean(parsed.reduceMotion),
          muteUiSounds: Boolean(parsed.muteUiSounds)
        };
      }
    } catch (_) { /* ignore */ }
    return { scale: 1, reduceMotion: false, muteUiSounds: false };
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(HUD_SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) { /* ignore */ }
  }

  function applySettings(settings) {
    if (!root) root = document.getElementById('hud-root');
    if (!root) return;
    const s = settings || getSettings();
    root.style.setProperty('--hud-scale', String(s.scale));
    root.classList.toggle('reduce-motion', s.reduceMotion);
  }

  /**
   * Play a UI sound by id. No assets required; gracefully no-ops if file missing or muted.
   * @param {'pickup'|'win'|'toast'} id
   */
  function playUiSound(id) {
    const settings = getSettings();
    if (settings.muteUiSounds) return;
    const map = { pickup: 'pickup', win: 'win', toast: 'toast' };
    const name = map[id];
    if (!name) return;
    try {
      var base = typeof window.CDN_ASSETS_URL !== 'undefined' ? window.CDN_ASSETS_URL : '';
      var url = (base ? base + '/' : '') + 'sounds/ui-' + name + '.mp3';
      var audio = new window.Audio(url);
      audio.volume = 0.4;
      audio.play().catch(function () {});
    } catch (_) { /* no-op */ }
  }

  function setState(partial) {
    Object.assign(state, partial);
    render();
  }

  function render() {
    if (!root) root = document.getElementById('hud-root');
    if (!root) return;

    const shardsEl = root.querySelector('.hud-shards-value');
    if (shardsEl) shardsEl.textContent = String(state.shards);

    const roundWrap = root.querySelector('.hud-round-wrap');
    if (roundWrap) {
      const roundNum = roundWrap.querySelector('.hud-round-num');
      const roundStatus = roundWrap.querySelector('.hud-round-status');
      if (roundNum) roundNum.textContent = 'Round ' + state.roundId;
      if (roundStatus) {
        roundStatus.textContent = state.roundStatus;
        roundStatus.className = 'hud-round-status ' + state.roundStatus.toLowerCase();
      }
    }

    const feedContainer = root.querySelector('.hud-feed');
    if (feedContainer && state.feed.length > FEED_MAX) {
      state.feed = state.feed.slice(-FEED_MAX);
      renderFeed(feedContainer);
    }

    renderScoreboard();
    renderEndOverlay();
  }

  function renderEndOverlay() {
    const overlay = document.getElementById('hud-end-overlay');
    const winnerEl = document.getElementById('hud-end-winner');
    const listEl = document.getElementById('hud-end-leaderboard');
    const countdownEl = document.getElementById('hud-end-countdown');

    if (!overlay || !winnerEl || !listEl) return;

    if (state.roundStatus === 'RESETTING') {
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');

      winnerEl.textContent = state.winnerName
        ? 'Winner: ' + state.winnerName
        : 'Winner: —';

      listEl.innerHTML = '';
      if (Array.isArray(state.scores)) {
        state.scores.slice(0, 5).forEach(function (entry) {
          const li = document.createElement('li');
          li.textContent = (entry.name != null ? entry.name : '—') + ' — ' + (typeof entry.score === 'number' ? entry.score : 0);
          listEl.appendChild(li);
        });
      }

      if (countdownEl && state.resetEndsAtMs != null) {
        var remaining = Math.max(0, state.resetEndsAtMs - Date.now());
        countdownEl.textContent = 'Next round in ' + (formatRemainingMs(remaining) || '0:00');
      } else if (countdownEl) {
        countdownEl.textContent = '';
      }
    } else {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      if (countdownEl) countdownEl.textContent = '';
    }
  }

  function getLocalPlayerId() {
    try {
      if (typeof window.hytopia !== 'undefined' && window.hytopia != null && typeof window.hytopia.playerId === 'string') {
        return window.hytopia.playerId;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function renderScoreboard() {
    const listEl = root && document.getElementById('hud-scoreboard-list');
    if (!listEl) return;

    const scores = state.scores || [];
    const localPlayerId = getLocalPlayerId();

    listEl.innerHTML = '';

    if (scores.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'hud-scoreboard__empty';
      empty.textContent = 'Waiting for players…';
      listEl.appendChild(empty);
      return;
    }

    scores.forEach(function (entry) {
      const li = document.createElement('li');
      const name = entry.name != null ? String(entry.name) : '—';
      const score = typeof entry.score === 'number' ? entry.score : 0;
      li.textContent = name + ' — ' + score;
      if (localPlayerId != null && entry.playerId === localPlayerId) {
        li.classList.add('hud-scoreboard__player--you');
      }
      listEl.appendChild(li);
    });
  }

  function renderFeed(container) {
    if (!container) container = root && root.querySelector('.hud-feed');
    if (!container) return;
    container.innerHTML = '';
    state.feed.forEach(function (msg) {
      const line = document.createElement('div');
      line.className = 'hud-feed-line slide-in';
      line.textContent = msg;
      container.appendChild(line);
    });
  }

  function animateNumber(el, from, to, ms) {
    if (!el || typeof from !== 'number' || typeof to !== 'number') return;
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / ms, 1);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const value = Math.round(from + (to - from) * ease);
      el.textContent = String(value);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function pushToast(kind, message) {
    if (!root) root = document.getElementById('hud-root');
    const stack = root && root.querySelector('.hud-toast-stack');
    if (!stack) return;

    while (stack.children.length >= TOAST_MAX) stack.removeChild(stack.firstChild);

    const el = document.createElement('div');
    el.className = 'hud-toast ' + (kind || 'info') + ' fade-in';
    el.textContent = message;
    stack.appendChild(el);

    setTimeout(function () {
      el.classList.add('fade-out');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 400);
    }, TOAST_DURATION_MS);
  }

  function pushFeed(message) {
    state.feed = state.feed.slice(-(FEED_MAX - 1)).concat([message]);
    const container = root && root.querySelector('.hud-feed');
    if (!container) return;
    const line = document.createElement('div');
    line.className = 'hud-feed-line slide-in';
    line.textContent = message;
    container.appendChild(line);
    while (container.children.length > FEED_MAX) container.removeChild(container.firstChild);
  }

  function showSplash(text) {
    playUiSound('win');
    if (!root) root = document.getElementById('hud-root');
    let splash = root && root.querySelector('.hud-splash');
    if (!splash && root) {
      splash = document.createElement('div');
      splash.className = 'hud-splash';
      root.appendChild(splash);
    }
    if (!splash) return;
    splash.textContent = text || '';
    splash.classList.remove('animate');
    splash.offsetHeight;
    splash.classList.add('animate');
    setTimeout(function () {
      splash.classList.remove('animate');
    }, 1200);
  }

  /** Format remaining ms as mm:ss. Returns null if no countdown. */
  function formatRemainingMs(remainingMs) {
    if (remainingMs == null || remainingMs <= 0) return null;
    const totalSecs = Math.floor(remainingMs / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /** Update only timer DOM elements from current state. No full render. */
  function tickTimerDisplay() {
    const badgeEl = document.getElementById('hud-status-badge');
    const textEl = document.getElementById('hud-timer-text');
    if (!badgeEl || !textEl) return;

    const status = (state.roundStatus || 'LOBBY').toUpperCase();
    badgeEl.textContent = status === 'RUNNING' ? 'RUNNING' : status === 'RESETTING' ? 'RESETTING' : 'LOBBY';
    badgeEl.className = 'hud-status-badge';
    if (status === 'RUNNING') badgeEl.classList.add('is-running');
    else if (status === 'RESETTING') badgeEl.classList.add('is-resetting');
    else badgeEl.classList.add('is-lobby');

    let remaining = null;
    if (status === 'RUNNING' && state.matchEndsAtMs != null) {
      remaining = Math.max(0, state.matchEndsAtMs - Date.now());
    } else if (status === 'RESETTING' && state.resetEndsAtMs != null) {
      remaining = Math.max(0, state.resetEndsAtMs - Date.now());
    }
    const formatted = formatRemainingMs(remaining);
    textEl.textContent = formatted != null ? formatted : '--:--';

    var endCountdownEl = document.getElementById('hud-end-countdown');
    if (endCountdownEl && state.roundStatus === 'RESETTING' && state.resetEndsAtMs != null) {
      var remainingEnd = Math.max(0, state.resetEndsAtMs - Date.now());
      endCountdownEl.textContent = 'Next round in ' + (formatRemainingMs(remainingEnd) || '0:00');
    }
  }

  function startTimerTick() {
    if (timerTickIntervalId) return;
    tickTimerDisplay();
    timerTickIntervalId = setInterval(tickTimerDisplay, 250);
  }

  function stopTimerTick() {
    if (timerTickIntervalId) {
      clearInterval(timerTickIntervalId);
      timerTickIntervalId = null;
    }
  }

  function applyHudData(data) {
    if (data.v !== 1 || data.type !== 'hud') return;
    const fromShards = state.shards;
    const toShards = typeof data.shards === 'number' ? data.shards : state.shards;
    const roundId = typeof data.roundId === 'number' ? data.roundId : state.roundId;
    const roundStatus = data.roundStatus != null ? data.roundStatus : (data.status != null ? data.status : state.roundStatus);
    const target = typeof data.target === 'number' ? data.target : state.target;
    const matchEndsAtMs = data.matchEndsAtMs !== undefined ? data.matchEndsAtMs : state.matchEndsAtMs;
    const resetEndsAtMs = data.resetEndsAtMs !== undefined ? data.resetEndsAtMs : state.resetEndsAtMs;

    setState({
      shards: toShards,
      roundId: roundId,
      roundStatus: roundStatus,
      target: target,
      winnerName: data.winnerName !== undefined ? data.winnerName : state.winnerName,
      matchEndsAtMs: matchEndsAtMs,
      resetEndsAtMs: resetEndsAtMs,
      scores: Array.isArray(data.scores) ? data.scores : state.scores
    });

    if (fromShards !== toShards) {
      var now = Date.now();
      if (now - lastPickupTime <= STREAK_WINDOW_MS) {
        streakCount += 1;
      } else {
        streakCount = 1;
      }
      lastPickupTime = now;
      playUiSound('pickup');
      if (streakCount >= 2) {
        pushToast('streak', 'STREAK x' + streakCount);
        playUiSound('toast');
      }

      const shardsEl = root && root.querySelector('.hud-shards-value');
      if (shardsEl) {
        shardsEl.classList.remove('glow');
        shardsEl.offsetHeight;
        shardsEl.classList.add('glow');
        animateNumber(shardsEl, fromShards, toShards, 400);
      }
      const shardsBox = root && root.querySelector('.hud-shards');
      if (shardsBox) {
        shardsBox.classList.remove('pulse');
        shardsBox.offsetHeight;
        shardsBox.classList.add('pulse');
      }
    }

    var banner = root && root.querySelector('.hud-round');
    if (banner) {
      banner.classList.remove('slide-in');
      banner.offsetHeight;
      banner.classList.add('slide-in');
    }
  }

  function initSettingsPanel() {
    var panel = document.getElementById('hud-settings-panel');
    var btn = root && root.querySelector('.hud-settings-btn');
    if (!panel || !btn) return;

    var settings = getSettings();

    btn.addEventListener('click', function () {
      var open = panel.getAttribute('aria-hidden') !== 'true';
      panel.classList.toggle('open', !open);
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    });

    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    });

    root.querySelectorAll('.hud-settings-scale button').forEach(function (el) {
      var scale = Number(el.getAttribute('data-scale'));
      el.classList.toggle('active', settings.scale === scale);
      el.addEventListener('click', function () {
        settings.scale = scale;
        saveSettings(settings);
        applySettings(settings);
        root.querySelectorAll('.hud-settings-scale button').forEach(function (b) {
          b.classList.toggle('active', Number(b.getAttribute('data-scale')) === scale);
        });
        el.setAttribute('aria-pressed', 'true');
      });
    });

    var reduceEl = document.getElementById('hud-reduce-motion');
    if (reduceEl) {
      reduceEl.classList.toggle('on', settings.reduceMotion);
      reduceEl.setAttribute('aria-checked', settings.reduceMotion ? 'true' : 'false');
      reduceEl.addEventListener('click', function () {
        settings.reduceMotion = !settings.reduceMotion;
        saveSettings(settings);
        applySettings(settings);
        reduceEl.classList.toggle('on', settings.reduceMotion);
        reduceEl.setAttribute('aria-checked', settings.reduceMotion ? 'true' : 'false');
      });
    }

    var muteEl = document.getElementById('hud-mute-sounds');
    if (muteEl) {
      muteEl.classList.toggle('on', settings.muteUiSounds);
      muteEl.setAttribute('aria-checked', settings.muteUiSounds ? 'true' : 'false');
      muteEl.addEventListener('click', function () {
        settings.muteUiSounds = !settings.muteUiSounds;
        saveSettings(settings);
        muteEl.classList.toggle('on', settings.muteUiSounds);
        muteEl.setAttribute('aria-checked', settings.muteUiSounds ? 'true' : 'false');
      });
    }
  }

  function init() {
    root = document.getElementById('hud-root');
    if (!root) return;
    applySettings(getSettings());
    render();
    startTimerTick();
    initSettingsPanel();

    hytopia.onData(function (data) {
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'ping') {
        const el = document.getElementById('ping-debug');
        if (el) el.textContent = 'PING OK ' + (data.ts ?? '');
        return;
      }
      if (data.type === 'hud') {
        applyHudData(data);
        return;
      }
      if (data.type === 'toast') {
        pushToast(data.kind || 'info', data.message || '');
        return;
      }
      if (data.type === 'feed') {
        pushFeed(data.message || '');
        return;
      }
      if (data.type === 'roundSplash') {
        var roundId = typeof data.roundId === 'number' ? data.roundId : state.roundId;
        showSplash('Round ' + roundId);
        return;
      }
    });

    if (typeof window.HUD !== 'undefined') {
      window.HUD.setState = setState;
      window.HUD.render = render;
      window.HUD.animateNumber = animateNumber;
      window.HUD.pushToast = pushToast;
      window.HUD.pushFeed = pushFeed;
      window.HUD.showSplash = showSplash;
      window.HUD.playUiSound = playUiSound;
      window.HUD.getSettings = getSettings;
      window.HUD.applySettings = applySettings;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.HUD = window.HUD || {};
  window.HUD.setState = setState;
  window.HUD.render = render;
  window.HUD.animateNumber = animateNumber;
  window.HUD.pushToast = pushToast;
  window.HUD.pushFeed = pushFeed;
  window.HUD.showSplash = showSplash;
  window.HUD.playUiSound = playUiSound;
  window.HUD.getSettings = getSettings;
  window.HUD.applySettings = applySettings;
})();
