const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const nav = document.querySelector('[data-site-nav]');
const updateNav = () => nav?.classList.toggle('scrolled', scrollY > 80);
addEventListener('scroll', updateNav, { passive: true });
updateNav();

const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('visible');
    revealObserver.unobserve(entry.target);
  });
}, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });

document.querySelectorAll('.reveal').forEach((element, index) => {
  element.style.transitionDelay = reducedMotion ? '0ms' : `${Math.min(index % 3, 2) * 70}ms`;
  revealObserver.observe(element);
});

const stepsList = document.querySelector('[data-steps]');
if (stepsList) {
  const steps = [...stepsList.querySelectorAll('li')];
  const stepObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('lit');
      const completed = steps.filter(step => step.classList.contains('lit')).length;
      stepsList.style.setProperty('--steps-progress', `${(completed / steps.length) * 100}%`);
      stepObserver.unobserve(entry.target);
    });
  }, { threshold: 0.55 });
  steps.forEach(step => stepObserver.observe(step));
}

const demoButtons = [...document.querySelectorAll('[data-demo-step]')];
const demoPanels = [...document.querySelectorAll('[data-demo-panel]')];
function selectDemo(index) {
  demoButtons.forEach((button, buttonIndex) => {
    button.classList.toggle('active', buttonIndex === index);
    button.setAttribute('aria-pressed', String(buttonIndex === index));
  });
  demoPanels.forEach((panel, panelIndex) => panel.classList.toggle('active', panelIndex === index));
}
demoButtons.forEach((button, index) => button.addEventListener('click', () => selectDemo(index)));

const elapsed = document.querySelector('[data-elapsed]');
if (elapsed && !reducedMotion) {
  let seconds = 8 * 60 + 14;
  setInterval(() => {
    seconds += 1;
    const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
    const remainder = String(seconds % 60).padStart(2, '0');
    elapsed.textContent = `00:${minutes}:${remainder}`;
  }, 1000);
}

document.querySelectorAll('.faq-list details').forEach(detail => {
  detail.addEventListener('toggle', () => {
    if (!detail.open) return;
    document.querySelectorAll('.faq-list details').forEach(other => {
      if (other !== detail) other.open = false;
    });
  });
});

const inviteParams = new URLSearchParams(location.search);
const inviteCode = String(inviteParams.get('code') || '').trim().toUpperCase();
const shouldOpenApp = inviteParams.get('open') === '1';

function validInviteCode(code) {
  return /^TRV-[A-Z0-9]{6}$/.test(code);
}

function applyInviteCode(code) {
  if (!validInviteCode(code)) return;
  const protocolUrl = `truveil://join?code=${encodeURIComponent(code)}`;
  const primaryActions = [...document.querySelectorAll('.primary-action')];
  primaryActions.forEach((link, index) => {
    link.href = protocolUrl;
    link.removeAttribute('download');
    link.textContent = index === 0 ? 'Open Truveil Secure' : 'Open with code';
  });

  document.querySelectorAll('.code-preview').forEach(preview => {
    preview.textContent = code;
  });

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
    setTimeout(() => {
      location.href = protocolUrl;
    }, 500);
  }
}

applyInviteCode(inviteCode);

if (!reducedMotion) {
  const heroWindow = document.querySelector('.hero-window');
  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking || !heroWindow) return;
    ticking = true;
    requestAnimationFrame(() => {
      const progress = Math.min(scrollY / Math.max(innerHeight, 1), 1);
      heroWindow.style.transform = `perspective(1400px) rotateX(2deg) translateY(${progress * -38}px)`;
      ticking = false;
    });
  }, { passive: true });
}
