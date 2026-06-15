const HALLUCINATION_PATTERNS = [
  /^\[?(music|silence|blank audio|inaudible)\]?[\s.!?]*$/i,
  /^(thank you for watching|thanks for watching|please subscribe)[\s.!?]*$/i,
  /^(subtitles|captions) by\b/i,
  /\bamara\.org\b/i,
  /^(you|yeah|okay|ok|right|so)[\s,.!?]*\1?[\s,.!?]*$/i,
  /^(the\s+){3,}/i
];

function normalizeTranscript(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return normalizeTranscript(text).split(/\s+/).filter(Boolean).length;
}

function transcriptFingerprint(text) {
  return normalizeTranscript(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '');
}

function assessTranscript({
  text,
  confidence,
  interim = false,
  rms,
  peak,
  source = ''
} = {}) {
  const normalized = normalizeTranscript(text);
  if (!normalized || normalized.length < 3) return { accepted: false, reason: 'empty', text: '' };
  if (HALLUCINATION_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { accepted: false, reason: 'known-hallucination-pattern', text: normalized };
  }

  const words = wordCount(normalized);
  const numericConfidence = Number(confidence);
  const hasConfidence = Number.isFinite(numericConfidence) && numericConfidence > 0;
  const numericRms = Number(rms);
  const numericPeak = Number(peak);
  const hasAudioMetrics = Number.isFinite(numericRms) || Number.isFinite(numericPeak);
  const heardSpeech = !hasAudioMetrics || numericRms >= 0.007 || numericPeak >= 0.045;

  if (!interim && !heardSpeech) {
    return { accepted: false, reason: 'no-speech-energy', text: normalized };
  }
  if (!interim && hasConfidence && numericConfidence < 0.52) {
    return { accepted: false, reason: 'low-confidence', text: normalized };
  }
  if (!interim && words === 1 && normalized.length < 5 && hasConfidence && numericConfidence < 0.72) {
    return { accepted: false, reason: 'weak-single-word', text: normalized };
  }

  return {
    accepted: true,
    reason: '',
    text: normalized,
    confidence: hasConfidence ? numericConfidence : undefined,
    words,
    source
  };
}

function isRecentDuplicate(text, recent = [], now = Date.now(), windowMs = 12000) {
  const fingerprint = transcriptFingerprint(text);
  if (!fingerprint) return false;
  const words = new Set(fingerprint.split(/\s+/).filter(Boolean));
  return recent.some(item => {
    if (now - item.timestamp > windowMs) return false;
    if (item.fingerprint === fingerprint) return true;
    const prior = new Set(String(item.fingerprint || '').split(/\s+/).filter(Boolean));
    if (words.size < 12 || prior.size < 12) return false;
    const overlap = [...words].filter(word => prior.has(word)).length;
    return overlap / Math.max(words.size, prior.size) >= 0.92;
  });
}

module.exports = {
  assessTranscript,
  isRecentDuplicate,
  normalizeTranscript,
  transcriptFingerprint,
  wordCount
};
