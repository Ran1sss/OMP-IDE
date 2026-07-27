# OMP IDE

Desktop IDE for the Oh My Pi agent harness. Electron + Monaco + xterm.

## Требования

- Node.js 20+
- Windows x64 (сборка портативной версии настроена под win32-x64)

## Разработка

```sh
npm install
npm start        # сборка + запуск electron
npm run build    # только сборка (esbuild -> dist/)
npm run typecheck
```

## Портативная сборка

```sh
npm run package                          # userData в %APPDATA%\OMP IDE
node build.mjs && node package.mjs --portable   # userData в ./data рядом с exe
```

Результат — `release/OMP-IDE/`: самодостаточная папка с `OMP IDE.exe`,
которую можно перенести куда угодно и запустить без установки.
Никакой сети и electron-builder не нужно — используется локальный
Electron из `node_modules`.

С флагом `--portable` в сборку кладётся маркер `.portable`: все настройки,
токены и кэши хранятся в `./data` рядом с exe — такую папку можно
заархивировать и отдать другому человеку (удалив `data`, если успели
поработать в ней).

## Структура

```
src/main/      главный процесс (fs, pty, git, поиск, omp, remote, models)
src/preload/   contextBridge API
src/renderer/  UI (Monaco, xterm)
src/shared/    общие типы
build.mjs      esbuild-сборка (main/preload/renderer/workers)
package.mjs    сборка портативного дистрибутива
```
