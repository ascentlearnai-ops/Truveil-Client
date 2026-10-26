const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('src/renderer/index.html');
const css = read('src/renderer/styles.css');
const source = read('src/renderer/session.js');

function uiHarness() {
  let focused = null;
  const elements = new Map();
  function element(id = '') {
    const attributes = new Map();
    const classes = new Set();
    const listeners = new Map();
    return {
      id, attributes, children: [], style: {}, disabled: false, scrolled: false,
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle: (name, value) => value ? classes.add(name) : classes.delete(name)
      },
      setAttribute: (name, value) => attributes.set(name, String(value)),
      appendChild(child) { this.children.push(child); },
      insertBefore(child, before) {
        const index = this.children.indexOf(before);
        if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
      },
      addEventListener: (type, handler) => listeners.set(type, handler),
      dispatch(type, event = {}) { listeners.get(type)?.(event); },
      click() { if (!this.disabled) this.dispatch('click'); },
      focus() { focused = id; },
      scrollIntoView() { this.scrolled = true; }
    };
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  get('instructionTrack').children = Array.from({ length: 4 }, () => element());
  get('setup-screen').classList.add('active');
  const context = vm.createContext({ document: { getElementById: get, createElement: () => element() } });
  // Load only UI helpers; no bridge, capture, session, or network APIs exist here.
  const uiEnd = source.indexOf('function fmtElapsed');
  assert.notEqual(uiEnd, -1);
  vm.runInContext(source.slice(0, uiEnd), context);
  vm.runInContext('setupInstructionCarousel()', context);
  return { get, context, focused: () => focused };
}

test('instruction controls expose one visible slide and one pressed selector', () => {
  const h = uiHarness();
  const cards = h.get('instructionTrack').children;
  const dots = h.get('instructionDots').children;
  assert.equal(dots.length, 4);
  assert.deepEqual(cards.map(card => card.attributes.get('aria-hidden')), ['false', 'true', 'true', 'true']);
  assert.deepEqual(dots.map(dot => dot.attributes.get('aria-pressed')), ['true', 'false', 'false', 'false']);
  assert.equal(h.get('instructionPrev').disabled, true);
  assert.equal(h.get('instructionNext').disabled, false);
  assert.equal(h.get('instructionViewport').attributes.get('tabindex'), '0');
  for (const [index, dot] of dots.entries()) {
    assert.equal(dot.attributes.get('aria-label'), `Show instruction ${index + 1}`);
    assert.equal(dot.attributes.get('title'), `Show instruction ${index + 1}`);
    assert.equal(dot.attributes.get('aria-controls'), 'instructionTrack');
  }
  dots[3].click();
  assert.equal(h.get('instructionTrack').style.transform, 'translateX(-300%)');
  assert.equal(cards[3].attributes.get('aria-hidden'), 'false');
  assert.equal(dots[3].attributes.get('aria-pressed'), 'true');
  assert.equal(h.get('instructionNext').disabled, true);
  h.get('instructionPrev').click();
  assert.equal(h.get('instructionTrack').style.transform, 'translateX(-200%)');
  h.get('instructionNext').click();
  assert.equal(h.get('instructionNext').disabled, true);
});

test('late caption acknowledgements preserve text without hiding a failed speech connection', () => {
  const h = uiHarness();
  vm.runInContext('demoSpeechUnavailable = true', h.context);
  vm.runInContext(`renderCaption({captionStreamId:'one',interim:false,revision:1,segmentId:'confirmed',text:'Previously confirmed speech.'})`, h.context);
  assert.equal(h.get('captionHistory').children[0].textContent, 'Previously confirmed speech.');
  assert.equal(h.get('captionState').textContent, 'Live captions unavailable');
  vm.runInContext(`renderCaption({captionStreamId:'one',interim:true,revision:2,captionClear:true,text:''})`, h.context);
  assert.equal(h.get('captionState').textContent, 'Live captions unavailable');
});

test('candidate captions revise drafts, preserve finals, reject late drafts and stop after end', () => {
  const h = uiHarness();
  const caption = data => vm.runInContext(`renderCaption(${JSON.stringify({ captionStreamId: 'synthetic', ...data })})`, h.context);
  vm.runInContext('resetCaptions()', h.context);
  caption({ text: 'I use Postgres', interim: true, revision: 1 });
  assert.equal(h.get('captionDraft').textContent, 'I use Postgres');
  caption({ text: 'I used PostgreSQL.', interim: false, revision: 2, segmentId: 'one' });
  assert.equal(h.get('captionHistory').children[0].textContent, 'I used PostgreSQL.');
  assert.equal(h.get('captionDraft').textContent, '');
  caption({ text: 'I use Postgres', interim: true, revision: 1 });
  caption({ text: 'A replay at equal revision', interim: true, revision: 2 });
  assert.equal(h.get('captionDraft').textContent, '');
  caption({ text: 'The next thought', interim: true, revision: 4 });
  caption({ text: 'An earlier stable span.', interim: false, revision: 3, segmentId: 'two' });
  assert.equal(h.get('captionDraft').textContent, 'The next thought');
  caption({ text: '', interim: true, captionClear: true, revision: 5 });
  assert.equal(h.get('captionDraft').textContent, '');
  vm.runInContext('sessionEnding = true', h.context);
  caption({ text: 'must not appear', interim: true, revision: 6 });
  assert.equal(h.get('captionDraft').textContent, '');
});

test('draft growth follows the bottom but does not interrupt someone reading older captions', () => {
  const h = uiHarness();
  vm.runInContext('resetCaptions()', h.context);
  const scroll = h.get('captionScroll');
  scroll.clientHeight = 100;
  scroll.scrollTop = 100;
  Object.defineProperty(scroll, 'scrollHeight', { get: () => 200 + h.get('captionDraft').textContent.length });
  vm.runInContext(`renderCaption({ captionStreamId: 'one', interim: true, revision: 1, text: 'A growing draft' })`, h.context);
  assert.equal(scroll.scrollTop, scroll.scrollHeight);
  scroll.scrollTop = 0;
  vm.runInContext(`renderCaption({ captionStreamId: 'one', interim: true, revision: 2, text: 'A growing draft with more speech' })`, h.context);
  assert.equal(scroll.scrollTop, 0);
});

test('candidate finals follow capture order even when fallback requests complete in reverse', () => {
  const h = uiHarness();
  const caption = data => vm.runInContext(`renderCaption(${JSON.stringify({ captionStreamId: 'one', interim: false, ...data })})`, h.context);
  vm.runInContext('resetCaptions()', h.context);
  caption({ text: 'Live speech first.', segmentId: 'live', streamEpoch: 0, revision: 1, sequence: 7, startedAt: 1000 });
  caption({ text: 'Then I verified.', segmentId: 'fallback-1', streamEpoch: 1, revision: 2, sequence: 1, startedAt: 6000 });
  caption({ text: 'First I repaired.', segmentId: 'fallback-0', streamEpoch: 1, revision: 3, sequence: 0, startedAt: 3500 });
  assert.deepEqual(h.get('captionHistory').children.map(child => child.textContent), ['Live speech first.', 'First I repaired.', 'Then I verified.']);
  caption({ text: 'Next connection.', segmentId: 'new-connection', streamEpoch: 2, revision: 4, sequence: 0, startedAt: 1000 });
  assert.equal(h.get('captionHistory').children.at(-1).textContent, 'Next connection.');
  caption({ text: 'Backup second.', segmentId: 'backup-1', streamEpoch: 3, revision: 5, sequence: 1, timestamp: 8000 });
  caption({ text: 'Backup first.', segmentId: 'backup-0', streamEpoch: 3, revision: 6, sequence: 0, timestamp: 9000 });
  assert.deepEqual(h.get('captionHistory').children.slice(-2).map(child => child.textContent), ['Backup first.', 'Backup second.']);
});

test('instruction keyboard navigation clamps at ends and prevents arrow scrolling', () => {
  const h = uiHarness();
  const viewport = h.get('instructionViewport');
  let prevented = 0;
  const key = value => viewport.dispatch('keydown', { key: value, preventDefault: () => prevented++ });
  key('ArrowLeft');
  assert.equal(h.get('instructionTrack').style.transform, 'translateX(-0%)');
  key('ArrowRight');
  assert.equal(h.get('instructionTrack').style.transform, 'translateX(-100%)');
  key('End');
  key('ArrowRight');
  assert.equal(h.get('instructionTrack').style.transform, 'translateX(-300%)');
  key('Home');
  assert.equal(h.get('instructionTrack').style.transform, 'translateX(-0%)');
  assert.equal(prevented, 5);
  key('Tab');
  assert.equal(prevented, 5, 'Tab must retain native focus navigation');
});

test('instruction swipes ignore vertical scrolling and cancelled gestures', () => {
  const h = uiHarness();
  const viewport = h.get('instructionViewport');
  viewport.dispatch('pointerdown', { clientX: 150, clientY: 20, pointerId: 1 });
  viewport.dispatch('pointerup', { clientX: 80, clientY: 25 });
  assert.equal(h.get('instructionTrack').style.transform, 'translateX(-100%)');
  viewport.dispatch('pointerdown', { clientX: 150, clientY: 20, pointerId: 2 });
  viewport.dispatch('pointerup', { clientX: 100, clientY: 120 });
  assert.equal(h.get('instructionTrack').style.transform, 'translateX(-100%)');
  viewport.dispatch('pointerdown', { clientX: 150, clientY: 20, pointerId: 3 });
  viewport.dispatch('pointercancel');
  viewport.dispatch('pointerup', { clientX: 50, clientY: 20 });
  assert.equal(h.get('instructionTrack').style.transform, 'translateX(-100%)');
});

test('screen changes move keyboard focus and reveal the new view without session calls', () => {
  const h = uiHarness();
  for (const name of ['active', 'ended', 'setup']) {
    vm.runInContext(`showScreen('${name}')`, h.context);
    assert.equal(h.focused(), `${name}-screen`);
    assert.equal(h.get(`${name}-screen`).scrolled, true);
    for (const screen of ['setup', 'active', 'ended']) {
      assert.equal(h.get(`${screen}-screen`).classList.contains('active'), screen === name);
    }
  }
});

test('candidate markup preserves renderer targets, labels, and visible consent', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
  for (const match of source.matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(ids.includes(match[1]), `Missing renderer target ${match[1]}`);
  }
  for (const id of ['sessionCodeInput', 'candidateNameInput', 'sessionConsentInput']) {
    assert.ok(html.includes(`for="${id}"`), `${id} needs a visible label`);
  }
  assert.match(html, /href="#main-content"/);
  assert.match(html, /id="main-content" tabindex="-1"/);
  assert.match(html, /id="instructionDots" role="group"/);
  assert.doesNotMatch(html, /id="instructionDots"[^>]*aria-hidden/);
  assert.match(html, /id="toast" role="alert"/);
  assert.match(html, /id="blockingBanner" role="alert" hidden/);
  assert.doesNotMatch(html, /id="sessionConsentInput"[^>]*\schecked\b/);
  assert.doesNotMatch(html, /<details|class="orb|noise-overlay|linearGradient/);
  for (const notice of ['Microphone transcript', 'Optional browser sharing', 'No camera.', 'No screen recording.', 'No file or clipboard access.', 'No automatic hiring decision.', 'Unsaved work', 'Other windows and apps are not monitored']) {
    assert.ok(html.includes(notice), `Missing privacy notice: ${notice}`);
  }
  for (const id of ['tabObserveConsentInput', 'tabCloseConsentInput']) {
    assert.match(html, new RegExp(`for="${id}"`));
    assert.doesNotMatch(html, new RegExp(`id="${id}"[^>]*\\schecked\\b`));
  }
  assert.match(source, /legacy \? 'Foreground activity'/);
});

test('candidate theme uses website tokens, responsive tracks, focus and reduced motion', () => {
  for (const color of ['#1c2c36', '#546671', '#ffffff', '#edf7fd', '#c7e7f8', '#dce7ed']) {
    assert.ok(css.includes(color), `Missing website color ${color}`);
  }
  assert.match(css, /font-family: Manrope/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /forced-colors: active/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient|backdrop-filter|letter-spacing:\s*-/);
  assert.doesNotMatch(css, /font-size:[^;}]*vw/);
});

test('renderer assets are exact copies of the existing local website brand and fonts', () => {
  for (const [directory, file] of [
    ['fonts', 'manrope-regular.ttf'], ['fonts', 'manrope-semibold.ttf'],
    ['fonts', 'manrope-bold.ttf'], ['fonts', 'manrope-OFL.txt'],
    ['brand', 'truveil-lock-transparent.png'], ['brand', 'tavi-wave.webp'],
    ['brand', 'tavi-listen.webp']
  ]) {
    assert.deepEqual(
      fs.readFileSync(path.join(root, 'src/renderer/assets', file)),
      fs.readFileSync(path.join(root, 'assets', directory, file)),
      `${file} must reuse the website asset unchanged`
    );
  }
});
