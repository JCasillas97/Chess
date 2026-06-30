/*
 * board.js
 * Renders a chess position and handles tap-to-move + pointer drag input.
 * Decoupled from rules via callbacks supplied in init(opts). Promotion is
 * resolved by game.js after onMove fires.
 */
(function (global) {
  'use strict';

  // Pieces are rendered as cburnett SVG images (solid, filled, identical on
  // every device) rather than Unicode glyphs, which iOS draws hollow/all-dark.
  var PIECE_DIR = 'assets/pieces/';
  function pieceUrl(color, type) { return PIECE_DIR + color + type.toUpperCase() + '.svg'; }
  var FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  var el, opts;
  var orientation = 'w';
  var selected = null;
  var legalCache = [];       // [{to, capture}]
  var lastMove = null;       // {from, to}
  var hintMove = null;       // {from, to}
  var dragEl = null, dragging = false, dragStart = null, downXY = null;
  var dragHiddenEl = null;   // the piece element hidden while dragging
  var suppressAnim = false;  // skip the slide animation for the next render (drag drops)
  var animating = {};        // squares whose piece is mid-slide (kept hidden across re-renders)
  var ANIM_MS = 320;         // piece slide duration

  function init(container, options) {
    el = container;
    opts = options;
    el.addEventListener('pointerdown', onPointerDown);
    // move/up on window so a drag that leaves the board still completes
    global.addEventListener('pointermove', onPointerMove);
    global.addEventListener('pointerup', onPointerUp);
  }

  // Swap the active controller (play vs puzzle) without re-binding listeners.
  function setOpts(o) { opts = o; selected = null; legalCache = []; hintMove = null; lastMove = null; }
  function setOrientation(o) { orientation = o; render(); }
  function getOrientation() { return orientation; }
  function flip() { setOrientation(orientation === 'w' ? 'b' : 'w'); }
  function setLastMove(m) { lastMove = m; }
  function setHint(m, skipRender) { hintMove = m; if (!skipRender) render(); }
  function clearSelection() { selected = null; legalCache = []; }

  function orderedSquares() {
    var ranks = [8, 7, 6, 5, 4, 3, 2, 1];
    var files = FILES.slice();
    if (orientation === 'b') { ranks.reverse(); files.reverse(); }
    var sqs = [];
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        sqs.push({ square: files[f] + ranks[r], file: files[f], rank: ranks[r], rowFirst: f === 0, colLast: r === 7 });
      }
    }
    return sqs;
  }

  // On-screen grid position (col,row) of a square, honoring orientation.
  function squareScreen(square) {
    var f = FILES.indexOf(square[0]);
    var rank = parseInt(square[1], 10);
    return (orientation === 'w')
      ? { col: f, row: 8 - rank }
      : { col: 7 - f, row: rank - 1 };
  }

  // Slide a floating clone from spec.from to spec.to, like the drag ghost. This
  // is robust against board re-renders (the clone lives on document.body), so
  // every move animates consistently — unlike transforming the rebuilt element,
  // which iOS Safari intermittently skips.
  function animateMove(spec) {
    if (!spec || !spec.from || !spec.to || spec.from === spec.to) return;
    var pcEl = el.querySelector('[data-square="' + spec.to + '"] .pc');
    if (!pcEl) return;
    var rect = el.getBoundingClientRect();
    var size = rect.width / 8;
    if (!size) return;
    var a = squareScreen(spec.from), b = squareScreen(spec.to);

    var pad = size * 0.03;     // pieces render at ~94% of the square, centered
    var pSize = size * 0.94;
    var clone = pcEl.cloneNode(true);
    clone.className += ' anim-ghost';
    clone.style.position = 'fixed';
    clone.style.pointerEvents = 'none';
    clone.style.zIndex = '900';
    clone.style.margin = '0';
    clone.style.width = pSize + 'px';
    clone.style.height = pSize + 'px';
    clone.style.left = (rect.left + a.col * size + pad) + 'px';
    clone.style.top = (rect.top + a.row * size + pad) + 'px';
    clone.style.transition = 'none';
    clone.style.transform = 'translate(0,0)';
    document.body.appendChild(clone);

    // hide the real destination piece (kept hidden across re-renders) until the
    // ghost arrives
    animating[spec.to] = true;
    pcEl.style.visibility = 'hidden';

    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      delete animating[spec.to];
      var real = el.querySelector('[data-square="' + spec.to + '"] .pc');
      if (real) real.style.visibility = '';
    };

    var raf = global.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () {
      raf(function () {
        clone.style.transition = 'transform ' + ANIM_MS + 'ms cubic-bezier(.22,.61,.36,1)';
        clone.style.transform = 'translate(' + ((b.col - a.col) * size) + 'px,' +
          ((b.row - a.row) * size) + 'px)';
      });
    });
    clone.addEventListener('transitionend', finish);
    setTimeout(finish, ANIM_MS + 140); // fallback if transitionend doesn't fire
  }

  function render(animateSpec) {
    if (!el) return;
    var board = opts.getBoard();         // chess.js board() : 8x8, rank8 first
    var checkSq = opts.inCheckSquare ? opts.inCheckSquare() : null;
    var pieceAt = {};
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var cell = board[r][c];
        // chess.js 0.10.x board() cells are {type,color} with no .square,
        // so derive the square: row 0 = rank 8, col 0 = file a.
        if (cell) pieceAt[FILES[c] + (8 - r)] = cell;
      }
    }

    var html = '';
    orderedSquares().forEach(function (s) {
      var fileIdx = FILES.indexOf(s.file);
      var dark = (fileIdx + s.rank) % 2 === 0;
      var cls = 'sq ' + (dark ? 'dark' : 'light');
      if (selected === s.square) cls += ' sel';
      if (lastMove && (lastMove.from === s.square || lastMove.to === s.square)) cls += ' last';
      if (hintMove && (hintMove.from === s.square || hintMove.to === s.square)) cls += ' hint';
      if (checkSq === s.square) cls += ' check';

      var legal = legalFor(s.square);
      if (legal) cls += legal.capture ? ' target-cap' : ' target';

      var p = pieceAt[s.square];
      var inner = '';
      if (p) {
        // keep a piece hidden while its arrival is still being animated
        var hide = animating[s.square] ? 'visibility:hidden;' : '';
        inner = '<span class="pc pc-' + p.color + ' type-' + p.type +
          '" style="' + hide + 'background-image:url(\'' + pieceUrl(p.color, p.type) + '\')"></span>';
      }
      // coordinate labels on edge squares
      var coords = '';
      if (s.rowFirst) coords += '<span class="coord rank">' + s.rank + '</span>';
      if (s.colLast) coords += '<span class="coord file">' + s.file + '</span>';

      html += '<div class="' + cls + '" data-square="' + s.square + '">' + inner + coords + '</div>';
    });
    el.innerHTML = html;
    if (animateSpec && !suppressAnim) animateMove(animateSpec);
    suppressAnim = false;
  }

  function legalFor(square) {
    for (var i = 0; i < legalCache.length; i++) {
      if (legalCache[i].to === square) return legalCache[i];
    }
    return null;
  }

  function squareFromPoint(x, y) {
    var node = document.elementFromPoint(x, y);
    while (node && node !== el) {
      if (node.dataset && node.dataset.square) return node.dataset.square;
      node = node.parentNode;
    }
    return null;
  }

  function selectSquare(square) {
    selected = square;
    legalCache = Settings.get('legalDots') ? (opts.legalTargets(square) || []) : (opts.legalTargets(square) || []);
    hintMove = null;
    render();
  }

  function attempt(from, to) {
    clearSelection();
    hintMove = null;
    opts.onMove(from, to);
  }

  function onPointerDown(e) {
    if (!opts.isInteractive()) return;
    var sq = squareFromPoint(e.clientX, e.clientY);
    if (!sq) return;
    var piece = opts.pieceColorAt(sq); // 'w' | 'b' | null

    if (selected && selected !== sq && legalFor(sq)) {
      attempt(selected, sq);
      return;
    }
    if (piece && piece === opts.getPlayerColor() && piece === opts.getTurn()) {
      selectSquare(sq);
      dragStart = sq;
      downXY = { x: e.clientX, y: e.clientY };
      startDrag(sq, e);
    } else if (selected) {
      // clicked elsewhere; deselect
      clearSelection();
      render();
    }
  }

  function startDrag(sq, e) {
    var cell = el.querySelector('[data-square="' + sq + '"] .pc');
    if (!cell) return;
    dragEl = cell.cloneNode(true);
    dragEl.className += ' dragging';
    dragEl.style.position = 'fixed';
    dragEl.style.pointerEvents = 'none';
    dragEl.style.zIndex = '1000';
    document.body.appendChild(dragEl);
    positionDrag(e.clientX, e.clientY);
    cell.style.visibility = 'hidden';
    dragHiddenEl = cell;
  }

  function positionDrag(x, y) {
    if (!dragEl) return;
    var size = el.clientWidth / 8;
    dragEl.style.width = size + 'px';
    dragEl.style.height = size + 'px';
    dragEl.style.fontSize = (size * 0.78) + 'px';
    dragEl.style.lineHeight = size + 'px';
    dragEl.style.textAlign = 'center';
    dragEl.style.left = (x - size / 2) + 'px';
    dragEl.style.top = (y - size / 2) + 'px';
  }

  function onPointerMove(e) {
    if (!dragStart) return;
    if (!dragging && downXY) {
      var dx = e.clientX - downXY.x, dy = e.clientY - downXY.y;
      // ~11px threshold so a normal tap that wiggles is still a tap (and animates)
      if (dx * dx + dy * dy > 121) dragging = true;
    }
    if (dragging) { positionDrag(e.clientX, e.clientY); e.preventDefault(); }
  }

  function onPointerUp(e) {
    if (!dragStart) return;
    var from = dragStart;
    var wasDragging = dragging;
    cleanupDrag();
    if (wasDragging) {
      var to = squareFromPoint(e.clientX, e.clientY);
      if (to && to !== from && legalFor(to)) {
        suppressAnim = true; // user already dragged the piece there; don't slide it again
        attempt(from, to);
      } else {
        render(); // snap back, keep selection (dots still shown)
      }
    }
    // if it was a tap (not drag), selection stays so a second tap completes
  }

  function cleanupDrag() {
    if (dragEl && dragEl.parentNode) dragEl.parentNode.removeChild(dragEl);
    dragEl = null;
    dragging = false;
    dragStart = null;
    downXY = null;
    // restore exactly the piece we hid for the drag (don't touch animating pieces)
    if (dragHiddenEl) { dragHiddenEl.style.visibility = ''; dragHiddenEl = null; }
  }

  global.Board = {
    init: init,
    setOpts: setOpts,
    render: render,
    ANIM_MS: ANIM_MS,
    setOrientation: setOrientation,
    getOrientation: getOrientation,
    flip: flip,
    setLastMove: setLastMove,
    setHint: setHint,
    clearSelection: function () { clearSelection(); render(); }
  };
})(window);
