/* Thin, reusable Chart.js wrappers shared by every view with charts.
   Handles destroying the previous instance on a canvas before re-rendering
   (views re-render on nav / filter change), matching the reference
   dashboard's approach. */
window.App = window.App || {};

App.charts = (function () {
  const instances = {};
  const PALETTE = ['#c9a84c', '#16c9a3', '#4c9be8', '#ff6b6b', '#a06bcf', '#e8c96a', '#8496ac'];

  Chart.defaults.color = '#8496ac';
  Chart.defaults.font.family = "'DM Sans',sans-serif";
  Chart.defaults.font.size = 11;

  function destroy(canvasId) {
    if (instances[canvasId]) { instances[canvasId].destroy(); delete instances[canvasId]; }
  }

  function ctx(canvasId) {
    const c = document.getElementById(canvasId);
    return c ? c.getContext('2d') : null;
  }

  function moneyTick(v) { return '₹' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v); }

  function line(canvasId, labels, datasets, opts) {
    destroy(canvasId);
    const c = ctx(canvasId);
    if (!c || !labels.length) return;
    instances[canvasId] = new Chart(c, {
      type: 'line',
      data: { labels, datasets: datasets.map((d, i) => Object.assign({
        borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length] + '22',
        fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2,
      }, d)) },
      options: Object.assign({
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { boxWidth: 10 } } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: moneyTick } },
        },
      }, opts || {}),
    });
  }

  function bar(canvasId, labels, datasets, opts) {
    destroy(canvasId);
    const c = ctx(canvasId);
    if (!c) return;
    instances[canvasId] = new Chart(c, {
      type: 'bar',
      data: { labels, datasets: datasets.map((d, i) => Object.assign({
        backgroundColor: PALETTE[i % PALETTE.length], borderRadius: 4, maxBarThickness: 34,
      }, d)) },
      options: Object.assign({
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: datasets.length > 1, position: 'top', labels: { boxWidth: 10 } } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: moneyTick } },
        },
      }, opts || {}),
    });
  }

  function horizontalBar(canvasId, labels, datasets, opts) {
    bar(canvasId, labels, datasets, Object.assign({
      indexAxis: 'y',
      scales: { x: { stacked: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: moneyTick } }, y: { stacked: true, grid: { display: false } } },
    }, opts || {}));
  }

  function doughnut(canvasId, labels, data, opts) {
    destroy(canvasId);
    const c = ctx(canvasId);
    if (!c || !labels.length) return;
    instances[canvasId] = new Chart(c, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: PALETTE, borderColor: '#0c1628', borderWidth: 2 }] },
      options: Object.assign({
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
      }, opts || {}),
    });
  }

  function bubble(canvasId, datasets, opts) {
    destroy(canvasId);
    const c = ctx(canvasId);
    if (!c) return;
    instances[canvasId] = new Chart(c, {
      type: 'bubble',
      data: { datasets: datasets.map((d, i) => Object.assign({ backgroundColor: PALETTE[i % PALETTE.length] + 'aa', borderColor: PALETTE[i % PALETTE.length] }, d)) },
      options: Object.assign({
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { boxWidth: 10 } } },
        scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' } }, y: { grid: { color: 'rgba(255,255,255,0.04)' } } },
      }, opts || {}),
    });
  }

  return { line, bar, horizontalBar, doughnut, bubble, destroy, PALETTE };
})();
