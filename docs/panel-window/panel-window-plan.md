# panel-window — универсальный контрол панели (floating / docked / detached)

**Owner request (2026-07-13):** добавить новый режим **detached** отображения окна панели — окно
отображается в **отдельном OS-окне**. Идея владельца: отдельный процесс через AppCore, «возможно,
есть более лёгкий способ — не запускать новый AppCore, а открывать новое окно с другим WebView».
Дочернее окно **зависит от главного**: если закрыть главное — вспомогательное тоже закрывается.
Паттерн диалога (модальный/floating | docked | detached) должен стать **универсальным
переиспользуемым контролом**; первый кандидат — **панель открытия файлов** (FileOpenDialog).

Ledger (authoritative): [panel-window-progress.json](panel-window-progress.json).
Методология Plan+Ledger — как в [file-browser](../file-browser/file-browser-plan.md): atomic
per-step commits (префикс id шага, напр. `PW1.2 ...`), `verify` перед `done`, пауза на
owner-чекпоинтах.

## 1. Требования владельца (дословно → нумерованно)

1. Новый режим **detached**: панель отображается в отдельном окне ОС (не внутри страницы).
2. **Зависимость от главного окна:** закрытие главного окна закрывает и detached-окно.
3. Паттерн «модальное / задоченное / detached окно» — **универсальный переиспользуемый контрол**.
4. Первый потребитель контрола — **панель открытия файлов** (FileOpenDialog).
5. Механизм detached: владелец предложил отдельный AppCore-процесс, но просил подсказать более
   лёгкий способ («новое окно с другим WebView-элементом»). → Принято решение PW-D1: **лёгкий
   способ существует** — `window.open()` внутри WebView2, второй AppCore-процесс не нужен.
6. (owner 2026-07-13) В отдельном (detached) окне **не должна отображаться адресная строка**.
   Реальность по платформам: в **AppCore/WebView2** default-popup — голое окно (title bar без
   браузерного UI), требование выполняется само; проверяется в PW4.2, и если строка там всё же
   есть — план B: минимальный обработчик `NewWindowRequested` в AppCore со своим окном без хрома.
   В **обычном браузере (dev)** скрыть адресную строку у popup **невозможно принципиально**
   (анти-спуфинг: `location=no` игнорируется современными Chrome/Edge/Firefox) — dev-ограничение,
   не влияющее на прод.

## 2. Контекст текущей реализации

- Прод-окружение — **AppCore** (`c:\projects\Games\AppCore`, FreePascal): AppMain.exe хостит одно
  окно WebView2 через библиотеку [webview/webview](https://github.com/webview/webview)
  (libwebview.dll). Библиотека **не подписывается на `NewWindowRequested`** (проверено grep по
  webview/core) → для `window.open()` WebView2 Runtime применяет **поведение по умолчанию: сам
  создаёт дочернее top-level popup-окно** — в том же браузерном процессе, с тем же профилем и
  origin. Dev-окружение — обычный браузер, где `window.open` работает штатно.
- [FileOpenDialog.vue](../../../GnauralCore/ui/components/FileOpenDialog.vue) — floating/docked
  панель (FB-D13): режим/геометрия в Pinia-сторе
  [fs-browser.ts](../../../GnauralCore/ui/stores/fs-browser.ts) (`windowMode/floatRect/dockSize/
  open`, персист в localStorage), хром окна (titlebar+drag, dock-меню, ресайзеры) written inline.
  [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue) телепортирует floating в `<body>`
  и хостит docked как flex-ребёнка.
- Модульная система UI: `MindWaveCore/ui/src/modules/index.ts` собирает манифесты модулей
  (`gnauralModule`: routes / messages / settingsTabs); роуты модулей — дети MainLayout.
  Router mode = **hash** (`#/audio`). Алиас-паттерн уже есть (`@protocol` в vite+tsconfig).

## 3. Архитектура (принятые решения — детали в ledger `decisions`)

- **Механизм detached (PW-D1): `window.open()` того же SPA, без второго AppCore.** Дочернее окно
  открывает `#/panel/<panelId>` (тот же origin) → в AppCore это default popup WebView2 (тот же
  браузерный процесс: общие localStorage / BroadcastChannel; гибель главного процесса убивает
  popup), в браузере — обычный popup. AppCore/Pascal **не трогаем вообще**. Fallback: если
  `window.open` вернул `null` (popup-blocker) — остаёмся во floating + уведомление.
- **Зависимость от главного (PW-D2), трёхуровневая:** (a) `pagehide` главного окна шлёт
  `parent-gone`; ребёнок ждёт grace-период на новый `parent-hello` (переживает F5/hot-reload) и
  сам закрывается (`window.close()` разрешён script-opened окнам); (b) heartbeat родителя по
  каналу — тишина дольше порога = self-close (покрывает crash вкладки); (c) сама платформа:
  выход хост-процесса AppCore убивает все окна WebView2.
- **Универсальный контрол (PW-D3):** `PanelWindow.vue` + `usePanelWindowState(panelId, opts)` —
  generic-состояние `{open, mode: floating|left|right|top|bottom|detached, floatRect, dockSize}`
  с персистом `mindwave-panel-<id>-*`; для file-open передаются существующие legacy-ключи
  `mindwave-fs-browser-*` (обратная совместимость, без миграции). Хром (titlebar+drag, dock-меню
  + пункт «Отдельное окно», close, ресайзеры) извлекается из FileOpenDialog; контент/футер — слоты.
- **Контент в дочернем окне (PW-D4):** top-level route `/panel/:panelId` (вне MainLayout) +
  `PanelHostPage.vue`; **реестр панелей через манифест модуля** (`gnauralModule.panels:
  [{id, component, titleKey, icon}]` — как routes/settingsTabs). FileOpenDialog разделяется:
  PanelWindow (хром) + `FileOpenPanel.vue` (тело+футер), переиспользуемый в обоих окнах.
- **Мост parent↔child (PW-D5):** `BroadcastChannel('mw-panel:<id>')` — hello/heartbeat/
  parent-gone; child-ready/child-closed; `panel-event {name, payload}` (напр. открытие файла →
  родитель ре-эмитит в `AudioPage.handleExternalFileOpen`); close-panel (родитель → ребёнок).
- **Жизненный цикл detached (PW-D6):** переключение в detached открывает окно и убирает контент
  панели из главного; закрытие дочернего окна пользователем возвращает панель в **предыдущий
  не-detached режим** (prevMode) в главном окне; закрытие панели из главного закрывает ребёнка;
  при старте `open && mode=detached` → авто-reopen (блокировка → fallback floating).
- **Геометрия detached-окна (PW-D7):** персист rect (features `width/height/left/top` при
  открытии; ребёнок отслеживает resize + поллит screenX/Y и пишет `...-detached-rect`).
- **Размещение кода (PW-D8):** `MindWaveCore/ui/src/components/panel/` + алиас **`@panel`**
  (vite + tsconfig, по образцу `@protocol`) — модули импортируют контрол через алиас.

## 4. Фазы

- **Фаза 0** — план + леджер, owner-чекпоинт.
- **Фаза 1** — извлечение универсального `PanelWindow` (floating/docked, без новой
  функциональности) + `usePanelWindowState` + алиас `@panel`; FileOpenDialog переезжает на
  контрол (PanelWindow + FileOpenPanel). Поведение 1:1, регрессий нет.
- **Фаза 2** — detached-инфраструктура: route `/panel/:panelId` + PanelHostPage + `panels` в
  манифесте модуля; BroadcastChannel-мост (hello/heartbeat/self-close, события панели).
- **Фаза 3** — режим detached в PanelWindow: пункт dock-меню, `window.open`, prevMode/возврат,
  авто-reopen при старте, fallback при блокировке; события file-open через мост.
- **Фаза 4** — геометрия detached-окна (персист rect), заголовок/`document.title` дочернего окна,
  проверка в AppCore (default popup WebView2), полировка; owner-чекпоинт.

## 5. Верификация

- `bun run typecheck` (vue-tsc) + `bun run build` (quasar) в `MindWaveCore/ui` — на каждом шаге.
- Ручная проверка в браузере (dev): float/dock/detach/close-главного/F5-главного/reload-persist.
- Фаза 4: ручная проверка в AppCore (AppMain.exe): popup открывается, закрывается вместе с
  главным окном, геометрия восстанавливается.
