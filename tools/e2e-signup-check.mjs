#!/usr/bin/env node
// Manual end-to-end check against the live sign-up page (not run in CI).
//
// Opens https://my.tradequo.com/en/auth/sign-up in headless Chromium, runs the GTM loader from
// gtm/loader.html with dist/utm-direct.js served in place of GitHub Pages, fills the form and
// INTERCEPTS the registration request: nothing is sent to the TradeQuo API (every non-GET request
// is answered locally with 503) and analytics are blocked.
//
// Usage:
//   node scripts/build.mjs
//   node tools/e2e-signup-check.mjs            # all scenarios
//   node tools/e2e-signup-check.mjs za-late    # one scenario
//   E2E_LIVE=1 node tools/e2e-signup-check.mjs # use the script published on GitHub Pages instead of dist/
// Requires Playwright with Chromium (npm i -D playwright && npx playwright install chromium).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIGN_UP = 'https://my.tradequo.com/en/auth/sign-up';
const SCRIPT_URL = 'https://kgetmanskiy-sys.github.io/utms_gtm/utm-direct.js';
const BLOCK = /googletagmanager|google-analytics|doubleclick|g10696554090|g1980843351|amplitude|datadoghq|rudderstack|zdassets|zendesk|facebook|clarity|hotjar|cdn-cgi\/rum/;

const LIVE = process.env.E2E_LIVE === '1';
const DIST_SCRIPT = LIVE ? null : readFileSync(join(ROOT, 'dist', 'utm-direct.js'), 'utf8');
const LOADER = /<script>([\s\S]*?)<\/script>/.exec(readFileSync(join(ROOT, 'gtm', 'loader.html'), 'utf8'))[1];

const SCENARIOS = {
  'za-early': { country: 'ZA', loader: 'early', expectApplied: true },
  'za-late': { country: 'ZA', loader: 'late', expectApplied: true },
  'za-late-filled': { country: 'ZA', loader: 'after-fill', expectApplied: true },
  'za-with-utm': { country: 'ZA', query: '?utm_source=google', loader: 'early', expectApplied: false, expectUtmSource: 'google' },
  'za-with-referral': { country: 'ZA', query: '?referral=TESTREF', loader: 'early', expectApplied: false },
  'us': { country: 'US', loader: 'early', expectApplied: false },
  'real-geo': { country: null, loader: 'early', expectApplied: null, noSubmit: true },
};

async function fillForm(page) {
  await page.fill('input[name=email]', 'utm.e2e.check@example.com');
  await page.fill('input[type=password]', 'Aa1#aaaaaaaa');
  await page.locator('button.select-trigger').first().click();
  await page.waitForTimeout(400);
  await page.locator('[role=option], .option, ds-select-option, mat-option').first().click();
  await page.waitForTimeout(300);
  await page.locator('input.input').last().fill('701234567'); // valid for the first country in the list (+93)
  for (const id of ['#mat-mdc-checkbox-1-input', '#mat-mdc-checkbox-2-input']) {
    const box = page.locator(id);
    if (!(await box.isChecked())) await box.evaluate((e) => e.click());
  }
}

async function runScenario(browser, name, s) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const intercepted = [];

  await page.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    if (BLOCK.test(url)) return route.abort();
    if (url === SCRIPT_URL && LIVE) return route.continue();
    if (url === SCRIPT_URL) return route.fulfill({ status: 200, contentType: 'application/javascript', body: DIST_SCRIPT });
    if (req.method() !== 'GET') {
      intercepted.push({ url, body: req.postData() });
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    }
    return route.continue();
  });

  await page.addInitScript(
    ({ country, loader, early }) => {
      localStorage.setItem('tqUtmDirect.debug', '1');
      if (country) localStorage.setItem('tqUtmDirect.forceCountry', country);
      else localStorage.removeItem('tqUtmDirect.forceCountry');
      window.__e2eMarker = 'same-document';
      // Roughly when GTM fires an Initialization tag.
      if (early) setTimeout(() => new Function(loader)(), 300);
    },
    { country: s.country, loader: LOADER, early: s.loader === 'early' }
  );

  const consoleLines = [];
  page.on('console', (m) => m.text().startsWith('[tqUtmDirect]') && consoleLines.push(m.text()));

  await page.goto(SIGN_UP + (s.query || ''), { waitUntil: 'load' });
  await page.waitForSelector('input[name=email]', { timeout: 45000 });

  if (s.loader === 'late') {
    await page.evaluate(LOADER);
  }
  if (s.loader === 'after-fill') {
    await fillForm(page);
    await page.evaluate(LOADER);
  }

  await page.waitForFunction(() => window.tqUtmDirect && window.tqUtmDirect.ready, null, { timeout: 15000 });
  const status = await page.evaluate(() => window.tqUtmDirect.ready);
  await page.waitForTimeout(800);

  const check = { name, status: status.status, reason: status.reason, country: status.country, routerNotified: status.routerNotified, errors: [] };
  const href = page.url();
  check.href = href;

  if (s.expectApplied === true && !/[?&]utm_source=direct(&|#|$)/.test(href)) check.errors.push('в URL нет utm_source=direct');
  if (s.expectApplied === false && /utm_source=direct/.test(href)) check.errors.push('URL изменён, хотя не должен');
  if (s.expectApplied !== null && (status && status.status === 'applied') !== s.expectApplied) check.errors.push(`status=${status && status.status}`);

  if (s.loader === 'after-fill') {
    const state = await page.evaluate(() => ({
      email: document.querySelector('input[name=email]').value,
      marker: window.__e2eMarker,
      navEntries: performance.getEntriesByType('navigation').length,
    }));
    if (state.email !== 'utm.e2e.check@example.com') check.errors.push(`поле email сброшено: "${state.email}"`);
    if (state.marker !== 'same-document' || state.navEntries !== 1) check.errors.push('страница перезагрузилась');
  }

  if (!s.noSubmit) {
    if (s.loader !== 'after-fill') await fillForm(page);
    await page.click('[data-testid=simplified-continue-button]');
    await page.waitForTimeout(2500);
    const submit = intercepted.find((r) => /\/signup\/.+\/initialize/.test(r.url));
    if (!submit) {
      check.errors.push('запрос регистрации не пойман (форма не отправилась?)');
    } else {
      const utm = JSON.parse(submit.body).utm || {};
      check.utm_source = utm.utm_source;
      const expected = s.expectUtmSource || (s.expectApplied ? 'direct' : undefined);
      if (utm.utm_source !== expected) check.errors.push(`в запросе регистрации utm_source=${utm.utm_source}, ожидалось ${expected}`);
    }
  }

  check.log = consoleLines;
  await context.close();
  return check;
}

const only = process.argv[2];
const names = only ? [only] : Object.keys(SCENARIOS);
const browser = await chromium.launch();
let failed = 0;
for (const name of names) {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`неизвестный сценарий ${name}; есть: ${Object.keys(SCENARIOS).join(', ')}`);
  let r;
  try {
    r = await runScenario(browser, name, s);
  } catch (e) {
    r = { name, errors: [String(e.message || e).split('\n')[0]] };
  }
  const ok = r.errors.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: status=${r.status}${r.country ? ` country=${r.country}` : ''}${r.reason ? ` (${r.reason})` : ''}${r.routerNotified !== undefined ? ` popstate=${r.routerNotified}` : ''}${'utm_source' in r ? ` submit.utm_source=${r.utm_source}` : ''}`);
  if (r.href) console.log(`     url: ${r.href}`);
  for (const e of r.errors) console.log(`     ✗ ${e}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
