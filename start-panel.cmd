@echo off
rem Starts the tsps admin panel. Ctrl+C stops it and the servers it started.
cd /d "%~dp0"
title tsps admin
node src\server.mjs
