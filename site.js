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

if (!reducedMotion) {
  const stage = document.querySelector('.app-stage');
  addEventListener('scroll', () => {
    if (!stage) return;
    stage.style.marginBottom = `${-Math.min(scrollY, innerHeight) * .07}px`;
  }, { passive: true });
}
