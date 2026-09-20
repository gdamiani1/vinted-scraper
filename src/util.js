export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Adds ±ratio random jitter to a delay so request timing does not look mechanical. */
export const jitter = (ms, ratio = 0.35) => Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * ms * ratio));

export function num(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/** Lower-case, strip diacritics and collapse whitespace so lookups tolerate sloppy input. */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function absUrl(base, path) {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path, base).toString();
}

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(level = 'info', stream = process.stderr) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, args) => {
    if (LEVELS[lvl] > threshold) return;
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false }); // local time, matches the terminal clock
    stream.write(`${ts} ${lvl.padEnd(5)} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  };
  return {
    level,
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
  };
}

export class VintedError extends Error {
  constructor(message, { code = 'VINTED_ERROR', status, cause } = {}) {
    super(message, { cause });
    this.name = 'VintedError';
    this.code = code;
    this.status = status;
  }
}
