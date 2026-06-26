const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: .14 });
document.querySelectorAll('.reveal').forEach(element => observer.observe(element));

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
    stage.style.marginBottom = `${-Math.min(scrollY, innerHeight) * .07}px`;
  }, { passive: true });
}
