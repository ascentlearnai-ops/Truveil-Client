const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

/* ── Reveal-on-scroll with per-group stagger ─────────────────── */
const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('visible');
    revealObserver.unobserve(entry.target);
  });
}, { threshold: .16 });
document.querySelectorAll('.reveal').forEach(el => {
  const group = el.parentElement ? [...el.parentElement.children].filter(c => c.classList.contains('reveal')) : [el];
  const pos = Math.max(0, group.indexOf(el));
  el.style.transitionDelay = reducedMotion ? '0s' : `${Math.min(pos * 80, 320)}ms`;
  revealObserver.observe(el);
});

/* ── Nav gains a backdrop once scrolled ──────────────────────── */
const nav = document.querySelector('.site-nav');
const onNav = () => nav && nav.classList.toggle('scrolled', scrollY > 12);
addEventListener('scroll', onNav, { passive: true });
onNav();

/* ── Steps recap list lights up in sequence ──────────────────── */
const stepsList = document.querySelector('.flow-list');
if (stepsList) {
  const steps = [...stepsList.querySelectorAll('li')];
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('lit');
      const lit = steps.filter(s => s.classList.contains('lit')).length;
      stepsList.style.setProperty('--steps-progress', `${(lit / steps.length) * 100}%`);
      io.unobserve(entry.target);
    });
  }, { threshold: .55 });
  steps.forEach(s => io.observe(s));
}

/* ── Check-in story: scroll-scrubbed pinned scene ────────────── */
const track = document.querySelector('[data-story-track]');
const stage = track && track.querySelector('[data-story]');
const storyCode = document.getElementById('storyCode');
const STORY_CODE = 'TRV-482910';
const consentItems = stage ? [...stage.querySelectorAll('[data-consent]')] : [];

function renderStoryFinal() {
  if (!stage) return;
  stage.dataset.phase = '2';
  if (storyCode) storyCode.textContent = STORY_CODE;
  consentItems.forEach(c => c.classList.add('lit'));
}

if (stage) {
  const pinned = () => getComputedStyle(stage).position === 'sticky';
  if (reducedMotion) {
    renderStoryFinal();
  } else {
    let ticking = false;
    const update = () => {
      ticking = false;
      if (!pinned()) { renderStoryFinal(); return; }
      const span = track.offsetHeight - innerHeight;
      const progress = clamp(-track.getBoundingClientRect().top / (span || 1));
      const phase = Math.min(2, Math.floor(progress * 3));
      stage.dataset.phase = String(phase);

      // Phase 0 (0–.33): the code types in.
      if (storyCode) {
        const p0 = clamp(progress / 0.33);
        storyCode.textContent = STORY_CODE.slice(0, Math.floor(STORY_CODE.length * p0));
      }
      // Phase 1 (.33–.66): consent items appear one at a time.
      const p1 = clamp((progress - 0.33) / 0.33);
      const litConsent = Math.round(p1 * consentItems.length);
      consentItems.forEach((c, i) => c.classList.toggle('lit', i < litConsent));
      // Phase 2 handled by CSS via [data-phase="2"].
    };
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll, { passive: true });
    update();
  }
}

/* ── App-stage parallax drift ────────────────────────────────── */
if (!reducedMotion) {
  const appStage = document.querySelector('.app-stage');
  if (appStage) {
    let p = false;
    addEventListener('scroll', () => {
      if (p) return; p = true;
      requestAnimationFrame(() => { p = false; appStage.style.transform = `translateY(${-Math.min(scrollY, innerHeight) * .06}px)`; });
    }, { passive: true });
  }
}

/* ── Invite-code deep link (?code=TRV-XXXXXX&open=1) ──────────── */
const inviteParams = new URLSearchParams(location.search);
const inviteCode = String(inviteParams.get('code') || '').trim().toUpperCase();
const shouldOpenApp = inviteParams.get('open') === '1';

function validInviteCode(code) { return /^TRV-[A-Z0-9]{6}$/.test(code); }

function applyInviteCode(code) {
  if (!validInviteCode(code)) return;
  const protocolUrl = `truveil://join?code=${encodeURIComponent(code)}`;
  document.querySelectorAll('.primary-action').forEach((link, index) => {
    link.href = protocolUrl;
    link.removeAttribute('download');
    link.textContent = index === 0 ? 'Open Truveil Secure' : 'Open with code';
  });

  const codePreview = document.querySelector('.code-preview');
  if (codePreview) codePreview.textContent = code;

  const heroActions = document.querySelector('.hero-actions');
  if (heroActions && !document.querySelector('.invite-panel')) {
    const panel = document.createElement('div');
    panel.className = 'invite-panel';
    panel.innerHTML = `
      <span>Invite code detected</span>
      <strong>${code}</strong>
      <a href="${protocolUrl}">Open app</a>
      <a href="/downloads/TruveilSecure-Setup-1.0.0.exe" download>Download installer</a>
    `;
    heroActions.after(panel);
  }

  if (shouldOpenApp && !sessionStorage.getItem(`truveil-open-${code}`)) {
    sessionStorage.setItem(`truveil-open-${code}`, '1');
    setTimeout(() => { location.href = protocolUrl; }, 500);
  }
}

applyInviteCode(inviteCode);
