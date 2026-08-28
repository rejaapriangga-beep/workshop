#!/bin/bash
set -e
cd ~/workshop-repo
echo "📥 Pulling latest..."
git fetch origin main
# reset --hard, bukan pull: checkout ini cuma dipakai untuk deploy, tidak pernah
# diedit manual, jadi selalu boleh disamakan persis dengan origin/main. Ini juga
# menghindari deploy gagal kalau ada perubahan lokal tak sengaja (mis. perubahan
# permission file) yang bikin git pull menolak merge.
git reset --hard origin/main
echo "📦 Installing dependencies..."
cd api && npm install --production
echo "🔄 Restarting API..."
pm2 restart workshop-api
echo "✅ Deploy selesai!"
