#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
NODE_PATH=$(command -v node)
export CLANG_MODULE_CACHE_PATH="$ROOT/macos/.build/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/macos/.build/module-cache"
swift build --package-path macos -c release --disable-sandbox
APP="$ROOT/dist/Codex Gateway.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/backend/src"
cp macos/.build/release/GatewayBar "$APP/Contents/MacOS/GatewayBar"
cp src/*.mjs "$APP/Contents/Resources/backend/src/"
swiftc -module-cache-path "$ROOT/macos/.build/module-cache" macos/Sources/GatewayBar/AccountGlyph.swift macos/Tools/GenerateIcon.swift -o macos/.build/generate-icon
macos/.build/generate-icon "$ROOT/macos/.build/AppIcon.iconset"
iconutil -c icns "$ROOT/macos/.build/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>GatewayBar</string>
<key>CFBundleIdentifier</key><string>local.codex-gateway.menubar</string>
<key>CFBundleName</key><string>Codex Gateway</string>
<key>CFBundleDisplayName</key><string>Codex Gateway</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
/usr/libexec/PlistBuddy -c "Add :GatewayNodePath string $NODE_PATH" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
printf '%s\n' "$APP"
