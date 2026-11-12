import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildScript, validateConfig } from '../scripts/build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'src', 'utm-direct.js'), 'utf8');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

// Behaviour tests use their own fixed config, so editing config.json on GitHub (new countries,
// another utm value) never breaks them. config.json itself is checked in «валидация config.json».
const TEST_CONFIG = {
  enabled: true,
  countries: ['ZA', 'BR', 'PH', 'AU'],
  addParams: { utm_source: 'direct' },
  hostnames: ['my.tradequo.com'],
  pathRegex: '^/([a-z]{2}([-_][a-z]{2,4})?/)?auth/sign-up/?$',
  skipIfParamPrefixes: ['utm_'],
  skipIfParams: [
    'referral', 'ref', 'reg', 'regnew', 'new',
    'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid',
    'ttclid', 'twclid', 'li_fat_id', 'yclid', 'tradingview_uid', 'roistat_visit',
  ],
  skipIfLocalStorageKeys: ['IB_CLICK_TOKEN', 'REFERRAL_QUERY_PARAM_NAME'],
  geoTimeoutMs: 2000,
};

/** The query string the script appends for a config, e.g. 'utm_source=direct'. */
const addedQuery = (config) =>
  Object.entries(config.addParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
const Q = addedQuery(TEST_CONFIG);

const SIGN_UP = 'https://my.tradequo.com/en/auth/sign-up';

function makeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  };
}

/**
 * Loads the built script into a fake browser and returns the environment.
 * trace: { country, status, delayMs, body } describes the /cdn-cgi/trace response.
 */
function load({
  href = SIGN_UP,
  config = TEST_CONFIG,
  trace = {},
  ngBooted = false,
  local = {},
  session = {},
  onFetch,
} = {}) {
  const calls = { fetch: [], replaceState: [], dispatched: [] };
  const location = { href };
  const history = {
    state: { navigationId: 1 },
    replaceState(state, _title, url) {
      calls.replaceState.push(url);
      this.state = state;
      location.href = new URL(url, location.href).href;
    },
  };
  const window = {
    location,
    history,
    URL,
    Promise,
    AbortController,
    console,
    localStorage: makeStorage(local),
    sessionStorage: makeStorage(session),
    PopStateEvent: class {
      constructor(type, init) {
        this.type = type;
        this.state = init && init.state;
      }
    },
    dispatchEvent(e) {
      calls.dispatched.push(e);
      return true;
    },
    fetch(url, opts) {
      calls.fetch.push(url);
      if (onFetch) onFetch(window);
      const { country = 'ZA', status = 200, delayMs = 0, body } = trace;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => body ?? `fl=1f\nh=my.tradequo.com\nip=1.2.3.4\nloc=${country}\ntls=TLSv1.3\n`,
          });
        }, delayMs);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    },
  };
  const document = {
    querySelector: (sel) => (sel === '[ng-version]' && ngBooted ? {} : null),
    createEvent: () => ({ initEvent() {} }),
  };
  const script = buildScript(SOURCE, config, 'test');
  const context = vm.createContext({ window, document, URL, setTimeout, clearTimeout });
  vm.runInContext(script, context);
  return { window, document, calls, location, script, context };
}

const urlOf = (env) => env.location.href;

describe('добавляет метку', () => {
  test('посетитель из ZA без меток: utm_source=direct, без popstate до загрузки Angular', async () => {
    const env = load();
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'applied');
    assert.equal(urlOf(env), `${SIGN_UP}?${Q}`);
    assert.deepEqual(env.calls.fetch, ['/cdn-cgi/trace']);
    assert.equal(env.calls.dispatched.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(env.window.dataLayer)), [
      { event: 'utm_direct_applied', utm_direct_country: 'ZA' },
    ]);
    assert.equal(env.window.sessionStorage.getItem('tqUtmDirect.country'), 'ZA');
  });

  for (const country of TEST_CONFIG.countries) {
    test(`страна ${country} из config.json`, async () => {
      const env = load({ trace: { country } });
      assert.equal((await env.window.tqUtmDirect.ready).status, 'applied');
      assert.equal(urlOf(env), `${SIGN_UP}?${Q}`);
    });
  }

  test('Angular уже загружен: отправляет popstate с текущим history.state', async () => {
    const env = load({ ngBooted: true });
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.routerNotified, true);
    assert.equal(env.calls.dispatched.length, 1);
    assert.equal(env.calls.dispatched[0].type, 'popstate');
    assert.deepEqual(env.calls.dispatched[0].state, { navigationId: 1 });
  });

  test('сохраняет остальные параметры (без перекодирования) и hash', async () => {
    const env = load({ href: `${SIGN_UP}?wizard_id=5&x=a%20b+c#frag` });
    await env.window.tqUtmDirect.ready;
    assert.equal(urlOf(env), `${SIGN_UP}?wizard_id=5&x=a%20b+c&${Q}#frag`);
    assert.deepEqual(env.calls.replaceState, [`/en/auth/sign-up?wizard_id=5&x=a%20b+c&${Q}#frag`]);
  });

  for (const path of ['/pt/auth/sign-up', '/pt-br/auth/sign-up', '/es_ES/auth/sign-up', '/auth/sign-up', '/en/auth/sign-up/', '/EN/AUTH/SIGN-UP']) {
    test(`подходящий путь ${path}`, async () => {
      const env = load({ href: `https://my.tradequo.com${path}` });
      assert.equal((await env.window.tqUtmDirect.ready).status, 'applied');
    });
  }

  test('несколько параметров в addParams', async () => {
    const config = { ...TEST_CONFIG, addParams: { utm_source: 'direct', utm_medium: 'none' } };
    const env = load({ config });
    await env.window.tqUtmDirect.ready;
    assert.equal(urlOf(env), `${SIGN_UP}?utm_source=direct&utm_medium=none`);
  });

  test('страна из кэша sessionStorage: без запроса trace', async () => {
    const env = load({ session: { 'tqUtmDirect.country': 'BR' } });
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'applied');
    assert.equal(res.country, 'BR');
    assert.equal(env.calls.fetch.length, 0);
  });

  test('принудительная страна для тестов (localStorage tqUtmDirect.forceCountry)', async () => {
    const env = load({ local: { 'tqUtmDirect.forceCountry': 'ph' }, trace: { country: 'US' } });
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'applied');
    assert.equal(res.country, 'PH');
    assert.equal(env.calls.fetch.length, 0);
  });
});

describe('ничего не меняет', () => {
  async function assertUntouched(env, reasonPattern) {
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'skipped', JSON.stringify(res));
    if (reasonPattern) assert.match(res.reason, reasonPattern);
    assert.equal(env.calls.replaceState.length, 0);
    assert.equal(env.calls.dispatched.length, 0);
    assert.equal(env.window.dataLayer, undefined);
  }

  for (const q of ['utm_source=google', 'utm_medium=cpc', 'UTM_Campaign=x', 'utm_id=1', 'utm_custom=1']) {
    test(`есть ${q}`, async () => {
      const env = load({ href: `${SIGN_UP}?${q}` });
      await assertUntouched(env, /url has param/);
      assert.equal(env.calls.fetch.length, 0);
    });
  }

  for (const p of TEST_CONFIG.skipIfParams) {
    test(`есть ${p}`, async () => {
      const env = load({ href: `${SIGN_UP}?foo=1&${p}=ABC` });
      await assertUntouched(env, /url has param/);
    });
  }

  test('пустое значение referral тоже считается', async () => {
    await assertUntouched(load({ href: `${SIGN_UP}?referral=` }), /url has param/);
  });

  for (const key of TEST_CONFIG.skipIfLocalStorageKeys) {
    test(`партнёр из прошлого визита: localStorage ${key}`, async () => {
      await assertUntouched(load({ local: { [key]: 'PARTNER1' } }), /localStorage/);
    });
  }

  for (const href of [
    'https://my.tradequo.com/en/auth/sign-in',
    'https://my.tradequo.com/en/auth/sign-up/0199-uuid/123456',
    'https://my.tradequo.com/en/dashboard',
    'https://tradequo.com/en/auth/sign-up',
    'https://my.tradequo.com.evil.com/en/auth/sign-up',
  ]) {
    test(`другая страница ${href}`, async () => {
      const env = load({ href });
      await assertUntouched(env);
      assert.equal(env.calls.fetch.length, 0);
    });
  }

  test('страна не из списка', async () => {
    await assertUntouched(load({ trace: { country: 'US' } }), /country not in config/);
  });

  test('trace вернул ошибку', async () => {
    await assertUntouched(load({ trace: { status: 500 } }), /country unknown/);
  });

  test('в trace нет loc', async () => {
    await assertUntouched(load({ trace: { body: 'fl=1\nh=x\n' } }), /country unknown/);
  });

  test('trace не ответил за geoTimeoutMs', async () => {
    const env = load({ config: { ...TEST_CONFIG, geoTimeoutMs: 50 }, trace: { delayMs: 500 } });
    await assertUntouched(env, /timeout/);
  });

  test('enabled: false', async () => {
    const env = load({ config: { ...TEST_CONFIG, enabled: false } });
    await assertUntouched(env, /disabled/);
    assert.equal(env.calls.fetch.length, 0);
  });

  test('URL изменился, пока определялась страна (ушёл на sign-in)', async () => {
    const env = load({
      trace: { delayMs: 20 },
      onFetch: (w) => {
        w.location.href = 'https://my.tradequo.com/en/auth/sign-in';
      },
    });
    await assertUntouched(env, /path does not match/);
  });

  test('ошибка trace не кэшируется: следующий run() пробует снова', async () => {
    const env = load({ trace: { status: 500 } });
    await env.window.tqUtmDirect.ready;
    await env.window.tqUtmDirect.run();
    assert.equal(env.calls.fetch.length, 2);
    assert.equal(env.window.sessionStorage.getItem('tqUtmDirect.country'), null);
  });
});

describe('повторные вызовы', () => {
  test('повторный run() после применения ничего не делает', async () => {
    const env = load({ ngBooted: true });
    await env.window.tqUtmDirect.ready;
    const res = await env.window.tqUtmDirect.run();
    assert.equal(res.status, 'skipped');
    assert.equal(env.calls.replaceState.length, 1);
    assert.equal(env.calls.dispatched.length, 1);
    assert.equal(env.window.dataLayer.length, 1);
  });

  test('одновременные run() делают один запрос trace', async () => {
    const env = load({ trace: { delayMs: 20 } });
    const second = env.window.tqUtmDirect.run();
    const [a, b] = await Promise.all([env.window.tqUtmDirect.ready, second]);
    assert.equal(env.calls.fetch.length, 1);
    assert.deepEqual([a.status, b.status].sort(), ['applied', 'skipped']);
    assert.equal(env.calls.replaceState.length, 1);
  });

  test('скрипт загружен дважды: второй экземпляр не переопределяет первый', async () => {
    const env = load({ href: 'https://my.tradequo.com/en/auth/sign-in' });
    const first = env.window.tqUtmDirect;
    vm.runInContext(env.script, env.context);
    assert.equal(env.window.tqUtmDirect, first);
  });

  test('SPA-переход sign-in → sign-up и повторный run() из GTM History Change', async () => {
    const env = load({ href: 'https://my.tradequo.com/en/auth/sign-in', ngBooted: true });
    assert.equal((await env.window.tqUtmDirect.ready).status, 'skipped');
    env.location.href = SIGN_UP;
    const res = await env.window.tqUtmDirect.run();
    assert.equal(res.status, 'applied');
    assert.equal(urlOf(env), `${SIGN_UP}?${Q}`);
    assert.equal(env.calls.dispatched.length, 1);
  });
});

describe('валидация config.json', () => {
  test('config.json из репозитория валиден', () => {
    assert.deepEqual(validateConfig(CONFIG), []);
  });

  test('собранный из config.json скрипт работает', async () => {
    const env = load({ config: CONFIG, trace: { country: CONFIG.countries[0] || 'ZA' } });
    const res = await env.window.tqUtmDirect.ready;
    assert.notEqual(res.status, 'error', JSON.stringify(res));
    assert.deepEqual(JSON.parse(JSON.stringify(env.window.tqUtmDirect.config)), CONFIG);
    const standardCase =
      CONFIG.enabled &&
      CONFIG.countries.length > 0 &&
      CONFIG.hostnames.map((h) => h.toLowerCase()).includes('my.tradequo.com') &&
      new RegExp(CONFIG.pathRegex, 'i').test('/en/auth/sign-up');
    if (standardCase) {
      assert.equal(res.status, 'applied', JSON.stringify(res));
      assert.equal(urlOf(env), `${SIGN_UP}?${addedQuery(CONFIG)}`);
    }
  });

  test('тестовый конфиг валиден', () => {
    assert.deepEqual(validateConfig(TEST_CONFIG), []);
  });

  const bad = [
    ['код страны строчными', { countries: ['za'] }, /countries/],
    ['трёхбуквенный код', { countries: ['ZAF'] }, /countries/],
    ['повтор страны', { countries: ['ZA', 'ZA'] }, /дважды/],
    ['countries не список', { countries: 'ZA' }, /countries/],
    ['кривой regex', { pathRegex: '^/(auth' }, /pathRegex/],
    ['опечатка в ключе', { countrys: ['ZA'] }, /неизвестный ключ "countrys"/],
    ['enabled строкой', { enabled: 'true' }, /enabled/],
    ['пустой addParams', { addParams: {} }, /addParams/],
    ['пустое значение в addParams', { addParams: { utm_source: '' } }, /addParams/],
    ['addParams не попадает под skip', { addParams: { source: 'direct' } }, /срабатывать повторно/],
    ['пустой hostnames', { hostnames: [] }, /hostnames/],
    ['geoTimeoutMs вне диапазона', { geoTimeoutMs: 50000 }, /geoTimeoutMs/],
  ];
  for (const [name, patch, pattern] of bad) {
    test(name, () => {
      const errors = validateConfig({ ...TEST_CONFIG, ...patch });
      assert.ok(errors.some((e) => pattern.test(e)), errors.join('\n') || 'нет ошибок');
    });
  }

  test('не хватает ключа', () => {
    const { geoTimeoutMs, ...rest } = TEST_CONFIG;
    assert.ok(validateConfig(rest).some((e) => /geoTimeoutMs/.test(e)));
  });

  test('buildScript вшивает конфиг и версию', () => {
    const out = buildScript(SOURCE, TEST_CONFIG, '2026-01-01.abc1234');
    assert.ok(!out.includes('__CONFIG__'));
    assert.ok(!out.includes('__VERSION__'));
    assert.ok(out.includes('"countries":["ZA","BR","PH","AU"]'));
    assert.ok(out.includes('2026-01-01.abc1234'));
  });
});
