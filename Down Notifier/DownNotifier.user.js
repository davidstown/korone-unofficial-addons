// ==UserScript==
// @name         Down Notifier
// @namespace    cooper
// @description  Shows a The Cup video when Korone is down
// @version      1.0
// @match        https://www.pekora.zip/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CHECK_INTERVAL_MS = 60000;
    const VIDEO_URL = 'https://cdn.jsdelivr.net/gh/coopers1337/Dave-Blunts/TheCup.mp4';
    const OVERLAY_ID = 'pekora-down-overlay';
    const THEME_MARKER_ID = 'theme-2016-enabled';

    let overlayShown = false;

    function createOverlay() {
        if (document.getElementById(OVERLAY_ID)) return;

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        Object.assign(overlay.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            backgroundColor: 'rgba(0, 0, 0, 0.9)',
            zIndex: '2147483647',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
        });

        const videoWrapper = document.createElement('div');
        Object.assign(videoWrapper.style, {
            position: 'relative',
            maxWidth: '90vw',
            maxHeight: '80vh',
        });

        const video = document.createElement('video');
        Object.assign(video.style, {
            maxWidth: '90vw',
            maxHeight: '80vh',
            display: 'block',
        });
        video.src = VIDEO_URL;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.loop = true;

        videoWrapper.addEventListener('mouseenter', () => {
            video.muted = false;
        });

        const message = document.createElement('div');
        message.textContent = 'Korone is down';
        Object.assign(message.style, {
            color: '#fff',
            fontFamily: 'sans-serif',
            fontSize: '20px',
            marginBottom: '12px',
        });

        const hint = document.createElement('div');
        hint.textContent = 'Hover video for audio';
        Object.assign(hint.style, {
            color: '#aaa',
            fontFamily: 'sans-serif',
            fontSize: '13px',
            marginTop: '8px',
        });

        const closeButton = document.createElement('button');
        closeButton.textContent = 'Close';
        Object.assign(closeButton.style, {
            marginTop: '12px',
            padding: '8px 16px',
            fontSize: '14px',
            cursor: 'pointer',
        });
        closeButton.addEventListener('click', removeOverlay);

        videoWrapper.appendChild(video);
        overlay.appendChild(message);
        overlay.appendChild(videoWrapper);
        overlay.appendChild(hint);
        overlay.appendChild(closeButton);
        document.body.appendChild(overlay);

        video.play().catch(() => {
            const unlockPlayback = () => {
                video.play().catch(() => {});
                overlay.removeEventListener('click', unlockPlayback);
            };
            overlay.addEventListener('click', unlockPlayback, { once: true });
        });
    }

    function removeOverlay() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (overlay) overlay.remove();
        overlayShown = false;
    }

    function checkSite() {
        const down = !document.getElementById(THEME_MARKER_ID);
        if (down && !overlayShown) {
            overlayShown = true;
            createOverlay();
        } else if (!down && overlayShown) {
            removeOverlay();
        }
    }

    checkSite();
    setInterval(checkSite, CHECK_INTERVAL_MS);
})();
