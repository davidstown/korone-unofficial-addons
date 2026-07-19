// ==UserScript==
// @name         Hide Frappe
// @namespace    https://pekora.zip/
// @version      1.0
// @description  Hides specific games from the pekora.zip/Korone games listing page (Hides Frappe by Default)
// @author       Dexed
// @match        *://*.pekora.zip/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'hiddenGameIds';
  const DEFAULT_HIDDEN_IDS = ['840249'];

  function getHiddenIds() {
    return GM_getValue(STORAGE_KEY, DEFAULT_HIDDEN_IDS);
  }

  function setHiddenIds(ids) {
    GM_setValue(STORAGE_KEY, ids);
  }

  function hideCardForLink(link, hiddenIds) {
    const match = link.getAttribute('href') && link.getAttribute('href').match(/^\/games\/(\d+)\//);
    if (!match) return;
    const gameId = match[1];
    if (!hiddenIds.includes(gameId)) return;

    let el = link;
    let card = null;
    for (let i = 0; i < 5 && el; i++) {
      if (el.tagName === 'LI' || (el.className && String(el.className).includes('gameCard'))) {
        card = el;
        break;
      }
      el = el.parentElement;
    }
    if (!card) card = link.parentElement || link;


    if (card.isConnected) {
      card.remove();
    }
  }

  function scanAndHide() {
    const hiddenIds = getHiddenIds();
    if (!hiddenIds.length) return;
    const links = document.querySelectorAll('a[href^="/games/"]');
    links.forEach((link) => hideCardForLink(link, hiddenIds));
  }


  scanAndHide();


  const observer = new MutationObserver(() => {
    scanAndHide();
  });
  observer.observe(document.body, { childList: true, subtree: true });


  function addGameId() {
    const id = prompt('Enter the game ID to hide (the number in /games/{id}/...):');
    if (!id) return;
    const trimmed = id.trim();
    if (!/^\d+$/.test(trimmed)) {
      alert('That doesn\'t look like a valid game ID (numbers only).');
      return;
    }
    const ids = getHiddenIds();
    if (!ids.includes(trimmed)) {
      setHiddenIds([...ids, trimmed]);
      alert(`Game ${trimmed} will now be hidden. Refresh the page if it's still visible.`);
      scanAndHide();
    } else {
      alert('That game is already hidden.');
    }
  }

  function removeGameId() {
    const ids = getHiddenIds();
    if (!ids.length) {
      alert('No games are currently hidden.');
      return;
    }
    const id = prompt(`Currently hidden: ${ids.join(', ')}\n\nEnter the game ID to unhide:`);
    if (!id) return;
    const trimmed = id.trim();
    if (!ids.includes(trimmed)) {
      alert('That ID isn\'t in the hidden list.');
      return;
    }
    setHiddenIds(ids.filter((x) => x !== trimmed));
    alert(`Game ${trimmed} unhidden. Refresh the page to see it again.`);
  }

  function listGameIds() {
    const ids = getHiddenIds();
    alert(ids.length ? `Hidden game IDs:\n${ids.join('\n')}` : 'No games are currently hidden.');
  }

  GM_registerMenuCommand('Hide a game by ID', addGameId);
  GM_registerMenuCommand('Unhide a game by ID', removeGameId);
  GM_registerMenuCommand('List hidden games', listGameIds);
})();
