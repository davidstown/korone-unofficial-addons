# Addon Submission

## Addon Information

**Addon Name:** Korone Dynamic Background Changer

**Your Discord User ID:** 921390106844217375

**Your Korone Profile URL:** https://www.pekora.zip/users/18205/profile

## Detailed Description

**What the addon is:**
Korone Dynamic Background Changer is an unofficial userscript that brings full background customization to korone.zip and pekora.zip via an in-page control panel.

**What the addon does:**
- Allows users to set a custom background wallpaper using local image file uploads or image URLs.
- Provides image fitting options (Cover with zoom up to 250%, Stretch to Fill, and Letterboxed Contain).
- Features alignment controls (Top, Center, Bottom, Left, Right) and custom letterbox border fill colors.
- Includes 4 selectable UI themes for the panel (Korone Brown, Light, Dark, and Custom Color picker).
- Saves preferences automatically so settings persist across page reloads.

**How it works:**
- Settings are saved in `localStorage`.
- Custom styles are applied via dynamically injected CSS with high specificity to override native page themes.
- A `MutationObserver` watches the DOM to prevent page re-renders from stripping the background.
- Built-in path detection checks the current URL and automatically disables custom backgrounds on `/internal` pages to prevent UI rendering glitches.

**Why it is useful:**
It offers users a simple, built-in way to personalize their site experience directly on the page without needing third-party style extensions or custom CSS managers.

**External APIs or third-party services:**
None. The script operates entirely standalone and processes all image configurations and settings locally.

**Permissions required:**
Uses `@grant none`. Relies only on standard browser features: `localStorage`, `FileReader`, `MutationObserver`, and standard DOM manipulation.

**Warnings, limitations or disclaimers:**
- Unofficial addon; not affiliated with or supported by Korone/Pekora.
- High-resolution local uploads store base64 strings in `localStorage`, which uses a small portion of local browser storage.
- Custom backgrounds are intentionally suppressed on `/internal` views.
- External image URLs that block hotlinking or cross-origin requests may display blank.

## Submission Checklist

You must check every applicable box before submitting this pull request.

* [x] I confirm that I have read the repository `[README.md](https://github.com/davidstown/korone-unofficial-addons/blob/main/README.md)` in full.
* [x] I confirm that my addon follows all addon guidelines and submission requirements.
* [x] I confirm that my addon contains exactly one JavaScript userscript file.
* [x] I confirm that my addon includes a complete `README.md`.
* [x] I confirm that my addon is fully open source and contains no obfuscated code.
* [x] I confirm that this addon is my original work and is not copied, stolen or “skidded”.
* [x] I have disclosed every external API, third-party service and permission used by the addon.
* [x] I confirm that the addon does not contain malicious, deceptive, privacy-invasive or harmful functionality.
* [x] I understand that submitting malicious code or intentionally violating the guidelines may result in the rejection or removal of my addon and punishment on Korone.
* [x] I understand that approval does not make my addon official or officially supported by Korone.
* [x] I agree to create the required post in the `#unofficial-addons` Discord forum if my addon is approved.
* [x] I did not blindly check every box without reading and understanding each statement.

## Additional Information

**Screenshots:**
- Preview screenshot
- <img width="259" height="543" alt="Preview" src="https://github.com/user-attachments/assets/dd9f7fa6-1570-4d86-b0a1-0a1b2222d3ce" />


**Testing Information:**
Tested via Violentmonkey on Chromium and Firefox browsers across `korone.zip` and `pekora.zip`.
Verified features:
- File upload vs URL input rendering.
- Fit mode switching, zoom adjustment (100%-250%), and alignment positioning.
- UI theme changing (Korone, Light, Dark, Custom Color).
- Storage persistence across page reloads.
- Auto-removal of custom background styling on `/internal` sub-pages.
- Reset to default settings.

**Known Issues:**
- High-resolution image conversions to base64 may take a brief moment.
- External URLs with strict CORS/hotlinking restrictions will fail to render the image.
