#!/bin/bash
# Psych Scribe — Build & Publish to GitHub Releases
# Usage: ./publish.sh [--skip-build]

set -e

cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
REPO="mae-cto-bot/psych-scribe-releases"
DMG="dist/Psych Scribe-${VERSION}-arm64.dmg"

echo "🧠 Psych Scribe Publisher"
echo "========================"
echo "Version: $TAG"
echo ""

# Check if release already exists
if gh release view "$TAG" --repo "$REPO" &>/dev/null; then
  echo "❌ Release $TAG already exists on GitHub."
  echo "   Bump the version in package.json first."
  exit 1
fi

# Build unless --skip-build
if [ "$1" != "--skip-build" ]; then
  echo "🔨 Building DMG..."
  npm run build:dmg
  echo ""
fi

# Verify DMG exists
if [ ! -f "$DMG" ]; then
  echo "❌ DMG not found: $DMG"
  exit 1
fi

SIZE=$(du -h "$DMG" | awk '{print $1}')
echo "📦 DMG: $DMG ($SIZE)"
echo ""

# Create GitHub release and upload DMG
echo "🚀 Publishing to GitHub..."
gh release create "$TAG" \
  --repo "$REPO" \
  --title "Psych Scribe $TAG" \
  --notes "Psych Scribe $TAG" \
  "$DMG"

echo ""
echo "✅ Published: https://github.com/$REPO/releases/tag/$TAG"
echo "📋 Users will see the update banner on next app launch."
