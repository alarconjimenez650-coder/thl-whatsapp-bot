#!/usr/bin/env bash
set -e
if ! command -v node >/dev/null; then echo "Instala Node 18+ primero"; exit 1; fi
if ! [ -f .env ]; then cp .env.example .env && echo "Se creó .env a partir de .env.example (edítalo)"; fi
npm ci
npm start
