/**
 * HUD state and rendering. Simulator keys: T = shard award, R = cycle round.
 */
(function () {
  const state = {
    shards: 0,
    roundId: 1,
    roundStatus: 'RUNNING', // RUNNING | ENDED | RESETTING
    countdownActive: false,
    countdownSeconds: 0,
    feed: [],
    toasts: [],
    splashText: null
  };

  const FEED_MAX = 6;
  const TOAST_DURATION_MS = 3200;
  const TOAST_MAX = 5;

  let countdownIntervalId = null;
  let root = null;

  function setState(partial) {
    Object.assign(state, partial);
    render();
  }

  function render() {
    if (!root) root = document.getElementById('hud-root');
    if (!root) return;

    // Shards
    const shardsEl = root.querySelector('.hud-shards-value');
    if (shardsEl) shardsEl.textContent = String(state.shards);

    // Round banner (slide-in is applied in cycleRound on change)
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

    // Countdown visibility
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

    // Feed (DOM managed by pushFeed; we just trim length here if needed)
    const feedContainer = root.querySelector('.hud-feed');
    if (feedContainer && state.feed.length > FEED_MAX) {
      state.feed = state.feed.slice(-FEED_MAX);
      renderFeed(feedContainer);
    }

    // Toasts are DOM-managed by pushToast
    // Splash is DOM-managed by showSplash
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

  function runCountdown(seconds) {
    if (countdownIntervalId) clearInterval(countdownIntervalId);
    state.countdownActive = true;
    state.countdownSeconds = seconds;
    render();

    countdownIntervalId = setInterval(function () {
      state.countdownSeconds -= 1;
      const countdownEl = root && root.querySelector('.hud-countdown');
      if (countdownEl) countdownEl.textContent = state.countdownSeconds + 's';
      if (state.countdownSeconds <= 0) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
        state.countdownActive = false;
        render();
      }
    }, 1000);
  }

  function simulateShardAward() {
    const add = 1 + Math.floor(Math.random() * 5);
    const from = state.shards;
    const to = from + add;
    setState({ shards: to });

    const shardsEl = root && root.querySelector('.hud-shards-value');
    if (shardsEl) {
      shardsEl.classList.remove('glow');
      shardsEl.offsetHeight;
      shardsEl.classList.add('glow');
      animateNumber(shardsEl, from, to, 400);
    }

    const shardsBox = root && root.querySelector('.hud-shards');
    if (shardsBox) {
      shardsBox.classList.remove('pulse');
      shardsBox.offsetHeight;
      shardsBox.classList.add('pulse');
    }

    pushToast('shard', '+' + add + ' shards');
    pushFeed('Collected ' + add + ' shard' + (add === 1 ? '' : 's'));
  }

  function cycleRound() {
    const statusOrder = ['RUNNING', 'ENDED', 'RESETTING'];
    let idx = statusOrder.indexOf(state.roundStatus);
    idx = (idx + 1) % statusOrder.length;
    const nextStatus = statusOrder[idx];

    if (nextStatus === 'RUNNING') {
      state.roundId += 1;
      showSplash('Round ' + state.roundId);
      runCountdown(5);
    } else if (nextStatus === 'ENDED') {
      if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
      }
      state.countdownActive = false;
    }

    setState({ roundStatus: nextStatus });

    var banner = root && root.querySelector('.hud-round');
    if (banner) {
      banner.classList.remove('slide-in');
      banner.offsetHeight;
      banner.classList.add('slide-in');
    }
    pushToast('round', 'Round ' + state.roundId + ' — ' + nextStatus);
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      simulateShardAward();
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      cycleRound();
    }
  }

  function init() {
    root = document.getElementById('hud-root');
    if (!root) return;
    render();
    document.addEventListener('keydown', onKeyDown);

    if (typeof window.HUD !== 'undefined') {
      window.HUD.setState = setState;
      window.HUD.render = render;
      window.HUD.animateNumber = animateNumber;
      window.HUD.pushToast = pushToast;
      window.HUD.pushFeed = pushFeed;
      window.HUD.showSplash = showSplash;
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
})();
