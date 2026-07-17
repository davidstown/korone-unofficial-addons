# Down Notifier

A userscript that plays The Cup video whenever **Korone (pekora.zip)** is down.

## Features

- Detects when Korone is down
- Fullscreen overlay
- Plays **The Cup** video
- Automatically closes when Korone comes back
- Close button
- Hover over the video to enable audio

## How it works

The script checks every **60 seconds** for the `theme-2016-enabled` element.

- If the element is missing, it assumes Korone is down and shows the overlay.
- If the element returns, the overlay is automatically removed.

## Installation

1. Install **Violentmonkey** or **Tampermonkey**.
2. Create a new userscript.
3. Paste the `DownNotifier.user.js` code.
4. Save the script.

The addon automatically runs on:

```text
https://www.pekora.zip/*
```

## Usage

Nothing to configure.

If Korone goes down, the overlay will appear automatically.

- Hover over the video to unmute it.
- Click **Close** to hide the overlay.
- If autoplay is blocked, click anywhere on the overlay to start the video.

## Permissions

This userscript requires no special permissions.

```
@grant none
```

## External Resources

This addon loads one external file:

- **TheCup.mp4**
- Hosted on **jsDelivr**
- Source: https://github.com/coopers1337/Dave-Blunts

## Limitations

- Checks every **60 seconds**, so detection is not instant.
- Detection relies on the `theme-2016-enabled` element.
- If Korone changes its website, the detector may stop working.
- If jsDelivr or GitHub is unavailable, the video may not load.

## Screenshots

![Down Notifier Preview](https://raw.githubusercontent.com/coopers1337/Down-Notifier/main/Down%20Notifier/Preview.png)
