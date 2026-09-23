/**
 * Preflight: say what is wrong when the browser cannot run the app.
 *
 * The app itself is one ES module that creates its WebGL renderer in its first
 * few statements. When a module fails to load — an old browser, a stale cached
 * file, the page opened from disk — or the renderer cannot be created, the
 * module stops before a single button is wired up, and the page just goes
 * dead. Error handling inside that module dies with it. So the checks live
 * here instead: a classic script, loaded first, that needs nothing the app
 * might be missing.
 *
 * Deliberately old-fashioned JavaScript — var, function, no arrows, no ?. —
 * so it parses and runs on browsers far too old for the app, which are
 * exactly the ones it has to talk to. Classic scripts also load over file://,
 * which module scripts do not; that is what lets it report being opened from
 * disk at all.
 *
 * Problems are shown under the file browser, never as pop-ups, as one line
 * of plain coloured text each — the headline and a link to Browser check,
 * like the app's other errors. Red when the app cannot do its job, orange
 * when one feature is lost. The full explanation and what to try are in the
 * Browser check panel, which is also the only place anything minor appears
 * (altered pixels, no MSAA, no anisotropic filtering, textures shrunk to
 * fit). It is the one thing here that opens over the page, and only when
 * asked for.
 *
 * Everything user-facing is built with textContent, never innerHTML, because
 * error messages and file names end up in it.
 */
(function (window) {
  'use strict';

  var document = window.document;

  /*
   * What each problem is called, why it matters and one thing to try.
   * F = fatal (the app cannot do its job), W = a warning (it can, worse).
   */
  var MESSAGES = {
    F1: {
      title: 'This page has to be opened through a web server.',
      why: 'Browsers will not load the app’s scripts from a file on disk, so nothing on the page can work.',
      tryText: 'In the app’s folder run “python3 serve.py”, then open http://localhost:8000.',
    },
    F2: {
      title: 'This browser is too old to run the app.',
      why: 'The app is built from modern script files that the browser has to understand (“import maps”).',
      tryText: 'Update the browser: Firefox 108 or later; Chrome, Brave or Edge 89 or later; Safari 16.4 or later.',
    },
    F3a: {
      title: '3D graphics are turned off in this browser.',
      why: 'The model is drawn by your graphics card through WebGL, and the browser is not letting this page use it. Browsers also switch it off by themselves after the graphics card crashes a few times.',
      tryText: 'Restart the browser. If that does not help, turn on “Use graphics acceleration when available” (Chrome, Brave, Edge), or check that webgl.disabled is false in about:config (Firefox).',
    },
    F3b: {
      title: 'This browser only offers the older WebGL 1.',
      why: 'The app’s 3D library needs WebGL 2, which this browser or graphics card does not provide.',
      tryText: 'Update the browser and your graphics drivers.',
    },
    F4: {
      title: 'This browser cannot assemble image frames.',
      why: 'Every exported frame is put together on a hidden drawing surface (OffscreenCanvas), which this browser does not support.',
      tryText: 'Update the browser.',
    },
    F5: {
      title: 'This browser cannot decode images for saving.',
      why: 'Saving and background pictures need createImageBitmap, which this browser does not support.',
      tryText: 'Update the browser.',
    },
    F6: {
      title: 'This browser will not let the page read its own images.',
      why: 'Every exported frame is read back pixel by pixel to build the file, and a privacy setting or extension is blocking that, so nothing could be saved.',
      tryText: 'Allow this site in the browser’s fingerprinting or privacy protection, or in the extension that blocks canvas reading.',
    },
    F7: {
      title: 'The app did not start.',
      why: 'Something went wrong while it was loading. The usual cause is the browser mixing old cached files with new ones after an update.',
      tryText: 'Press Ctrl+Shift+R (Cmd+Shift+R on a Mac) to reload without the cache. If it keeps happening, Browser check shows what failed.',
    },
    W1: {
      title: '3D is running without your graphics card.',
      why: 'It works, but loading and rendering will be very slow.',
      tryText: 'Turn on hardware acceleration in the browser’s settings and restart it.',
    },
    W2: {
      title: 'Your browser is altering image pixels.',
      why: 'A privacy protection adds faint noise when the page reads its own images, so exports may not match the preview exactly.',
      tryText: 'Allow this site in the browser’s fingerprinting protection (in Brave: Shields).',
    },
    // Raised by main.js, which is where these are found out.
    W3: {
      title: 'Environment lighting is unavailable.',
      why: 'This graphics card cannot render it (it needs half-float rendering), so Environment is set to None.',
      tryText: 'Everything else works; metal surfaces will look darker.',
      note: true,   // tryText is a remark here, not something to try
    },
    W4: {
      title: 'Saving WebP is unavailable.',
      why: 'This browser cannot make WebP images.',
      tryText: 'GIF, APNG and ZIP work normally.',
      note: true,
    },
    R1: {
      title: 'The graphics card stopped responding.',
      why: 'This usually means the model was too large for graphics memory, or the graphics driver reset. Frames already rendered can still be saved.',
      tryText: 'Reload the page.',
    },
    R3: {
      title: 'Something went wrong.',
      why: 'An error happened that the app did not expect. The exact messages are in the details below.',
      tryText: 'If something stopped working, reload the page.',
    },
  };

  function isFatal(id) { return id.charAt(0) === 'F' || id === 'R1'; }

  /*
   * How loudly each problem is reported. Red and orange get a line under the
   * file browser; minor ones appear only in the Browser check panel.
   */
  function levelOf(id) {
    if (isFatal(id)) return 'red';
    return id === 'W2' ? 'minor' : 'orange';
  }

  /**
   * Browser facts in, problem ids out. Pure, so the tests can run it.
   *
   * `importMaps` is true, false or null — null when the browser cannot say,
   * as Chrome 89–95 could not despite supporting them. Unknown is not a
   * failure: if the modules really cannot load, the start-up watchdog will
   * catch it with the real error in hand.
   */
  function checks(f) {
    var out = [];
    if (f.protocol === 'file:') out.push('F1');
    if (f.importMaps === false) out.push('F2');
    if (!f.webgl2) out.push(f.webgl1 ? 'F3b' : 'F3a');
    if (!f.offscreen2d) out.push('F4');
    if (!f.imageBitmap) out.push('F5');
    if (f.readback === 'blocked') out.push('F6');
    if (f.webgl2 && f.software) out.push('W1');
    if (f.readback === 'altered') out.push('W2');
    return out;
  }

  /* ----------------------------------------------------------- probes */

  function probeWebGL() {
    var result = { webgl2: false, webgl1: false, software: null, gpu: '', reason: '' };
    var release = function (gl) {
      try {
        var lose = gl && gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) { /* nothing to release */ }
    };
    var attempt = function (kind, attributes) {
      var canvas = document.createElement('canvas');
      // The browser's own reason, when it gives one ("blocklisted", "too
      // many crashes") — worth more in a bug report than anything guessed.
      canvas.addEventListener('webglcontextcreationerror', function (e) {
        if (e && e.statusMessage && !result.reason) result.reason = e.statusMessage;
      }, false);
      try { return canvas.getContext(kind, attributes); } catch (e) { return null; }
    };

    var gl = attempt('webgl2');
    if (gl) {
      result.webgl2 = true;
      try {
        var info = gl.getExtension('WEBGL_debug_renderer_info');
        result.gpu = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
      } catch (e) { /* some browsers hide it; that is fine */ }
      release(gl);
      // Asking the browser to refuse a slow context is the one reliable way
      // to learn that it would have been a software one.
      var fast = attempt('webgl2', { failIfMajorPerformanceCaveat: true });
      result.software = !fast;
      release(fast);
    } else {
      var old = attempt('webgl');
      result.webgl1 = !!old;
      release(old);
    }
    return result;
  }

  /**
   * Draw an exact pattern, read it back, compare.
   *
   * 'ok' when it comes back untouched; 'altered' for the faint noise some
   * anti-fingerprinting adds; 'blocked' when reading throws or comes back as
   * something else entirely (a blank or randomised image), which would make
   * every export useless.
   */
  function probeReadback() {
    try {
      var canvas = typeof window.OffscreenCanvas === 'function'
        ? new window.OffscreenCanvas(4, 4)
        : document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      var ctx = canvas.getContext('2d');
      if (!ctx) return 'blocked';
      var expected = [];
      for (var i = 0; i < 16; i++) {
        var rgb = [(i * 16 + 3) % 256, (255 - i * 13) % 256, (i * 37 + 11) % 256];
        ctx.fillStyle = 'rgb(' + rgb.join(',') + ')';
        ctx.fillRect(i % 4, Math.floor(i / 4), 1, 1);
        expected.push(rgb[0], rgb[1], rgb[2], 255);
      }
      var data = ctx.getImageData(0, 0, 4, 4).data;
      var total = 0;
      for (var j = 0; j < expected.length; j++) total += Math.abs(data[j] - expected[j]);
      if (total === 0) return 'ok';
      return total / expected.length > 16 ? 'blocked' : 'altered';
    } catch (e) {
      return 'blocked';
    }
  }

  function probeImportMaps() {
    var S = window.HTMLScriptElement;
    if (!S || typeof S.supports !== 'function') return null;
    try { return !!S.supports('importmap'); } catch (e) { return null; }
  }

  function probeOffscreen2d() {
    try {
      return typeof window.OffscreenCanvas === 'function'
        && !!new window.OffscreenCanvas(1, 1).getContext('2d');
    } catch (e) {
      return false;
    }
  }

  function gatherFacts() {
    var gl = probeWebGL();
    return {
      protocol: window.location ? window.location.protocol : '',
      importMaps: probeImportMaps(),
      webgl2: gl.webgl2,
      webgl1: gl.webgl1,
      software: gl.software,
      gpu: gl.gpu,
      webglReason: gl.reason,
      offscreen2d: probeOffscreen2d(),
      imageBitmap: typeof window.createImageBitmap === 'function',
      readback: probeReadback(),
    };
  }

  /* ------------------------------------------------------------ state */

  var state = {
    ready: false,
    finished: false,
    errors: [],
    facts: null,
    problems: [],
    contextLost: false,
  };

  // Errors that are noise rather than news: Chrome reports a benign resize
  // loop as an error, and cancelled requests arrive as AbortError.
  function ignorable(text) {
    return /ResizeObserver loop|AbortError/.test(text);
  }

  function record(text) {
    if (!text || state.errors.length >= 20) return;
    if (state.errors.indexOf(text) < 0) state.errors.push(text);
  }

  function shortPath(url) {
    var origin = window.location ? window.location.origin : '';
    return String(url || '').replace(origin, '');
  }

  // Capture phase, so a <script> or <link> that fails to load is caught too:
  // those errors do not bubble, and a missing module file is one of them.
  window.addEventListener('error', function (e) {
    var target = e && e.target;
    if (target && target !== window && (target.src || target.href)) {
      // A module whose import is missing is reported against the module at
      // the top of the chain, and the page is never told which file it was.
      var module = target.type === 'module' ? ' or one of the files it imports' : '';
      record('Could not load ' + shortPath(target.src || target.href) + module);
      return;
    }
    var where = e && e.filename ? ' (' + shortPath(e.filename) + ':' + e.lineno + ')' : '';
    var text = ((e && e.message) || 'Unknown error') + where;
    record(text);
    if (state.ready && !ignorable(text)) unexpected();
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    var text = (reason && (reason.message || reason.name)) || String(reason);
    if (reason && reason.name === 'AbortError') return;
    record(text);
    if (state.ready && !ignorable(text)) unexpected();
  });

  /* --------------------------------------------------------------- UI */

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var key in attrs) {
      if (key === 'style') node.style.cssText = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function yes(value) {
    return value === true ? 'yes' : value === false ? 'no' : 'unknown';
  }

  function detailsText() {
    var f = state.facts || {};
    var x = api.extras || {};
    var lines = [
      'Browser: ' + (window.navigator ? window.navigator.userAgent : ''),
      'Address: ' + (window.location ? window.location.protocol + '//' + window.location.host : ''),
      'Graphics: ' + (f.gpu || 'not reported by the browser'),
      'WebGL 2: ' + yes(f.webgl2) + ' · WebGL 1: ' + yes(f.webgl2 || f.webgl1)
        + ' · hardware accelerated: ' + yes(f.software == null ? null : !f.software),
    ];
    if (f.webglReason) lines.push('WebGL reason: ' + f.webglReason);
    lines.push('Import maps: ' + yes(f.importMaps)
      + ' · OffscreenCanvas: ' + yes(f.offscreen2d)
      + ' · createImageBitmap: ' + yes(f.imageBitmap)
      + ' · pixel read-back: ' + (f.readback || 'unknown'));
    if (x.maxTextureSize) {
      lines.push('Max texture: ' + x.maxTextureSize + ' px · MSAA samples: ' + x.maxSamples
        + ' · anisotropy: ' + x.maxAnisotropy + ' · half-float render: ' + yes(x.halfFloat)
        + ' · WebP encode: ' + yes(x.webp));
    }
    lines.push('App started: ' + yes(state.ready));
    if (state.errors.length) {
      lines.push('Errors:');
      for (var i = 0; i < state.errors.length; i++) lines.push('  ' + state.errors[i]);
    }
    return lines.join('\n');
  }

  /*
   * The Browser check panel: the only thing here that opens over the page,
   * and only when someone asks for it. Styled inline so it is readable even
   * when style.css is missing or stale — which is sometimes the problem.
   */
  function showCheck() {
    var old = document.getElementById('browser-check-panel');
    if (old) old.parentNode.removeChild(old);
    if (!state.facts) state.facts = gatherFacts();

    var panel = el('div', {
      id: 'browser-check-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'browser-check-title',
      style: 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:1000;overflow:auto;padding:24px 16px;'
        + 'background:rgba(12,13,16,0.94);color:#e7e9ee;'
        + 'font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif',
    });
    var card = el('div', {
      style: 'max-width:640px;margin:0 auto;background:#1c1e24;border:1px solid #2f333c;'
        + 'border-radius:8px;padding:20px',
    });
    card.appendChild(el('h2', { id: 'browser-check-title', style: 'margin:0 0 16px;font-size:18px' },
      'Browser check'));
    if (state.problems.length) card.appendChild(problemList());
    card.appendChild(checkList());

    var details = el('details', { open: '' });
    details.appendChild(el('summary', { style: 'cursor:pointer;color:#9aa1ad' }, 'Details for a bug report'));
    details.appendChild(el('pre', {
      style: 'white-space:pre-wrap;word-break:break-word;background:#15161a;padding:10px;'
        + 'border-radius:6px;font-size:12px;margin:8px 0 0;user-select:text',
    }, detailsText()));
    card.appendChild(details);

    var close = el('button', {
      type: 'button',
      style: 'margin-top:16px;padding:6px 14px;border-radius:6px;border:1px solid #2f333c;'
        + 'background:#22252c;color:inherit;font:inherit;cursor:pointer',
    }, 'Close');
    var onKey = function (e) { if (e.key === 'Escape') dismiss(); };
    var dismiss = function () {
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      document.removeEventListener('keydown', onKey);
    };
    close.addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);
    card.appendChild(close);
    panel.appendChild(card);
    document.body.appendChild(panel);
    close.focus();
  }

  var COLOURS = { red: '#ff6b6b', orange: '#e8912d', minor: '#9aa1ad' };

  /**
   * Each problem found, in full: the headline shown under the file browser,
   * then why it matters and what to try. This is where the explanation lives,
   * so the line on the page can stay one headline long.
   */
  function problemList() {
    var list = el('ul', { style: 'list-style:none;margin:0 0 18px;padding:0' });
    for (var i = 0; i < state.problems.length; i++) {
      var id = state.problems[i];
      var m = MESSAGES[id];
      var item = el('li', { style: 'margin:0 0 12px' });
      item.appendChild(el('strong', { style: 'display:block;color:' + COLOURS[levelOf(id)] }, m.title));
      item.appendChild(el('div', { style: 'color:#c4c9d2' }, m.why));
      var tryLine = el('div', null, (m.note ? '' : 'Try: ') + m.tryText + ' ');
      if (id === 'R1' || id === 'R3') {
        tryLine.appendChild(link('Reload the page', function () { window.location.reload(); }));
      }
      item.appendChild(tryLine);
      list.appendChild(item);
    }
    return list;
  }

  /**
   * Every check, passed or not. A failed row is coloured by how much it
   * matters: red stops the app, orange loses a feature, grey is minor and is
   * shown nowhere but here.
   */
  function checkList() {
    var f = state.facts;
    var x = api.extras || {};
    var rows = [
      // Once the app is running it has proved these, whatever a probe says.
      ['Opened from a web server', state.ready || f.protocol !== 'file:', 'red'],
      ['Modern script loading (import maps)', state.ready || f.importMaps, 'red'],
      ['3D graphics (WebGL 2)', state.ready || f.webgl2, 'red'],
      ['Frame assembly (OffscreenCanvas)', f.offscreen2d, 'red'],
      ['Image decoding (createImageBitmap)', f.imageBitmap, 'red'],
      ['Reading pixels back', f.readback !== 'blocked', 'red'],
      ['App started', state.ready, 'red'],
      ['Graphics card responding', !state.contextLost, 'red'],
      ['Graphics card acceleration', f.software == null ? null : !f.software, 'orange'],
      ['Pixels read back unchanged', f.readback === 'ok', 'minor'],
      ['Environment lighting (half-float rendering)', x.halfFloat, 'orange'],
      ['Saving WebP', x.webp, 'orange'],
      ['No unexpected errors', state.errors.length === 0, 'orange'],
      ['Anti-aliased edges (MSAA)', x.maxSamples == null ? null : x.maxSamples > 0 && !!x.antialias, 'minor'],
      ['Sharp texture filtering (anisotropic)', x.maxAnisotropy == null ? null : x.maxAnisotropy > 1, 'minor'],
      ['Large textures (4096 px or more)', x.maxTextureSize ? x.maxTextureSize >= 4096 : null, 'minor'],
      ['This model’s textures fit the graphics card',
        x.oversizedTexture == null ? null : !x.oversizedTexture, 'minor'],
    ];
    var list = el('ul', { style: 'list-style:none;margin:0 0 16px;padding:0' });
    for (var i = 0; i < rows.length; i++) {
      var ok = rows[i][1] == null ? null : !!rows[i][1];
      var mark = ok === true ? '✅' : ok === false ? '❌' : '❔';
      var text = rows[i][0];
      if (i === rows.length - 1 && x.oversizedTexture) {
        text += ' — some are ' + x.oversizedTexture + ' px, over the ' + x.maxTextureSize
          + ' px limit, so they were scaled down';
      }
      list.appendChild(el('li', {
        style: 'margin:0 0 6px' + (ok === false ? ';color:' + COLOURS[rows[i][2]] : ''),
      }, mark + '  ' + text));
    }
    return list;
  }

  /*
   * Where problems are shown: under the file browser. The markup provides
   * the spot; a stale index.html might not, and then the top of the page
   * will do.
   */
  function alertHost() {
    var host = document.getElementById('alerts');
    if (!host) {
      host = el('div', { id: 'alerts', style: 'margin:8px' });
      document.body.insertBefore(host, document.body.firstChild);
    }
    return host;
  }

  function link(text, onClick) {
    var a = el('a', { href: '#', style: 'color:#4f8cff;white-space:nowrap' }, text);
    a.addEventListener('click', function (e) { e.preventDefault(); onClick(); });
    return a;
  }

  /**
   * One line under the file browser: the headline in the app's own error
   * colours (the .warn and .caution classes every other error uses) and a
   * link to the Browser check, where the explanation is. The colour is also
   * set inline, so it holds when the stylesheet is the stale file.
   */
  function show(id) {
    var host = alertHost();
    for (var i = 0; i < host.children.length; i++) {
      if (host.children[i].getAttribute('data-key') === id) return;   // already showing
    }
    var red = levelOf(id) === 'red';
    var line = el('p', { 'class': 'alert small', role: red ? 'alert' : 'status', 'data-key': id,
      style: 'margin:0 0 4px' });
    line.appendChild(el('span', {
      'class': red ? 'warn' : 'caution',
      style: 'font-weight:600;color:' + (red ? '#e03131' : '#e8912d'),
    }, MESSAGES[id].title));
    line.appendChild(el('span', null, ' '));
    line.appendChild(link('Browser check', showCheck));
    host.appendChild(line);
  }

  /** Record a problem, and show its line unless it is a minor one. */
  function raise(id) {
    if (state.problems.indexOf(id) < 0) state.problems.push(id);
    if (levelOf(id) !== 'minor') show(id);
  }

  /*
   * An error nothing else caught, once the app is running. One orange line
   * however many there are; each message is listed in the Browser check.
   */
  function unexpected() {
    raise('R3');
  }

  /* --------------------------------------------------------- start-up */

  /*
   * Module scripts always run — or fail — before the load event, so by then
   * the app has either called ready() or never will. No timer to tune.
   */
  function finish() {
    if (state.finished) return;
    state.finished = true;
    state.facts = gatherFacts();
    var found = checks(state.facts);
    if (state.ready) {
      // The app is running, so its scripts and its renderer proved these; a
      // second context failing to open now must not contradict that. Being
      // opened from disk goes too: Firefox runs the app from file:// happily,
      // and it is only a problem in the browsers where it stops the start.
      found = found.filter(function (id) {
        return id !== 'F1' && id !== 'F2' && id !== 'F3a' && id !== 'F3b';
      });
    }
    var fatal = found.filter(isFatal);
    if (!state.ready && !fatal.length) fatal.push('F7');
    var all = fatal.concat(found.filter(function (id) { return !isFatal(id); }));
    for (var i = 0; i < all.length; i++) raise(all[i]);
  }

  window.addEventListener('load', function () { window.setTimeout(finish, 0); });

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('browser-check');
    if (button) button.addEventListener('click', function (e) {
      e.preventDefault();
      showCheck();
    });
  });

  var api = {
    MESSAGES: MESSAGES,
    checks: checks,
    /** Called by main.js as its last start-up step. */
    ready: function () { state.ready = true; },
    /** Filled in by main.js: renderer limits, WebP support, texture sizes. */
    extras: null,
    /** Report a problem by id. main.js uses it for the ones only it can see. */
    raise: raise,
    /** main.js reports the graphics card dropping the page (R1). */
    contextLost: function () {
      state.contextLost = true;
      raise('R1');
    },
    showCheck: showCheck,
    state: state,
  };
  window.Funee = api;
})(window);
