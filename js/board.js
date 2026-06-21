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

  function init(container, options) {
    el = container;
    opts = options;
    el.addEventListener('pointerdown', onPointerDown);
    // move/up on window so a drag that leaves the board still completes
    global.addEventListener('pointermove', onPointerMove);
    global.addEventListener('pointerup', onPointerUp);
  }

  function setOrientation(o) { orientation = o; render(); }
  function getOrientation() { return orientation; }
  function flip() { setOrientation(orientation === 'w' ? 'b' : 'w'); }
  function setLastMove(m) { lastMove = m; }
  function setHint(m) { hintMove = m; render(); }
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

  function render() {
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
        inner = '<span class="pc pc-' + p.color + ' type-' + p.type +
          '" style="background-image:url(\'' + pieceUrl(p.color, p.type) + '\')"></span>';
      }
      // coordinate labels on edge squares
      var coords = '';
      if (s.rowFirst) coords += '<span class="coord rank">' + s.rank + '</span>';
      if (s.colLast) coords += '<span class="coord file">' + s.file + '</span>';

      html += '<div class="' + cls + '" data-square="' + s.square + '">' + inner + coords + '</div>';
    });
    el.innerHTML = html;
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
      if (dx * dx + dy * dy > 36) dragging = true;
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
    // restore any hidden piece
    var hidden = el.querySelectorAll('.pc[style*="hidden"]');
    for (var i = 0; i < hidden.length; i++) hidden[i].style.visibility = '';
  }

  global.Board = {
    init: init,
    render: render,
    setOrientation: setOrientation,
    getOrientation: getOrientation,
    flip: flip,
    setLastMove: setLastMove,
    setHint: setHint,
    clearSelection: function () { clearSelection(); render(); }
  };
})(window);
