# Down Notifier

A userscript that plays **The Cup** video when **Korone (pekora.zip)** is down.

## Features

- Detects when Korone is down
- Shows a fullscreen overlay
- Plays **The Cup** video on loop
- Closes automatically when Korone is back
- Has a manual close button
- Hover over the video to unmute it

## How It Works

The script checks every **60 seconds** for the `theme-2016-enabled` element on the page.

- If it's **missing**, Korone is assumed to be down and the overlay appears.
- If it **comes back**, the overlay is removed automatically.

## Installation

1. Install **Violentmonkey** or **Tampermonkey**.
2. Open the userscript dashboard and create a new script.
3. Paste in the `DownNotifier.user.js` code.
4. Save it.

Runs automatically on:

```text
https://www.pekora.zip/*
```

## Usage

Nothing to configure.

- If Korone goes down, the overlay shows up on its own.
- Hover over the video for audio.
- Click **Close** to hide the overlay.
- If autoplay is blocked, click anywhere on the overlay to start the video.

## Permissions

None required:

```text
@grant none
```

## External Resources

* **GitHub** (stores the video file): https://github.com/coopers1337/Dave-Blunts/blob/main/TheCup.mp4
* **jsDelivr** (serves the video via CDN, pulling from the GitHub repo above): https://cdn.jsdelivr.net/gh/coopers1337/Dave-Blunts/TheCup.mp4

## Limitations

- Checks every 60 seconds, so detection isn't instant.
- Relies on the `theme-2016-enabled` element — if Korone's site changes, this may break.
- If jsDelivr or GitHub is down, the video won't load.

## Screenshots

![Down Notifier Preview](https://raw.githubusercontent.com/coopers1337/Down-Notifier/main/Down%20Notifier/Preview.png)
