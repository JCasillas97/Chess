/*
 * settings.js
 * Toggleable feature flags + board theme, persisted to localStorage.
 */
(function (global) {
  'use strict';

  var KEY = 'chessPracticeSettings.v1';

  var DEFAULTS = {
    hints: true,
    evalBar: true,
    takebacks: true,
    blunderWarning: true,
    sounds: true,
    legalDots: true,
    theme: 'green',   // green | brown | blue | gray
    dark: false
  };

  var state = load();

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      var s = raw ? JSON.parse(raw) : {};
      var merged = {};
      for (var k in DEFAULTS) merged[k] = (k in s) ? s[k] : DEFAULTS[k];
      return merged;
    } catch (e) {
      var d = {};
      for (var j in DEFAULTS) d[j] = DEFAULTS[j];
      return d;
    }
  }

  function save() {
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function get(key) { return state[key]; }

  function set(key, value) {
    state[key] = value;
    save();
    if (listeners[key]) listeners[key].forEach(function (cb) { cb(value); });
  }

  var listeners = {};
  function on(key, cb) {
    (listeners[key] || (listeners[key] = [])).push(cb);
  }

  global.Settings = { get: get, set: set, on: on, all: function () { return state; }, DEFAULTS: DEFAULTS };
})(window);
