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
npm run package
```

Результат — `release/OMP-IDE/`: самодостаточная папка с `OMP IDE.exe`,
которую можно перенести куда угодно и запустить без установки.
Никакой сети и electron-builder не нужно — используется локальный
Electron из `node_modules`.

Чтобы поделиться сборкой, просто заархивируйте папку `release/OMP-IDE`.

## Структура

```
src/main/      главный процесс (fs, pty, git, поиск, omp, remote, models)
src/preload/   contextBridge API
src/renderer/  UI (Monaco, xterm)
src/shared/    общие типы
build.mjs      esbuild-сборка (main/preload/renderer/workers)
package.mjs    сборка портативного дистрибутива
```
