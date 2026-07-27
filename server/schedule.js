// Minimal daily scheduler: runs `fn` once at HH:MM (server local time) every
// day. Deliberately not a cron library — the one we tried (node-cron) uses
// import.meta.url at module load time, which breaks when bundled into a
// single .exe for pkg, and we only ever need "once a day at a fixed time".
export function scheduleDaily(timeStr, fn) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((timeStr || "").trim());
  const [hh, mm] = match ? [Number(match[1]), Number(match[2])] : [8, 0];

  function msUntilNext() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function tick() {
    fn();
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }

  setTimeout(tick, msUntilNext());
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
