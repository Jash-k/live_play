/**
 * Small HTTP helpers shared by the curator.
 * Every request is timeout-bounded and retried once so a flaky upstream
 * cannot stall the whole refresh.
 */
const UA = 'jash-live-curator/2 (+https://github.com/Jash-k/live_play)';

export async function fetchText(url, { timeoutMs = 20000, retries = 1, headers = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': UA, 'Accept': '*/*', ...headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Run `worker` over `items` with a fixed concurrency ceiling, preserving order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
