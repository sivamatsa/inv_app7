/* Shared formatting/parsing helpers, plain global namespace (no bundler, no
   ES modules) so this keeps working when the file is opened directly. */
window.App = window.App || {};

App.utils = (function () {
  const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[code] || (code ? code + ' ' : '₹');
  }

  function fmtMoney(n, currency) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const sym = currencySymbol(currency || (App.state && App.state.profile && App.state.profile.preferred_currency));
    return sym + Math.round(Number(n)).toLocaleString('en-IN');
  }

  function fmtNum(n, dec) {
    if (dec === undefined) dec = 1;
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-IN', { maximumFractionDigits: dec });
  }

  function fmtPct(n, dec) {
    if (dec === undefined) dec = 2;
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toFixed(dec) + '%';
  }

  function fmtDate(d) {
    if (!d) return '—';
    const dt = (d instanceof Date) ? d : parseDate(d);
    if (!dt) return '—';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return dt.getDate() + ' ' + months[dt.getMonth()] + ' ' + dt.getFullYear();
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt)) return '—';
    return fmtDate(dt) + ', ' + dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  function toISO(d) {
    if (!d) return null;
    const dt = (d instanceof Date) ? d : parseDate(d);
    if (!dt) return null;
    const y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, '0'), day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function today0() {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }

  function todayISO() {
    return toISO(today0());
  }

  function daysBetween(a, b) {
    const DAY = 86400000;
    const da = (a instanceof Date) ? a : parseDate(a);
    const db = (b instanceof Date) ? b : parseDate(b);
    if (!da || !db) return null;
    return Math.round((db - da) / DAY);
  }

  function parseNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    const n = parseFloat(String(v).replace(/[,₹\s]/g, ''));
    return isNaN(n) ? null : n;
  }

  function excelSerialToDate(n) {
    if (!window.XLSX || !XLSX.SSF) return null;
    // Round to the nearest whole day first: an Excel date serial that's
    // supposed to be an exact day (no time-of-day) can come back with a
    // tiny floating-point fraction after a read/write round-trip (e.g.
    // 45981.9999999 instead of 45982), which parse_date_code would floor
    // into the wrong (previous) day. None of this app's imported date
    // fields carry a meaningful time-of-day, so rounding away that
    // fraction is always correct here.
    const d = XLSX.SSF.parse_date_code(Math.round(n));
    return d ? new Date(d.y, d.m - 1, d.d) : null;
  }

  // Same rounding fix as excelSerialToDate, for the case where xlsx.js's
  // own cellDates:true option already converted the cell to a Date object
  // before we see it - that Date can carry the identical fractional-day
  // rounding error (observed as e.g. "Tue May 20 23:59:59" for an intended
  // May 21), which naively reading getFullYear/getMonth/getDate would
  // report as the day before the one actually in the spreadsheet.
  function normalizeDateOnly(v) {
    const rounded = new Date(Math.round(v.getTime() / 86400000) * 86400000);
    return new Date(rounded.getUTCFullYear(), rounded.getUTCMonth(), rounded.getUTCDate());
  }

  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : normalizeDateOnly(v);
    if (typeof v === 'number') {
      const d = excelSerialToDate(v);
      if (d) return d;
    }
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    const d2 = new Date(s);
    return isNaN(d2) ? null : new Date(d2.getFullYear(), d2.getMonth(), d2.getDate());
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function toast(msg, type) {
    const w = document.getElementById('toastWrap');
    if (!w) return;
    const t = document.createElement('div');
    t.className = 'toast ' + (type === 'err' ? 'err' : type === 'info' ? '' : 'ok');
    t.textContent = msg;
    w.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 3800);
  }

  function statusBadgeClass(status) {
    return 'st-' + String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // Generic date-range summer - originally dashboard.js's own Cash Flow
  // panel local helper, lifted here so cashFlow.js can share the exact same
  // primitive rather than a second, potentially drifting copy.
  function sumWhere(rows, dateKey, amtKey, from, to) {
    return rows.filter((r) => r[dateKey] >= from && r[dateKey] <= to).reduce((acc, r) => acc + (r[amtKey] || 0), 0);
  }

  // Current/previous financial-year boundaries from the user's own
  // financial_year_start_month/_day profile setting (default April 1) -
  // originally dashboard.js's own local helper, same lift-and-share reason.
  function fyBounds(profile, which) {
    const startMonth = (profile && profile.financial_year_start_month) || 4;
    const startDay = (profile && profile.financial_year_start_day) || 1;
    const now = new Date();
    let fyStartYear = now.getFullYear();
    const fyStartThisYear = new Date(fyStartYear, startMonth - 1, startDay);
    if (now < fyStartThisYear) fyStartYear--;
    if (which === 'previous') fyStartYear--;
    const start = new Date(fyStartYear, startMonth - 1, startDay);
    const end = new Date(fyStartYear + 1, startMonth - 1, startDay - 1);
    return { start: toISO(start), end: toISO(end) };
  }

  return {
    currencySymbol, fmtMoney, fmtNum, fmtPct, fmtDate, fmtDateTime, toISO, today0, todayISO,
    daysBetween, parseNum, parseDate, escapeHtml, debounce, toast, statusBadgeClass, qs, qsa, el,
    sumWhere, fyBounds,
  };
})();
