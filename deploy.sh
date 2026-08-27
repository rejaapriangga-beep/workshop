#!/bin/bash
set -e
cd ~/workshop-repo
echo "📥 Pulling latest..."
git pull
echo "📦 Installing dependencies..."
cd api && npm install --production
echo "🔄 Restarting API..."
pm2 restart workshop-api
echo "✅ Deploy selesai!"
