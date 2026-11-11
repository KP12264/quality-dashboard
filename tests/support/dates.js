// Test dates relative to "today" in Asia/Bangkok (UTC+7, no daylight saving), so tests never go stale.
// Leaders may write only dates inside the 7-day window (QD_LEADER_EDIT_WINDOW_DAYS, rules qdInWindow):
// use daysAgo(1..6) for writes that must be allowed, daysAgo(10) or more for writes that must be refused
// because of the window. `now` (ms) is optional, for tests of these helpers.
const DAY_MS = 86400000;
const BKK_MS = 7 * 3600000;
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const thaiToday = (now = Date.now()) => ymd(now + BKK_MS);
const daysAgo = (n, now = Date.now()) => ymd(now + BKK_MS - n * DAY_MS);
const daysAhead = (n, now = Date.now()) => daysAgo(-n, now);
// Same test as the rules' qdInWindow for a leader: Thailand-now < start of `date` + (window + 1) days.
const inLeaderWindow = (date, windowDays = 7, now = Date.now()) => now + BKK_MS < Date.parse(date + 'T00:00:00Z') + (windowDays + 1) * DAY_MS;
module.exports = { DAY_MS, thaiToday, daysAgo, daysAhead, inLeaderWindow };
