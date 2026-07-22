// ==UserScript==
// @name         Down Notifier
// @namespace    cooper
// @description  Shows a The Cup video when Korone is down
// @version      1.1
// @match        https://www.pekora.zip/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
    'use strict';
    const CHECK_INTERVAL_MS = 60000;
    const TIMEOUT_MS = 5000;
    const FAIL_THRESHOLD = 2;
    const VIDEO_URL = 'https://cdn.jsdelivr.net/gh/coopers1337/Dave-Blunts/TheCup.mp4';
    const OVERLAY_ID = 'pekora-down-overlay';
    let overlayShown = false;
    let failCount = 0;

    async function isSiteUp() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch('/apisite/users/v1/users/authenticated', {
                credentials: 'include',
                cache: 'no-store',
                signal: controller.signal,
            });
            return res.status === 200 || res.status === 401;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    function createOverlay() {
        if (document.getElementById(OVERLAY_ID)) return;
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            backgroundColor: 'rgba(0,0,0,0.9)', zIndex: '2147483647',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        });

        const video = document.createElement('video');
        Object.assign(video.style, { maxWidth: '90vw', maxHeight: '80vh', display: 'block' });
        video.src = VIDEO_URL;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.loop = true;
        video.addEventListener('mouseenter', () => { video.muted = false; });

        const message = document.createElement('div');
        message.textContent = 'Korone is down';
        Object.assign(message.style, { color: '#fff', fontFamily: 'sans-serif', fontSize: '20px', marginBottom: '12px' });

        const hint = document.createElement('div');
        hint.textContent = 'Hover video for audio';
        Object.assign(hint.style, { color: '#aaa', fontFamily: 'sans-serif', fontSize: '13px', marginTop: '8px' });

        const closeButton = document.createElement('button');
        closeButton.textContent = 'Close';
        Object.assign(closeButton.style, { marginTop: '12px', padding: '8px 16px', fontSize: '14px', cursor: 'pointer' });
        closeButton.addEventListener('click', removeOverlay);

        overlay.append(message, video, hint, closeButton);
        document.body.appendChild(overlay);
        video.play().catch(() => overlay.addEventListener('click', () => video.play().catch(() => {}), { once: true }));
    }

    function removeOverlay() {
        document.getElementById(OVERLAY_ID)?.remove();
        overlayShown = false;
    }

    async function checkSite() {
        const up = await isSiteUp();
        if (up) {
            failCount = 0;
            if (overlayShown) removeOverlay();
            return;
        }
        failCount++;
        if (failCount >= FAIL_THRESHOLD && !overlayShown) {
            overlayShown = true;
            createOverlay();
        }
    }

    checkSite();
    setInterval(checkSite, CHECK_INTERVAL_MS);
})();
