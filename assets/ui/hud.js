/**
 * HUD state and rendering. Server-authoritative.
 * Schema v1: { type:'hud', shards, roundId, status, target, winnerName?, resetEndsAtMs?, scores?, health? }
 */

(function () {
  const state = {
    shards: 0,
    roundId: 1,
    roundStatus: 'LOBBY',
    target: 25,
    winnerName: null,
    matchEndsAtMs: null,
    feed: [],
    toasts: [],
    scores: [],
    health: null,
    effects: [],
    ambientScore: 0
  };

  const FEED_MAX = 6;
  const TOAST_DURATION_MS = 3200;
  const TOAST_MAX = 5;
  const STREAK_WINDOW_MS = 2000;
  const HUD_SETTINGS_KEY = 'patternisle-hud-settings';

  let root = null;
  let lastPickupTime = 0;
  let streakCount = 0;

  // =========================================================
  // SETTINGS
  // =========================================================

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
    } catch (_) {}
    return { scale: 1, reduceMotion: false, muteUiSounds: false };
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(HUD_SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {}
  }

  function applySettings(settings) {
    if (!root) root = document.getElementById('hud-root');
    if (!root) return;
    const s = settings || getSettings();
    root.style.setProperty('--hud-scale', String(s.scale));
    root.classList.toggle('reduce-motion', s.reduceMotion);
  }

  // =========================================================
  // AUDIO
  // =========================================================

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
    } catch (_) {}
  }

  // =========================================================
  // TIME FORMAT
  // =========================================================

  function formatRemainingMs(remainingMs) {
    if (remainingMs == null || remainingMs <= 0) return null;
    const totalSecs = Math.floor(remainingMs / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function tickTimerDisplay() {
    const textEl = document.getElementById('hud-timer-text');
    if (!textEl) return;

    // Hide the badge above the timer entirely (no "LOBBY"/"RUNNING" label)
    const badgeEl = document.getElementById('hud-status-badge');
    if (badgeEl) {
      badgeEl.textContent = '';
      badgeEl.style.display = 'none';
    }

    const status = (state.roundStatus || 'LOBBY').toUpperCase();

    let remaining = null;
    if (status === 'RUNNING' && state.matchEndsAtMs != null) {
      remaining = Math.max(0, state.matchEndsAtMs - Date.now());
    } else if (status === 'RESETTING' && state.resetEndsAtMs != null) {
      remaining = Math.max(0, state.resetEndsAtMs - Date.now());
    }

    const formatted = formatRemainingMs(remaining);
    textEl.textContent = formatted != null ? formatted : '--:--';

    // End overlay countdown stays updated too
    var endCountdownEl = document.getElementById('hud-end-countdown');
    if (endCountdownEl && state.roundStatus === 'RESETTING' && state.resetEndsAtMs != null) {
      var remainingEnd = Math.max(0, state.resetEndsAtMs - Date.now());
      endCountdownEl.textContent = 'Next round in ' + (formatRemainingMs(remainingEnd) || '0:00');
    }
  }

  // =========================================================
  // CORE RENDER
  // =========================================================

  function setState(partial) {
    Object.assign(state, partial);
    render();
    tickTimerDisplay();
  }

  function render() {
    if (!root) root = document.getElementById('hud-root');
    if (!root) return;

    // Shards
    const shardsEl = document.getElementById('hud-shards-value');
    if (shardsEl) shardsEl.textContent = String(state.shards);

    // Progress
    renderProgress();

    // Health (object: { current, max, invulnerableUntilMs? } or null)
    const healthWrap = document.getElementById('hud-health');
    const healthValueEl = document.getElementById('hud-health-value');
    const healthFillEl = document.getElementById('hud-health-fill');
    const healthShieldEl = document.getElementById('hud-health-shield');
    if (healthWrap && healthValueEl && healthFillEl) {
      const h = state.health;
      if (h != null && typeof h === 'object' && 'current' in h && 'max' in h) {
        const current = Number(h.current) || 0;
        const max = Math.max(1, Number(h.max) || 100);
        const pct = Math.max(0, Math.min(100, (current / max) * 100));
        healthValueEl.textContent = String(Math.round(current));
        healthFillEl.style.width = pct + '%';
        healthWrap.classList.remove('hidden');
        if (healthShieldEl) {
          const invuln = h.invulnerableUntilMs != null && Date.now() < h.invulnerableUntilMs;
          healthShieldEl.classList.toggle('hidden', !invuln);
          healthShieldEl.setAttribute('aria-hidden', invuln ? 'false' : 'true');
        }
      } else {
        healthWrap.classList.add('hidden');
        if (healthShieldEl) healthShieldEl.classList.add('hidden');
      }
    }

    // Round
    const roundNumEl = document.getElementById('hud-round-num');
    const roundStatusEl = document.getElementById('hud-round-status');

    if (roundNumEl) roundNumEl.textContent = 'Round ' + state.roundId;

    // Remove "LOBBY" under Round: blank it out + hide it.
    if (roundStatusEl) {
      const rs = String(state.roundStatus || '').toUpperCase();
      const show = rs !== 'LOBBY' && rs !== '';
      roundStatusEl.textContent = show ? rs : '';
      roundStatusEl.className = 'hud-round-status ' + rs.toLowerCase();
      if (show) roundStatusEl.classList.remove('hidden');
      else roundStatusEl.classList.add('hidden');
    }

    renderBuffs();
    renderScoreboard();
    renderEndOverlay();
  }

  // =========================================================
  // POWER-UP BUFFS
  // =========================================================

  function formatEffectRemaining(expiresAtMs) {
    const remaining = Math.max(0, expiresAtMs - Date.now());
    const secs = Math.ceil(remaining / 1000);
    return secs + 's';
  }

  function renderBuffs() {
    const wrap = document.getElementById('hud-buffs');
    if (!wrap) return;

    const effects = state.effects || [];
    if (effects.length === 0) {
      wrap.innerHTML = '';
      wrap.classList.add('hidden');
      return;
    }

    wrap.classList.remove('hidden');
    wrap.innerHTML = '';
    effects.forEach(function (e) {
      const kind = (e.kind || '').replace(/_/g, ' ');
      const remaining = formatEffectRemaining(e.expiresAtMs || 0);
      const pill = document.createElement('span');
      pill.className = 'hud-buff-pill';
      pill.setAttribute('aria-label', kind + ', ' + remaining + ' left');
      pill.textContent = kind + ' ' + remaining;
      wrap.appendChild(pill);
    });
  }

  // =========================================================
  // PROGRESS BAR
  // =========================================================

  function renderProgress() {
    const fillEl = document.getElementById('hud-progress-fill');
    const labelEl = document.getElementById('hud-progress-label');
    const remainingEl = document.getElementById('hud-progress-remaining');

    if (!fillEl || !labelEl || !remainingEl) return;

    const shards = state.shards || 0;
    const target = state.target || 0;

    labelEl.textContent = `${shards} / ${target}`;

    if (target > 0) {
      remainingEl.textContent =
        shards >= target
          ? 'WIN READY'
          : `+${Math.max(0, target - shards)} to win`;
    } else {
      remainingEl.textContent = '+0 to win';
    }

    const pct = target > 0
      ? Math.max(0, Math.min(1, shards / target)) * 100
      : 0;

    fillEl.style.width = pct + '%';
  }

  // =========================================================
  // SCOREBOARD
  // =========================================================

  function getLocalPlayerId() {
    try {
      if (window.hytopia && typeof window.hytopia.playerId === 'string') {
        return window.hytopia.playerId;
      }
    } catch (_) {}
    return null;
  }

  function renderScoreboard() {
    const listEl = document.getElementById('hud-scoreboard-list');
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
      const name = entry.name ?? '—';
      const score = entry.score ?? 0;

      li.textContent = name + ' — ' + score;

      if (localPlayerId && entry.playerId === localPlayerId) {
        li.classList.add('hud-scoreboard__player--you');
      }

      listEl.appendChild(li);
    });
  }

  // =========================================================
  // END OVERLAY
  // =========================================================

  function renderEndOverlay() {
    const overlay = document.getElementById('hud-end-overlay');
    const winnerEl = document.getElementById('hud-end-winner');
    const listEl = document.getElementById('hud-end-leaderboard');

    if (!overlay || !winnerEl || !listEl) return;

    if (state.roundStatus === 'RESETTING') {
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');

      winnerEl.textContent = state.winnerName
        ? 'Winner: ' + state.winnerName
        : 'Winner: —';

      listEl.innerHTML = '';

      (state.scores || []).slice(0, 5).forEach(function (entry) {
        const li = document.createElement('li');
        li.textContent = (entry.name ?? '—') + ' — ' + (entry.score ?? 0);
        listEl.appendChild(li);
      });
    } else {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      const endCountdownEl = document.getElementById('hud-end-countdown');
      if (endCountdownEl) endCountdownEl.textContent = '';
    }
  }

  // =========================================================
  // SHARD ANIMATION
  // =========================================================

  function animateNumber(el, from, to, ms) {
    if (!el) return;
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

  function applyHudData(data) {
    if (data.v !== 1 || data.type !== 'hud') return;

    const fromShards = state.shards;
    const toShards = data.shards ?? state.shards;
    const health = data.health !== undefined ? data.health : state.health;

    setState({
      shards: toShards,
      roundId: data.roundId ?? state.roundId,
      roundStatus: data.status ?? state.roundStatus,
      target: data.target ?? state.target,
      winnerName: data.winnerName ?? state.winnerName,
      matchEndsAtMs: data.matchEndsAtMs ?? state.matchEndsAtMs,
      resetEndsAtMs: data.resetEndsAtMs ?? state.resetEndsAtMs,
      scores: Array.isArray(data.scores) ? data.scores : state.scores,
      health: health,
      effects: Array.isArray(data.effects) ? data.effects : state.effects,
      ambientScore: data.ambientScore ?? state.ambientScore
    });

    if (fromShards !== toShards) {
      const now = Date.now();
      if (now - lastPickupTime <= STREAK_WINDOW_MS) streakCount++;
      else streakCount = 1;
      lastPickupTime = now;

      playUiSound('pickup');

      const shardsEl = document.getElementById('hud-shards-value');
      if (shardsEl) {
        animateNumber(shardsEl, fromShards, toShards, 300);
        shardsEl.classList.add('glow');
        setTimeout(() => shardsEl.classList.remove('glow'), 400);
      }

      if (streakCount >= 2) {
        playUiSound('toast');
      }
    }
  }

  // =========================================================
  // INIT (includes settings panel wiring)
  // =========================================================

  function initSettingsPanel() {
    var panel = document.getElementById('hud-settings-panel');
    var btn = root && root.querySelector('.hud-settings-btn');
    if (!panel || !btn) return;

    var settings = getSettings();

    // Scale buttons
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
      });
    });

    // Reduce motion
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

    // Mute UI sounds
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

    // Open/close panel
    btn.addEventListener('click', function () {
      var isOpen = panel.classList.contains('open');
      if (isOpen) {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
      } else {
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
      }
    });

    // Click outside to close
    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    });
  }

  /** Call from mobile interact button (or key) to send attack action when round is RUNNING. */
  window.triggerAttack = function () {
    if (state.roundStatus !== 'RUNNING') return;
    try {
      if (window.hytopia && typeof window.hytopia.sendData === 'function') {
        window.hytopia.sendData({ type: 'attack' });
      }
    } catch (_) {}
  };

  function init() {
    root = document.getElementById('hud-root');
    if (!root) return;

    applySettings(getSettings());
    render();
    tickTimerDisplay();
    setInterval(function () {
      tickTimerDisplay();
      if ((state.effects || []).length > 0) renderBuffs();
      if (state.health != null && typeof state.health === 'object') render();
    }, 250);

    initSettingsPanel();

    // Defer HUD data listener until hytopia is available (UI may load before SDK injects it)
    function attachDataListener() {
      if (typeof window.hytopia === 'undefined' || typeof window.hytopia.onData !== 'function') {
        setTimeout(attachDataListener, 50);
        return;
      }
      window.hytopia.onData(function (data) {
        if (!data || typeof data.type !== 'string') return;

        if (data.type === 'hud') {
          applyHudData(data);
          return;
        }

        if (data.type === 'ping') {
          const el = document.getElementById('ping-debug');
          if (el) el.textContent = 'PING OK ' + (data.ts ?? '');
          return;
        }
      });
    }
    attachDataListener();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
