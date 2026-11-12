/*!
 * tq-utm-direct __VERSION__
 * Adds utm_source=direct (or other params from config.json) to the sign-up URL
 * for visitors from selected countries who arrived without UTM / referral / click ids.
 * Source: https://github.com/kgetmanskiy-sys/utms_gtm
 */
(function (w, d) {
  'use strict';

  var NS = 'tqUtmDirect';
  var VERSION = '__VERSION__';
  // Replaced with the contents of config.json by scripts/build.mjs.
  var CONFIG = /*__CONFIG__*/ null;

  var FORCE_COUNTRY_KEY = NS + '.forceCountry'; // localStorage, for testing
  var DEBUG_KEY = NS + '.debug'; // localStorage, '1' enables console logs
  var COUNTRY_CACHE_KEY = NS + '.country'; // sessionStorage
  var TRACE_URL = '/cdn-cgi/trace';

  if (!CONFIG) return;

  // Loaded twice (e.g. the loader ran before the first copy finished): reuse the first copy.
  if (w[NS] && typeof w[NS].run === 'function') {
    w[NS].run();
    return;
  }

  var countryPromise = null;

  function storageGet(name, key) {
    try {
      var s = w[name];
      return s ? s.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }

  function storageSet(name, key, value) {
    try {
      var s = w[name];
      if (s) s.setItem(key, value);
    } catch (e) {
      /* storage blocked: ignore */
    }
  }

  function log() {
    if (storageGet('localStorage', DEBUG_KEY) !== '1' || !w.console) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[' + NS + ']');
    w.console.log.apply(w.console, args);
  }

  function toLowerList(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) out.push(String(list[i]).toLowerCase());
    return out;
  }

  var cfg = {
    enabled: CONFIG.enabled !== false,
    countries: (function () {
      var out = [];
      for (var i = 0; i < (CONFIG.countries || []).length; i++) out.push(String(CONFIG.countries[i]).toUpperCase());
      return out;
    })(),
    addParams: CONFIG.addParams || {},
    hostnames: toLowerList(CONFIG.hostnames),
    pathRegex: new RegExp(CONFIG.pathRegex, 'i'),
    skipIfParamPrefixes: toLowerList(CONFIG.skipIfParamPrefixes),
    skipIfParams: toLowerList(CONFIG.skipIfParams),
    skipIfLocalStorageKeys: CONFIG.skipIfLocalStorageKeys || [],
    geoTimeoutMs: CONFIG.geoTimeoutMs || 2000
  };

  /** Returns why this page must be left alone, or null when the params may be added. */
  function skipReason(href) {
    var url = new URL(href);

    if (!cfg.enabled) return 'disabled in config';
    if (cfg.hostnames.indexOf(url.hostname.toLowerCase()) === -1) return 'hostname not in config: ' + url.hostname;
    if (!cfg.pathRegex.test(url.pathname)) return 'path does not match: ' + url.pathname;

    var reason = null;
    url.searchParams.forEach(function (value, key) {
      if (reason) return;
      var k = key.toLowerCase();
      if (cfg.skipIfParams.indexOf(k) !== -1) {
        reason = 'url has param ' + key;
        return;
      }
      for (var i = 0; i < cfg.skipIfParamPrefixes.length; i++) {
        if (k.indexOf(cfg.skipIfParamPrefixes[i]) === 0) {
          reason = 'url has param ' + key;
          return;
        }
      }
    });
    if (reason) return reason;

    for (var j = 0; j < cfg.skipIfLocalStorageKeys.length; j++) {
      if (storageGet('localStorage', cfg.skipIfLocalStorageKeys[j])) {
        return 'localStorage has ' + cfg.skipIfLocalStorageKeys[j];
      }
    }
    return null;
  }

  function fetchCountry() {
    return new Promise(function (resolve, reject) {
      var controller = typeof w.AbortController === 'function' ? new w.AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
        reject(new Error('geo timeout ' + cfg.geoTimeoutMs + 'ms'));
      }, cfg.geoTimeoutMs);

      w.fetch(TRACE_URL, { credentials: 'omit', cache: 'no-store', signal: controller ? controller.signal : undefined })
        .then(function (res) {
          if (!res.ok) throw new Error('geo http ' + res.status);
          return res.text();
        })
        .then(function (text) {
          clearTimeout(timer);
          var m = /(?:^|\n)loc=([A-Za-z0-9]{2})\s*(?:\n|$)/.exec(text);
          if (!m) throw new Error('geo: no loc in trace');
          resolve(m[1].toUpperCase());
        })
        .catch(function (err) {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  function getCountry() {
    var forced = storageGet('localStorage', FORCE_COUNTRY_KEY);
    if (forced) return Promise.resolve(String(forced).toUpperCase());

    var cached = storageGet('sessionStorage', COUNTRY_CACHE_KEY);
    if (cached) return Promise.resolve(cached);

    if (!countryPromise) {
      countryPromise = fetchCountry().then(
        function (country) {
          storageSet('sessionStorage', COUNTRY_CACHE_KEY, country);
          return country;
        },
        function (err) {
          countryPromise = null; // allow a retry on the next run()
          throw err;
        }
      );
    }
    return countryPromise;
  }

  /** Appends only the missing params, leaving the existing query string untouched. */
  function buildUrl(href) {
    var url = new URL(href);
    var search = url.search;
    var keys = Object.keys(cfg.addParams);
    for (var i = 0; i < keys.length; i++) {
      if (url.searchParams.has(keys[i])) continue;
      search += (search ? '&' : '?') + encodeURIComponent(keys[i]) + '=' + encodeURIComponent(cfg.addParams[keys[i]]);
    }
    return url.pathname + search + url.hash;
  }

  function notifyRouter() {
    // Angular has already read the URL: a popstate makes its router read it again (no reload).
    if (!d.querySelector('[ng-version]')) return false;
    var event;
    try {
      event = new w.PopStateEvent('popstate', { state: w.history.state });
    } catch (e) {
      event = d.createEvent('Event');
      event.initEvent('popstate', false, false);
    }
    w.dispatchEvent(event);
    return true;
  }

  function apply(country) {
    var reason = skipReason(w.location.href); // the URL may have changed while the country was loading
    if (reason) return { status: 'skipped', reason: reason, country: country };

    var newUrl = buildUrl(w.location.href);
    w.history.replaceState(w.history.state, '', newUrl);
    var routerNotified = notifyRouter();

    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push({ event: 'utm_direct_applied', utm_direct_country: country });

    log('applied', { country: country, url: newUrl, routerNotified: routerNotified });
    return { status: 'applied', country: country, url: newUrl, routerNotified: routerNotified };
  }

  function run() {
    try {
      if (!w.fetch || !w.URL || !w.history || !w.history.replaceState || !w.Promise) {
        return Promise.resolve({ status: 'skipped', reason: 'browser not supported' });
      }

      var reason = skipReason(w.location.href);
      if (reason) {
        log('skip:', reason);
        return Promise.resolve({ status: 'skipped', reason: reason });
      }

      return getCountry().then(
        function (country) {
          try {
            if (cfg.countries.indexOf(country) === -1) {
              log('skip: country ' + country + ' not in config');
              return { status: 'skipped', reason: 'country not in config', country: country };
            }
            var result = apply(country);
            if (result.status === 'skipped') log('skip:', result.reason);
            return result;
          } catch (e) {
            log('error', e);
            return { status: 'error', error: String(e) };
          }
        },
        function (err) {
          log('skip: country unknown', err);
          return { status: 'skipped', reason: 'country unknown: ' + (err && err.message) };
        }
      );
    } catch (e) {
      log('error', e);
      return Promise.resolve({ status: 'error', error: String(e) });
    }
  }

  w[NS] = { version: VERSION, config: CONFIG, run: run, ready: null };
  w[NS].ready = run();
})(window, document);
