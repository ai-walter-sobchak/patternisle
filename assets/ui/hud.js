/**
 * HUD state and rendering. Server-authoritative: state comes from hytopia.onData (type: hud, toast, feed, roundSplash).
 * Schema v1: { type:'hud', shards, roundId, status, target, winnerName?, resetEndsAtMs? } etc.
 * Settings (scale, reduce motion, mute UI sounds) persisted in localStorage.
 */
(function () {
  const state = {
    shards: 0,
    roundId: 1,
    roundStatus: 'RUNNING',
    target: 25,
    winnerName: null,
    resetEndsAtMs: null,
    countdownActive: false,
    countdownSeconds: 0,
    feed: [],
    toasts: [],
    splashText: null
  };

  const FEED_MAX = 6;
  const TOAST_DURATION_MS = 3200;
  const TOAST_MAX = 5;
  const STREAK_WINDOW_MS = 2000;
  const HUD_SETTINGS_KEY = 'patternisle-hud-settings';

  let countdownIntervalId = null;
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

    const countdownWrap = root.querySelector('.hud-countdown-wrap');
    const countdownEl = root.querySelector('.hud-countdown');
    if (countdownWrap && countdownEl) {
      if (state.countdownActive) {
        countdownEl.classList.remove('hidden');
        countdownEl.textContent = state.countdownSeconds + 's';
      } else {
        countdownEl.classList.add('hidden');
      }
    }

    const feedContainer = root.querySelector('.hud-feed');
    if (feedContainer && state.feed.length > FEED_MAX) {
      state.feed = state.feed.slice(-FEED_MAX);
      renderFeed(feedContainer);
    }
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

  /** Client-side countdown from server-provided end timestamp (ms since epoch). */
  function runCountdownFromEndMs(endMs) {
    if (countdownIntervalId) clearInterval(countdownIntervalId);
    function update() {
      const now = Date.now();
      const secs = Math.max(0, Math.ceil((endMs - now) / 1000));
      state.countdownActive = secs > 0;
      state.countdownSeconds = secs;
      const countdownEl = root && root.querySelector('.hud-countdown');
      if (countdownEl) {
        if (secs > 0) {
          countdownEl.classList.remove('hidden');
          countdownEl.textContent = secs + 's';
        } else {
          countdownEl.classList.add('hidden');
        }
      }
      if (secs <= 0) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
      }
    }
    update();
    countdownIntervalId = setInterval(update, 1000);
  }

  function stopCountdown() {
    if (countdownIntervalId) {
      clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
    state.countdownActive = false;
    render();
  }

  function applyHudData(data) {
    if (data.v !== 1 || data.type !== 'hud') return;
    const fromShards = state.shards;
    const toShards = typeof data.shards === 'number' ? data.shards : state.shards;
    const roundId = typeof data.roundId === 'number' ? data.roundId : state.roundId;
    const status = data.status || state.roundStatus;
    const target = typeof data.target === 'number' ? data.target : state.target;

    setState({
      shards: toShards,
      roundId: roundId,
      roundStatus: status,
      target: target,
      winnerName: data.winnerName !== undefined ? data.winnerName : state.winnerName,
      resetEndsAtMs: data.resetEndsAtMs !== undefined ? data.resetEndsAtMs : null
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

    if (data.resetEndsAtMs != null && data.resetEndsAtMs > Date.now()) {
      runCountdownFromEndMs(data.resetEndsAtMs);
    } else {
      stopCountdown();
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
