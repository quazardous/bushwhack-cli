@echo off
rem Windows counterpart of bin/bushwhack: runs the TypeScript sources directly, from any folder.
setlocal
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "TSX=%ROOT:\=/%/node_modules/tsx/dist/esm/index.mjs"
node --conditions=bushwhack-src --import "file:///%TSX%" "%ROOT%\packages\daemon\src\cli.ts" %*
