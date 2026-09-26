const CATEGORY_LABELS = {
  beater_commuter: 'Beater commuter',
  winter_beater: 'Winter beater',
  first_car: 'First car',
  mechanics_special: "Mechanic's special",
  fun_cheap: 'Fun and cheap',
};

const PLAN_LABELS = {
  free: 'Free',
  monthly: 'Monthly',
  yearly: 'Yearly',
  sms: 'SMS',
};

const STATUS_LABELS = {
  pending: 'Pending email confirm',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
  none: 'No account yet',
};

function money(centsOrDollars) {
  if (centsOrDollars === null || centsOrDollars === undefined) return '';
  return '$' + Number(centsOrDollars).toLocaleString('en-US');
}

function formatWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {
    /* ignore bad listing urls */
  }
  return '';
}

function setMsg(node, text, kind) {
  if (!node) return;
  node.textContent = text || '';
  node.className = 'msg' + (kind ? ' ' + kind : '');
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { res, data };
}

function renderListing(listing) {
  const article = document.createElement('article');
  article.className = 'deal';
  const photo = safeUrl(listing.hero_photo_url);
  if (photo) {
    const img = document.createElement('img');
    img.src = photo;
    img.alt = listing.title || 'Listing photo';
    article.appendChild(img);
  }
  const body = document.createElement('div');
  body.className = 'deal-body';
  const top = document.createElement('div');
  top.className = 'deal-top';
  const h3 = document.createElement('h3');
  h3.textContent = listing.title || 'Untitled';
  const price = document.createElement('div');
  price.className = 'price';
  price.textContent = money(listing.price);
  top.append(h3, price);
  const meta = document.createElement('p');
  meta.className = 'meta';
  const place = [listing.city, listing.state].filter(Boolean).join(', ');
  const miles =
    listing.mileage === null || listing.mileage === undefined
      ? ''
      : Number(listing.mileage).toLocaleString('en-US') + ' mi';
  meta.textContent = [place, miles].filter(Boolean).join(' · ');
  const score = document.createElement('p');
  score.className = 'score';
  score.textContent = listing.deal_score_text || '';
  body.append(top, meta, score);
  if (listing.previous_price && listing.drop_flag) {
    const was = document.createElement('p');
    was.className = 'meta';
    was.textContent = 'Was ' + money(listing.previous_price);
    body.appendChild(was);
  }
  const tags = document.createElement('ul');
  tags.className = 'tags';
  for (const category of listing.categories || []) {
    const li = document.createElement('li');
    li.textContent = CATEGORY_LABELS[category] || category;
    tags.appendChild(li);
  }
  body.appendChild(tags);
  const href = safeUrl(listing.url);
  if (href) {
    const link = document.createElement('p');
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'View listing';
    link.appendChild(a);
    body.appendChild(link);
  }
  article.appendChild(body);
  return article;
}

function initFeed() {
  const list = document.getElementById('feed-list');
  if (!list) return;
  const note = document.getElementById('feed-note');
  const latestBtn = document.getElementById('feed-latest');
  const dropsBtn = document.getElementById('feed-drops');
  let feed = 'latest';

  async function load() {
    list.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Loading deals...';
    list.appendChild(empty);
    try {
      const res = await fetch('/api/listings?feed=' + encodeURIComponent(feed) + '&limit=20');
      const data = await res.json();
      list.replaceChildren();
      if (!res.ok) {
        const err = document.createElement('p');
        err.className = 'muted';
        err.textContent = 'Could not load deals.';
        list.appendChild(err);
        return;
      }
      if (note) {
        note.textContent = data.delayed
          ? 'Showing deals at least 24 hours old. Paid members see new deals instantly.'
          : 'You are seeing new deals as soon as they land.';
      }
      const rows = data.listings || [];
      if (!rows.length) {
        const none = document.createElement('p');
        none.className = 'muted';
        none.textContent = 'No deals in this feed yet.';
        list.appendChild(none);
        return;
      }
      for (const listing of rows) list.appendChild(renderListing(listing));
    } catch {
      list.replaceChildren();
      const err = document.createElement('p');
      err.className = 'muted';
      err.textContent = 'Could not load deals.';
      list.appendChild(err);
    }
  }

  function select(next) {
    feed = next;
    if (latestBtn) latestBtn.setAttribute('aria-pressed', String(next === 'latest'));
    if (dropsBtn) dropsBtn.setAttribute('aria-pressed', String(next === 'price_drops'));
    load();
  }

  if (latestBtn) latestBtn.addEventListener('click', () => select('latest'));
  if (dropsBtn) dropsBtn.addEventListener('click', () => select('price_drops'));
  load();
}

function initSubscribe() {
  const form = document.getElementById('subscribe-form');
  if (!form) return;
  const msg = document.getElementById('subscribe-msg');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = new FormData(form).get('email');
    setMsg(msg, 'Sending...');
    try {
      const { res, data } = await postJson('/api/subscribe', { email });
      if (data.already) setMsg(msg, 'That email is already confirmed.', 'ok');
      else if (res.ok && data.ok) setMsg(msg, 'Check your email for a confirm link.', 'ok');
      else setMsg(msg, 'Could not sign you up. Try again.', 'bad');
    } catch {
      setMsg(msg, 'Could not sign you up. Try again.', 'bad');
    }
  });
}

function initCheckout() {
  const form = document.getElementById('checkout-form');
  if (!form) return;
  const msg = document.getElementById('checkout-msg');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const plan = button && button.getAttribute('data-plan');
    if (!plan) return;
    const email = new FormData(form).get('email');
    setMsg(msg, 'Starting checkout...');
    button.disabled = true;
    try {
      const { res, data } = await postJson('/api/checkout', { email, plan });
      if (res.ok && data.url) {
        location.href = data.url;
        return;
      }
      setMsg(msg, 'Could not start checkout. Try again.', 'bad');
    } catch {
      setMsg(msg, 'Could not start checkout. Try again.', 'bad');
    } finally {
      button.disabled = false;
    }
  });
}

function fillAccount(data) {
  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  set('acct-email', data.email || '');
  set('acct-plan', PLAN_LABELS[data.plan] || data.plan || 'Free');
  set('acct-status', STATUS_LABELS[data.status] || data.status || '');
  const when = document.getElementById('acct-until');
  const label = document.getElementById('acct-until-label');
  if (when && label) {
    const trial = data.trial_end && Date.parse(data.trial_end) > Date.now();
    if (trial) {
      label.textContent = 'Trial ends';
      when.textContent = formatWhen(data.trial_end);
    } else if (data.paid_until) {
      label.textContent = 'Paid until';
      when.textContent = formatWhen(data.paid_until);
    } else {
      label.textContent = 'Access';
      when.textContent = data.plan === 'free' ? 'Free feed, delayed 24 hours' : 'Not active';
    }
  }
  const billing = document.getElementById('billing-link');
  if (billing) billing.hidden = !data.has_billing;
  const pastDue = document.getElementById('past-due-note');
  if (pastDue) pastDue.hidden = data.status !== 'past_due';
}

async function initAccount() {
  const signedOut = document.getElementById('signed-out');
  if (!signedOut) return;
  const signedIn = document.getElementById('signed-in');
  const params = new URLSearchParams(location.search);
  const banner = document.getElementById('account-banner');
  if (params.get('billing') === 'none' && banner) {
    banner.hidden = false;
    banner.textContent = 'No Stripe customer on this account yet. Start a trial from Pricing.';
  }
  if (params.get('signin') === '1' && banner) {
    banner.hidden = false;
    banner.textContent = 'Sign in to manage billing.';
  }

  let me = null;
  try {
    const res = await fetch('/api/me');
    if (res.ok) me = await res.json();
  } catch {
    me = null;
  }
  if (me && me.email) {
    signedOut.hidden = true;
    if (signedIn) signedIn.hidden = false;
    fillAccount(me);
  }

  const form = document.getElementById('login-form');
  const msg = document.getElementById('login-msg');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = new FormData(form).get('email');
      setMsg(msg, 'Sending...');
      try {
        const { res, data } = await postJson('/api/login', { email });
        if (res.ok && data.ok) setMsg(msg, 'Check your email for a sign-in link.', 'ok');
        else setMsg(msg, 'Could not send the sign-in link. Try again.', 'bad');
      } catch {
        setMsg(msg, 'Could not send the sign-in link. Try again.', 'bad');
      }
    });
  }

  const logout = document.getElementById('logout-btn');
  if (logout) {
    logout.addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      location.href = '/account';
    });
  }
}

initFeed();
initSubscribe();
initCheckout();
initAccount();
