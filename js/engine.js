/*
 * engine.js
 * Stockfish (single-threaded asm.js build) wrapped in a Web Worker, with a
 * serial job queue. The same worker serves both the weakened opponent
 * (getBestMove) and full-strength analysis (analyze) — jobs run one at a time.
 *
 * Stockfish is vendored locally (vendor/stockfish.js + vendor/stockfish.wasm,
 * a single-threaded WASM build) and loaded as a same-origin Web Worker, so it
 * works from GitHub Pages / any static host without SharedArrayBuffer or
 * special COOP/COEP headers.
 */
(function (global) {
  'use strict';

  var STOCKFISH_URL = 'vendor/stockfish.js';

  var worker = null;
  var ready = false;
  var initError = null;
  var queue = [];
  var active = null;
  var onReadyCbs = [];

  function post(cmd) { if (worker) worker.postMessage(cmd); }

  function init() {
    if (worker || initError) return;
    try {
      worker = new Worker(STOCKFISH_URL);
      worker.onmessage = onMessage;
      worker.onerror = function (e) {
        initError = e.message || 'Engine failed to load';
        console.error('Stockfish worker error:', e);
      };
      post('uci');
    } catch (e) {
      initError = e.message || String(e);
      console.error('Engine init failed:', e);
    }
  }

  function onMessage(e) {
    var line = (typeof e.data === 'string') ? e.data : (e.data && e.data.line) || '';
    if (!line) return;

    if (line === 'uciok') {
      post('isready');
      return;
    }
    if (line === 'readyok') {
      if (!ready) {
        ready = true;
        onReadyCbs.forEach(function (cb) { cb(); });
        onReadyCbs = [];
        pump();
      } else {
        pump();
      }
      return;
    }

    if (!active) return;

    if (line.indexOf('info') === 0 && line.indexOf(' pv ') !== -1) {
      var mpvMatch = line.match(/multipv (\d+)/);
      var idx = mpvMatch ? parseInt(mpvMatch[1], 10) : 1;
      var scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
      var pvMatch = line.match(/ pv (.+)$/);
      if (scoreMatch) {
        active.multi[idx] = {
          type: scoreMatch[1],
          value: parseInt(scoreMatch[2], 10),
          pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : []
        };
      }
    } else if (line.indexOf('bestmove') === 0) {
      var parts = line.split(/\s+/);
      var best = parts[1];
      var job = active;
      active = null;
      var result = {
        bestmove: (best && best !== '(none)') ? best : null,
        info: job.multi[1] || null,
        multi: job.multi
      };
      job.resolve(result);
      pump();
    }
  }

  function pump() {
    if (!ready || active || queue.length === 0) return;
    active = queue.shift();
    active.multi = {};
    var opts = active.options || {};
    for (var k in opts) {
      if (Object.prototype.hasOwnProperty.call(opts, k)) {
        post('setoption name ' + k + ' value ' + opts[k]);
      }
    }
    post('position fen ' + active.fen);
    post('go ' + active.go);
  }

  function enqueue(spec) {
    return new Promise(function (resolve, reject) {
      if (initError) { reject(new Error(initError)); return; }
      queue.push({
        fen: spec.fen,
        options: spec.options || {},
        go: spec.go || 'depth 12',
        resolve: resolve
      });
      if (!worker) init();
      pump();
    });
  }

  // Weakened opponent move.
  function getBestMove(fen, config) {
    return enqueue({
      fen: fen,
      options: config.options,
      go: config.go
    });
  }

  // Full-strength analysis (eval bar, hints, review). Independent of opponent.
  function analyze(fen, opts) {
    opts = opts || {};
    var options = { 'UCI_LimitStrength': 'false', 'Skill Level': 20, 'MultiPV': opts.multipv || 1 };
    return enqueue({
      fen: fen,
      options: options,
      go: opts.go || ('depth ' + (opts.depth || 12))
    });
  }

  function whenReady(cb) {
    if (ready) cb();
    else { onReadyCbs.push(cb); init(); }
  }

  global.Engine = {
    init: init,
    getBestMove: getBestMove,
    analyze: analyze,
    whenReady: whenReady,
    isReady: function () { return ready; },
    error: function () { return initError; }
  };
})(window);
