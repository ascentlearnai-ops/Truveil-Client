const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: .14 });
document.querySelectorAll('.reveal').forEach(element => {
  const siblings = element.parentElement ? [...element.parentElement.children].filter(child => child.classList.contains('reveal')) : [element];
  const position = Math.max(0, siblings.indexOf(element));
  element.style.transitionDelay = reducedMotion ? '0s' : `${Math.min(position * 90, 360)}ms`;
  observer.observe(element);
});

// Nav gains definition once the page scrolls
const nav = document.querySelector('.site-nav');
const onScrollNav = () => nav && nav.classList.toggle('scrolled', scrollY > 12);
addEventListener('scroll', onScrollNav, { passive: true });
onScrollNav();

// Check-in steps light up in sequence as they enter view
const stepsList = document.querySelector('.steps');
if (stepsList) {
  const steps = [...stepsList.querySelectorAll('li')];
  const stepObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('lit');
      const litCount = steps.filter(step => step.classList.contains('lit')).length;
      stepsList.style.setProperty('--steps-progress', `${(litCount / steps.length) * 100}%`);
      stepObserver.unobserve(entry.target);
    });
  }, { threshold: .5 });
  steps.forEach(step => stepObserver.observe(step));
}

const inviteParams = new URLSearchParams(location.search);
const inviteCode = String(inviteParams.get('code') || '').trim().toUpperCase();
const shouldOpenApp = inviteParams.get('open') === '1';

function validInviteCode(code) {
  return /^TRV-[A-Z0-9]{6}$/.test(code);
}

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
    setTimeout(() => {
      location.href = protocolUrl;
    }, 500);
  }
}

applyInviteCode(inviteCode);

if (!reducedMotion) {
  const stage = document.querySelector('.app-stage');
  addEventListener('scroll', () => {
    if (!stage) return;
    stage.style.transform = `translateY(${-Math.min(scrollY, innerHeight) * .07}px)`;
  }, { passive: true });
}
