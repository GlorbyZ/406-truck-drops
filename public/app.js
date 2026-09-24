/* 406 Truck Drops front end. No frameworks, no build step. */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var FEED_URL = '/api/drops';
  var REFRESH_MS = 5 * 60 * 1000;

  var listEl = document.getElementById('feed-list');
  var statusEl = document.getElementById('feed-status');
  var alertsBtn = document.getElementById('alerts-btn');
  var alertsNote = document.getElementById('alerts-note');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtPrice(p) {
    if (p == null || p === '') return 'Price on listing';
    var n = Number(p);
    if (!isFinite(n)) return esc(p);
    return '$' + n.toLocaleString('en-US');
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso);
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function cardHTML(drop) {
    var meta = [drop.location, fmtTime(drop.listed_at)].filter(Boolean).join(' · ');
    var link = drop.url
      ? '<a class="card-link" href="' + esc(drop.url) + '" target="_blank" rel="noopener">View listing</a>'
      : '';
    return (
      '<article class="card reveal">' +
      '<div class="card-top">' +
      '<h3 class="card-title">' + esc(drop.title) + '</h3>' +
      '<p class="card-price">' + fmtPrice(drop.price) + '</p>' +
      '</div>' +
      (meta ? '<p class="card-meta">' + esc(meta) + '</p>' : '') +
      (drop.take ? '<p class="card-take">' + esc(drop.take) + '</p>' : '') +
      link +
      '</article>'
    );
  }

  var observer = null;
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            observer.unobserve(e.target);
          }
        });
      },
      { rootMargin: '0px 0px 60px 0px' }
    );
  }

  function observeReveals() {
    if (!observer) return;
    listEl.querySelectorAll('.reveal:not(.in)').forEach(function (el) {
      observer.observe(el);
    });
  }

  function render(drops) {
    if (!drops.length) {
      listEl.innerHTML =
        '<div class="feed-empty">No drops yet. When a cheap 4x4 hits Marketplace around Billings, it lands here first.</div>';
      return;
    }
    listEl.innerHTML = drops.map(cardHTML).join('');
    observeReveals();
  }

  function load() {
    statusEl.textContent = 'Checking for new trucks…';
    fetch(FEED_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('bad status ' + r.status);
        return r.json();
      })
      .then(function (drops) {
        render(Array.isArray(drops) ? drops : []);
        var n = Array.isArray(drops) ? drops.length : 0;
        statusEl.textContent = n
          ? n + (n === 1 ? ' drop' : ' drops') + ' live · updated just now'
          : 'Nothing live right now';
      })
      .catch(function () {
        statusEl.textContent = 'Could not reach the feed. Retrying soon.';
        if (!listEl.children.length) {
          listEl.innerHTML =
            '<div class="feed-error">Feed is down for a sec. Check back in a minute.</div>';
        }
      });
  }

  load();
  setInterval(load, REFRESH_MS);

  /* ---------- Web push alerts ---------- */

  function b64ToBytes(b64) {
    var bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function note(msg) {
    alertsNote.textContent = msg;
  }

  function setBtn(label, disabled) {
    alertsBtn.textContent = label;
    alertsBtn.disabled = !!disabled;
  }

  function subscribe() {
    setBtn('Working…', true);
    note('');
    var reg;
    return navigator.serviceWorker
      .register('/sw.js')
      .then(function (r) {
        reg = r;
        return fetch('/api/push/vapid-public-key', { cache: 'no-store' });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('vapid key unavailable');
        return r.json();
      })
      .then(function (data) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes(data.publicKey).buffer,
        });
      })
      .then(function (sub) {
        var json = sub.toJSON();
        return fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: json.keys,
          }),
        });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('subscribe failed');
        setBtn('Alerts on', true);
        note('You will get a ping for every new drop.');
      })
      .catch(function (err) {
        setBtn('Get alerts', false);
        if (err && err.name === 'NotAllowedError') {
          note('Notifications are blocked. Allow them in your browser settings to get alerts.');
        } else {
          note('Could not turn on alerts on this device. Try again.');
        }
      });
  }

  function initAlerts() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setBtn('Get alerts', true);
      note('Push alerts are not supported in this browser.');
      return;
    }
    if (Notification.permission === 'denied') {
      setBtn('Get alerts', true);
      note('Notifications are blocked. Allow them in your browser settings to get alerts.');
      return;
    }
    if (Notification.permission === 'granted') {
      setBtn('Get alerts', false);
      note('Tap to turn on drop alerts on this device.');
    }
    alertsBtn.addEventListener('click', function () {
      if (Notification.permission === 'default') {
        Notification.requestPermission().then(function (perm) {
          if (perm === 'granted') subscribe();
          else note('No problem. You can still check the feed here anytime.');
        });
      } else if (Notification.permission === 'granted') {
        subscribe();
      }
    });
  }

  initAlerts();
})();
