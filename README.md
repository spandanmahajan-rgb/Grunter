# Grunter

<img src="grunter/logo.png" width="96" alt="Grunter">

Grunter does the grunt work of ratio adapts. Pick a master key visual in Adobe Illustrator, mark where the subject is, choose your sizes, and Grunter builds each adapt as a new artboard in the same file.

## Install

1. Download `Grunter-<version>.zip` from the [Releases](../../releases) page and unzip it.
2. Drag `Grunter.app` to Applications.
3. The app is not notarized by Apple. The first time, right-click it, choose **Open**, then **Open** again. If macOS still refuses, run `xattr -cr /Applications/Grunter.app` once.
4. Open your file in Illustrator, then open Grunter. Allow it to control Illustrator when macOS asks.

Needs macOS 12 or later and Adobe Illustrator. Grunter adds artboards to the open file; **File > Revert** undoes a Make.

## Build from source

Needs only Apple's Command Line Tools.

```bash
cd grunter
./build.sh          # builds build/Grunter.app
./build.sh install  # also copies it to /Applications
./build.sh zip      # also packs build/Grunter-<version>.zip for a release
```

`adapt_maker.jsx` is the engine, run inside Illustrator by the app. The window is `grunter/index.html`, shown in a native shell (`grunter/mac/main.swift`).
