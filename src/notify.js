import { execFile } from 'node:child_process';
import { formatLocation } from './geo.js';

export function formatPrice(item) {
  return item.price === undefined ? '?' : `${item.price.toFixed(2)} ${item.currency ?? ''}`.trim();
}

export function formatItemLine(item) {
  const bits = [formatPrice(item)];
  if (item.previousPrice !== undefined) bits.push(`(was ${item.previousPrice.toFixed(2)})`);
  if (item.brand) bits.push(item.brand);
  if (item.size) bits.push(item.size);
  if (item.condition) bits.push(item.condition);
  if (item.location) bits.push(formatLocation(item.location));
  if (item.buy) bits.push(`buy ${item.buy.score}${item.buy.margin !== undefined ? ` (+${item.buy.margin})` : ''}`);
  else if (item.deal) bits.push(`score ${item.deal.score}`);
  const summary = item.verdict?.summary ? `\n  ${item.verdict.summary}` : '';
  return `${bits.join(' · ')} — ${item.title}${summary}\n  ${item.url}`;
}

const EVENT_TITLES = { new: 'New listing', price_drop: 'Price drop', deal: 'Deal', buy: 'Buy candidate' };

function discordPayload({ type, search, items }) {
  const title = `${EVENT_TITLES[type] ?? type}: ${search}`;
  return {
    content: `**${title}** (${items.length})`,
    embeds: items.slice(0, 10).map((it) => ({
      title: it.title?.slice(0, 250) || `Item ${it.id}`,
      url: it.url,
      description: formatItemLine(it).split('\n')[0],
      thumbnail: it.thumbnail ? { url: it.thumbnail } : undefined,
      color: type === 'price_drop' ? 0xf59e0b : 0x22c55e,
    })),
  };
}

function slackPayload({ type, search, items }) {
  const lines = items.slice(0, 20).map((it) => `• <${it.url}|${it.title}> — ${formatItemLine(it).split('\n')[0]}`);
  return { text: `*${EVENT_TITLES[type] ?? type}: ${search}* (${items.length})\n${lines.join('\n')}` };
}

export async function sendWebhook(url, event, { fetchImpl = fetch } = {}) {
  let body;
  if (/discord(app)?\.com\/api\/webhooks/.test(url)) body = discordPayload(event);
  else if (/hooks\.slack\.com/.test(url)) body = slackPayload(event);
  else body = { ...event, sentAt: new Date().toISOString() };
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Webhook ${url} responded ${res.status}`);
}

/** Telegram Bot API: create a bot with @BotFather, message it once, read the chat id from getUpdates. */
export async function sendTelegram({ token, chatId }, event, { fetchImpl = fetch } = {}) {
  const { type, search, items } = event;
  const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const lines = items.slice(0, 15).map((it) => {
    const bits = [formatPrice(it)];
    if (it.previousPrice !== undefined) bits.push(`was ${it.previousPrice.toFixed(2)}`);
    if (it.size) bits.push(it.size);
    if (it.condition) bits.push(it.condition);
    if (it.location) bits.push(formatLocation(it.location));
    if (it.buy) bits.push(`buy ${it.buy.score}${it.buy.margin !== undefined ? ` (+${it.buy.margin})` : ''}`);
    else if (it.deal) bits.push(`score ${it.deal.score}`);
    const summary = it.verdict?.summary ? `\n   <i>${esc(it.verdict.summary)}</i>` : '';
    return `• <a href="${esc(it.url)}">${esc(it.title)}</a>\n   ${esc(bits.join(' · '))}${summary}`;
  });
  const text = `<b>${esc(EVENT_TITLES[type] ?? type)}: ${esc(search)}</b> (${items.length})\n${lines.join('\n')}`;
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: items.length > 1 }),
  });
  if (!res.ok) throw new Error(`Telegram responded ${res.status}: ${(await res.text()).slice(0, 120)}`);
}

export function sendMacNotification(title, message) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], (err) => resolve(!err));
  });
}

/**
 * Builds a notifier that fans an event out to the console, an optional webhook and macOS
 * notifications. Failures in one channel never break the others.
 */
export function createNotifier({ webhook, mac = false, telegram, telegramMinScore = 0, console: useConsole = true, logger, stream = process.stdout } = {}) {
  return async function notify(event) {
    const { type, search, items } = event;
    if (!items?.length) return;
    const hot = items.filter((it) => (it.buy?.score ?? it.deal?.score ?? 0) >= telegramMinScore);
    if (useConsole) {
      stream.write(`\n[${new Date().toLocaleTimeString()}] ${EVENT_TITLES[type] ?? type} · ${search} · ${items.length} item(s)\n`);
      for (const it of items) stream.write(`  ${formatItemLine(it).replace('\n', '\n  ')}\n`);
    }
    const tasks = [];
    if (webhook) tasks.push(sendWebhook(webhook, event).catch((e) => logger?.warn(`webhook failed: ${e.message}`)));
    if (telegram?.token && telegram?.chatId && hot.length) tasks.push(sendTelegram(telegram, { ...event, items: hot }).catch((e) => logger?.warn(`telegram failed: ${e.message}`)));
    if (mac) {
      const first = items[0];
      tasks.push(sendMacNotification(`Vinted ${EVENT_TITLES[type] ?? type}: ${search}`, `${items.length} item(s) · ${formatPrice(first)} · ${first.title}`));
    }
    await Promise.all(tasks);
  };
}
