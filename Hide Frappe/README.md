# Hide Korone Game

A Tampermonkey script that hides specific games from the games list on pekora.zip (Korone). This was made because certain games started to annoy me.

By default it hides game `840249` (Frappe V4), but you can add or remove any game by ID from the Tampermonkey menu — no editing the script required.

## Why this exists

The game "Frappe" had started to piss me off and was a straight up eyesore to the games page in my eyes. I had to make something that was like the Hide Ragdoll Engine Button.

## Install

1. Get [Tampermonkey](https://www.tampermonkey.net/) if you don't already have it (works on Chrome, Firefox, Edge, Brave, etc.)
2. Click the Tampermonkey icon in your toolbar → **Create a new script**
3. Delete whatever placeholder code is in there and paste in the contents of `hide-korone-game.user.js`
4. Ctrl+S / Cmd+S to save

That's it, it'll start working next time you're on pekora.zip.

## Managing which games are hidden

Click the Tampermonkey icon while you're on any page and you'll see three commands under this script:

- **Hide a game by ID** — type in a game ID and it's gone
- **Unhide a game by ID** — brings one back
- **List hidden games** — shows what's currently hidden

The game ID is the number in the URL, e.g. `pekora.zip/games/840249/Frappe-V4` → the ID is `840249`.


## Known limitations

- If pekora.zip does a big frontend rewrite and changes how game cards are structured, this might stop working and need an update.
- Hidden games are stored per-browser (via Tampermonkey's storage), so they won't carry over if you use a different browser or computer.
