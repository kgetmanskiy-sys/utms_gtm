# utm_source=direct для регистрации на my.tradequo.com

Скрипт для Google Tag Manager. Посетителям из выбранных стран, которые открыли страницу регистрации `https://my.tradequo.com/<язык>/auth/sign-up` **без меток**, он дописывает в URL `?utm_source=direct`. Метка попадает в данные регистрации: форма B2Core отправляет её в поле `utm`.

- **Страница не перезагружается.** URL меняется через `history.replaceState`. Если форма уже загружена, портал перечитывает адрес без перезагрузки, а введённые данные сохраняются.
- **Не трогаем посетителей, у которых уже есть признаки источника:**
  - любой параметр `utm_*`;
  - партнёрские параметры `referral`, `ref`, `reg`, `regnew`, `new`;
  - рекламные click-id: `gclid`, `fbclid`, `msclkid` и др.;
  - партнёрская ссылка из прошлого визита, которую портал сохранил в браузере.
- **Страна** определяется по IP через Cloudflare (`/cdn-cgi/trace` на самом my.tradequo.com) и кэшируется на время сессии.
- **Настройки в [`config.json`](config.json).** В GTM вставляется только загрузчик, один раз.

## Как это устроено

```
GTM (тег Custom HTML, загрузчик)  ──загружает──▶  https://kgetmanskiy-sys.github.io/utms_gtm/utm-direct.js
                                                   (config.json вшит в скрипт при сборке)
config.json на GitHub ──коммит в main──▶ GitHub Actions: проверка + тесты ──▶ публикация на GitHub Pages
```

Если в `config.json` ошибка, сборка останавливается: на сайте остаётся прежняя рабочая версия, а GitHub присылает письмо.

---

## 1. Первичная настройка (один раз)

### GitHub
1. Влейте код в ветку `main`.
2. **Settings → General → Danger Zone → Change visibility → Public.** На бесплатном тарифе GitHub Pages работает только для публичных репозиториев. Секретов в репозитории нет.
3. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
4. **Actions → «Проверка и публикация на GitHub Pages» → Run workflow** (ветка `main`). Дождитесь зелёной галочки.
5. Откройте https://kgetmanskiy-sys.github.io/utms_gtm/: там видны версия и список стран. Сам скрипт лежит по адресу https://kgetmanskiy-sys.github.io/utms_gtm/utm-direct.js.

### Google Tag Manager (контейнер GTM-565JN86S)
1. **Триггеры → Создать:**
   - `UTM direct — init`: тип **Initialization — All Pages**, срабатывает на **Some Initialization Events**, условие `Page Hostname` **equals** `my.tradequo.com`.
   - `UTM direct — history`: тип **History Change**, срабатывает на **Some History Changes**, то же условие. Нужен для перехода со страницы входа на регистрацию внутри портала.
   
   Контейнер общий с tradequo.com, поэтому условие по хосту обязательно. Скрипт и сам проверяет хост и путь.
2. **Теги → Создать → Custom HTML**, название `UTM direct — loader`. Вставьте код из [`gtm/loader.html`](gtm/loader.html) и укажите оба триггера.
3. **Preview** → откройте `https://my.tradequo.com/en/auth/sign-up` и проверьте по разделу «Проверка» ниже → **Submit / Publish**.

---

## 2. Как поменять настройки

1. Откройте [`config.json`](config.json) на github.com и нажмите ✏️ (Edit).
2. Внесите изменения и нажмите **Commit changes** в ветку `main`.
3. Во вкладке **Actions** дождитесь зелёной галочки (около 1 минуты). Если галочка красная, откройте запуск: там написано, что не так. На сайте при этом работает прежняя версия.
4. Посетители получат новую версию в течение 10 минут: столько GitHub Pages кэширует файл.

| Поле | Что значит |
|---|---|
| `enabled` | `true` — работает, `false` — выключено (аварийный выключатель). |
| `countries` | Коды стран ISO 3166-1, две заглавные буквы: `"ZA"` — ЮАР, `"BR"` — Бразилия, `"PH"` — Филиппины, `"AU"` — Австралия, `"IN"` — Индия, `"NG"` — Нигерия… [Список кодов](https://ru.wikipedia.org/wiki/ISO_3166-1#Коды). |
| `addParams` | Какие параметры добавлять. Например, `{ "utm_source": "direct", "utm_medium": "none" }`. Каждый параметр должен попадать под `skipIfParamPrefixes` или `skipIfParams`; для `utm_*` это уже так. |
| `hostnames` | На каких доменах работать. |
| `pathRegex` | Регулярное выражение для пути страницы. По умолчанию это страница регистрации на любом языке (`/en/auth/sign-up`, `/pt/auth/sign-up`, …). |
| `skipIfParamPrefixes` | Если в URL есть параметр с таким началом, ничего не делаем (`utm_`). |
| `skipIfParams` | Если в URL есть такой параметр, ничего не делаем: партнёрские и рекламные. |
| `skipIfLocalStorageKeys` | Если в браузере сохранена партнёрская ссылка из прошлого визита (B2Core хранит её в `IB_CLICK_TOKEN`), ничего не делаем. |
| `geoTimeoutMs` | Сколько ждать определения страны (мс). Если не успели, ничего не делаем. |

Пример: добавить Индию и Нигерию:
```json
"countries": ["ZA", "BR", "PH", "AU", "IN", "NG"],
```
Частая ошибка — лишняя или пропущенная запятая. Сборка такое поймает и ничего не сломает.

---

## 3. Проверка и отладка

В браузере откройте my.tradequo.com, затем консоль разработчика (F12 → Console) и выполните:
```js
localStorage['tqUtmDirect.forceCountry'] = 'ZA'; // притвориться посетителем из ЮАР
localStorage['tqUtmDirect.debug'] = '1';         // писать в консоль, что делает скрипт
```
Затем откройте `https://my.tradequo.com/en/auth/sign-up`. Ожидаемый результат:
- адрес стал `…/sign-up?utm_source=direct`, страница не перезагружалась;
- в консоли есть строка `[tqUtmDirect] applied {country: 'ZA', …}`;
- в GTM Preview есть событие `utm_direct_applied` с переменной `utm_direct_country`. Его можно использовать в своих тегах.

Ещё полезно:
- `tqUtmDirect.version` — какая версия загружена;
- `tqUtmDirect.config` — с какими настройками.

После проверки удалите флаги:
```js
localStorage.removeItem('tqUtmDirect.forceCountry'); localStorage.removeItem('tqUtmDirect.debug');
```

## Важно знать

- **GA4.** URL теперь содержит `utm_source=direct`, поэтому в GA4 такие сессии будут видны как source `direct` / medium `(not set)`, а не `(direct) / (none)`. Если нужен medium, добавьте его в `addParams`.
- **VPN.** Страна определяется по IP. Посетитель с VPN считается страной VPN-сервера.
- **Портал обновляется.** B2Core — сторонняя платформа. После её крупных обновлений стоит прогнать e2e-проверку (ниже): она показывает, доходит ли метка до запроса регистрации.

---

## Для разработчика

```bash
node scripts/build.mjs   # проверка config.json и сборка dist/
```
```bash
node --test              # unit-тесты (без зависимостей, Node 20+)
```
```bash
node tools/e2e-signup-check.mjs   # e2e на живом портале, нужен Playwright + Chromium
```
`e2e-signup-check` открывает живую страницу регистрации и подставляет собранный `dist/utm-direct.js` вместо GitHub Pages. Затем заполняет форму и **перехватывает** запрос регистрации: на сервер TradeQuo ничего не уходит, аналитика блокируется. Проверяемые сценарии:
- ZA, скрипт сработал рано;
- ZA, скрипт сработал поздно;
- ZA, скрипт сработал после заполнения формы;
- с `utm_source`;
- с `referral`;
- страна US;
- реальная страна по IP.

Файлы:
- [`src/utm-direct.js`](src/utm-direct.js) — логика (без зависимостей, обёрнута в try/catch, никогда не перезагружает страницу);
- [`scripts/build.mjs`](scripts/build.mjs) — валидация конфига и сборка;
- [`test/utm-direct.test.mjs`](test/utm-direct.test.mjs) — unit-тесты;
- [`tools/e2e-signup-check.mjs`](tools/e2e-signup-check.mjs) — e2e-проверка;
- [`gtm/loader.html`](gtm/loader.html) — код для GTM;
- [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) — CI и публикация.
