#!/bin/bash
# Builds Grunter.app into grunter/build/. Needs only Apple's Command Line Tools (swiftc).
#   ./build.sh            build
#   ./build.sh install    build, then copy to /Applications
#   ./build.sh dmg        build, then make build/Grunter.dmg for a GitHub release (a fixed name keeps the /releases/latest/download/ link stable)
set -euo pipefail
cd "$(dirname "$0")"
APP="build/Grunter.app"
VERSION="0.1.4"

[ -f tests/run.js ] && node tests/run.js   # engine geometry checks (kept out of the public repo); stop here if they fail
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp Grunter.icns "$APP/Contents/Resources/Grunter.icns"
cp FONT-LICENSE.txt "$APP/Contents/Resources/FONT-LICENSE.txt"   # the page embeds Host Grotesk (SIL OFL): its license travels with it

swiftc -O -target arm64-apple-macos12.0 -framework Cocoa -framework WebKit mac/main.swift -o build/Grunter-arm64
swiftc -O -target x86_64-apple-macos12.0 -framework Cocoa -framework WebKit mac/main.swift -o build/Grunter-x86_64
lipo -create build/Grunter-arm64 build/Grunter-x86_64 -output "$APP/Contents/MacOS/Grunter"
rm build/Grunter-arm64 build/Grunter-x86_64

cp index.html "$APP/Contents/Resources/web/index.html"
cp ../adapt_maker.jsx "$APP/Contents/Resources/adapt_maker.jsx"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Grunter</string>
  <key>CFBundleDisplayName</key><string>Grunter</string>
  <key>CFBundleIdentifier</key><string>com.grunter.app</string>
  <key>CFBundleIconFile</key><string>Grunter</string>
  <key>CFBundleExecutable</key><string>Grunter</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Grunter controls Adobe Illustrator to read your master and build the adapts.</string>
  <key>NSHumanReadableCopyright</key><string>Grunter</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" >/dev/null   # ad-hoc signature so macOS will run it on this Mac
echo "Built $APP"

if [ "${1:-}" = "install" ]; then
  rm -rf "/Applications/Adapter.app" "/Applications/Grunter.app" && cp -R "$APP" /Applications/ && echo "Installed to /Applications/Grunter.app"
fi

if [ "${1:-}" = "dmg" ]; then
  STAGE="build/dmg"; rm -rf "$STAGE" build/Grunter.dmg; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/" && cp FONT-LICENSE.txt "$STAGE/" && ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "Grunter" -srcfolder "$STAGE" -format UDZO build/Grunter.dmg && rm -rf "$STAGE" && echo "Packed build/Grunter.dmg"
fi
