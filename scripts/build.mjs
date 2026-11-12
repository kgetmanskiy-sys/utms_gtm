#!/usr/bin/env node
// Validates config.json and builds dist/utm-direct.js with the config inlined.
// Usage: node scripts/build.mjs
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const KNOWN_KEYS = [
  'enabled',
  'countries',
  'addParams',
  'hostnames',
  'pathRegex',
  'skipIfParamPrefixes',
  'skipIfParams',
  'skipIfLocalStorageKeys',
  'geoTimeoutMs',
];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

function checkStringList(errors, config, key, { allowEmpty = true } = {}) {
  const v = config[key];
  if (!Array.isArray(v)) {
    errors.push(`"${key}" должен быть списком строк, например ["a", "b"]`);
    return;
  }
  if (!allowEmpty && v.length === 0) errors.push(`"${key}" не может быть пустым`);
  v.forEach((item, i) => {
    if (!isNonEmptyString(item)) errors.push(`"${key}"[${i}] должен быть непустой строкой`);
  });
}

/** Returns a list of human-readable errors (in Russian); empty when the config is valid. */
export function validateConfig(config) {
  const errors = [];
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return ['config.json должен быть объектом { ... }'];
  }

  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.includes(key)) errors.push(`неизвестный ключ "${key}" (опечатка?). Допустимые: ${KNOWN_KEYS.join(', ')}`);
  }
  for (const key of KNOWN_KEYS) {
    if (!(key in config)) errors.push(`не хватает ключа "${key}"`);
  }

  if ('enabled' in config && typeof config.enabled !== 'boolean') {
    errors.push('"enabled" должен быть true или false (без кавычек)');
  }

  if ('countries' in config) {
    if (!Array.isArray(config.countries)) {
      errors.push('"countries" должен быть списком кодов стран, например ["ZA", "BR"]');
    } else {
      const seen = new Set();
      config.countries.forEach((c, i) => {
        if (typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)) {
          errors.push(`"countries"[${i}] = ${JSON.stringify(c)}: нужен двухбуквенный код ISO 3166-1 заглавными буквами, например "ZA"`);
        } else if (seen.has(c)) {
          errors.push(`"countries": код ${c} указан дважды`);
        } else {
          seen.add(c);
        }
      });
    }
  }

  if ('addParams' in config) {
    const p = config.addParams;
    if (p === null || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length === 0) {
      errors.push('"addParams" должен быть непустым объектом, например { "utm_source": "direct" }');
    } else {
      for (const [k, v] of Object.entries(p)) {
        if (!isNonEmptyString(k)) errors.push('"addParams": пустое имя параметра');
        if (!isNonEmptyString(v)) errors.push(`"addParams"."${k}" должен быть непустой строкой`);
      }
    }
  }

  if ('hostnames' in config) checkStringList(errors, config, 'hostnames', { allowEmpty: false });
  if ('skipIfParamPrefixes' in config) checkStringList(errors, config, 'skipIfParamPrefixes');
  if ('skipIfParams' in config) checkStringList(errors, config, 'skipIfParams');
  if ('skipIfLocalStorageKeys' in config) checkStringList(errors, config, 'skipIfLocalStorageKeys');

  if ('pathRegex' in config) {
    if (!isNonEmptyString(config.pathRegex)) {
      errors.push('"pathRegex" должен быть непустой строкой');
    } else {
      try {
        new RegExp(config.pathRegex, 'i');
      } catch (e) {
        errors.push(`"pathRegex" — некорректное регулярное выражение: ${e.message}`);
      }
    }
  }

  if ('geoTimeoutMs' in config) {
    const t = config.geoTimeoutMs;
    if (!Number.isInteger(t) || t < 100 || t > 10000) errors.push('"geoTimeoutMs" должен быть целым числом от 100 до 10000');
  }

  // Every added param must itself trigger a skip, otherwise each run (e.g. on every SPA navigation)
  // would fire again.
  if (
    errors.length === 0 &&
    Array.isArray(config.skipIfParams) &&
    Array.isArray(config.skipIfParamPrefixes)
  ) {
    const params = config.skipIfParams.map((s) => s.toLowerCase());
    const prefixes = config.skipIfParamPrefixes.map((s) => s.toLowerCase());
    for (const key of Object.keys(config.addParams)) {
      const k = key.toLowerCase();
      if (!params.includes(k) && !prefixes.some((pre) => k.startsWith(pre))) {
        errors.push(`параметр "${key}" из "addParams" должен попадать под "skipIfParams" или "skipIfParamPrefixes", иначе скрипт будет срабатывать повторно`);
      }
    }
  }

  return errors;
}

export function buildScript(source, config, version) {
  const placeholder = '/*__CONFIG__*/ null';
  if (!source.includes(placeholder)) throw new Error(`в src/utm-direct.js не найден плейсхолдер ${placeholder}`);
  return source
    .replace(placeholder, () => JSON.stringify(config))
    .replace(/__VERSION__/g, () => version);
}

function detectVersion() {
  const date = new Date().toISOString().slice(0, 10);
  let sha = (process.env.GITHUB_SHA || '').slice(0, 7);
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short=7 HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      sha = 'local';
    }
  }
  return `${date}.${sha}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function main() {
  const configPath = join(ROOT, 'config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`❌ config.json не читается как JSON: ${e.message}`);
    console.error('   Проверьте запятые, кавычки и скобки (например, на https://jsonlint.com).');
    process.exit(1);
  }

  const errors = validateConfig(config);
  if (errors.length) {
    console.error('❌ Ошибки в config.json — сборка остановлена, на сайте осталась прежняя версия:');
    for (const e of errors) console.error(`   • ${e}`);
    process.exit(1);
  }

  const version = detectVersion();
  const source = readFileSync(join(ROOT, 'src', 'utm-direct.js'), 'utf8');
  const script = buildScript(source, config, version);

  const dist = join(ROOT, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'utm-direct.js'), script);
  writeFileSync(join(dist, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>tq-utm-direct</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px">
<h1>tq-utm-direct</h1>
<p>Версия: <code>${escapeHtml(version)}</code></p>
<p>Страны: <code>${escapeHtml(config.countries.join(', ') || '—')}</code>, включено: <code>${config.enabled}</code></p>
<p><a href="utm-direct.js">utm-direct.js</a> · <a href="config.json">config.json</a></p>
</body></html>
`
  );

  console.log(`✅ Собрано dist/utm-direct.js (${script.length} байт), версия ${version}`);
  console.log(`   Страны: ${config.countries.join(', ') || '—'}; параметры: ${JSON.stringify(config.addParams)}; enabled: ${config.enabled}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
