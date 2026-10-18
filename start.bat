@echo off
cd /d "%~dp0"
if not exist node_modules call npm install --omit=dev
start "" http://localhost:3737
npm start
