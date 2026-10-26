// Hold OK to play at 2x speed while the button is held, then restore the
// previous speed on release. Mirrors the "press and hold the video" gesture
// from the YouTube mobile app. Works on the watch page and in Shorts.
//
// A short press is left completely untouched: we never intercept keydown, so
// the app's normal OK action (play/pause, controls, Shorts actions, ...) still
// runs. Only after the press passes the hold threshold do we start the 2x
// burst, and on release we swallow the keyup so the app cannot also act on it
// after the burst.

import { configRead, configChangeEmitter } from '../config.js';

const SETTING_KEY = 'enableLongPressSpeed';
const HOLD_MS = 400;
const HOLD_RATE = 2;

// Enter / Space — the OK button, matching the handling used elsewhere.
const OK_KEYCODES = { 13: true, 32: true };

// Elements that must receive OK themselves. If one is focused we do not turn
// the press into a 2x burst.
const INTERACTIVE_SELECTOR = [
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="menuitem"]',
    '[role="option"]', '[role="tab"]', '[role="checkbox"]',
    'ytlr-button', 'ytlr-icon-button', 'ytlr-toggle-button',
    'ytlr-text-box', 'ytlr-checkbox', 'ytlr-radio-button'
].join(',');

let holdTimer = null;
let holding = false;
let activeVideo = null;
let originalRate = null;

function getPlayer() {
    return document.querySelector('.html5-video-player');
}

function getVideo() {
    const main = document.querySelector('video.html5-main-video');
    if (main && (main.clientWidth > 0 || main.clientHeight > 0)) return main;

    // Shorts feeds can keep hidden preload videos around; prefer the largest
    // visible one so we never touch a background video.
    let best = null;
    let bestArea = -1;
    const videos = document.getElementsByTagName('video');
    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        const area = (video.clientWidth || 0) * (video.clientHeight || 0);
        if (area > bestArea) {
            bestArea = area;
            best = video;
        }
    }
    return best || main || document.querySelector('video');
}

function isShorts() {
    if (location.href.toLowerCase().indexOf('shorts') !== -1) return true;

    const player = getPlayer();
    if (!player || typeof player.getVideoStats !== 'function') return false;
    try {
        const stats = player.getVideoStats();
        const keys = Object.keys(stats || {});
        for (let i = 0; i < keys.length; i++) {
            if (stats[keys[i]] === 'shortspage') return true;
        }
    } catch (err) {}
    return false;
}

function isPlaybackRoute() {
    return location.href.indexOf('/watch') !== -1 || isShorts();
}

function focusedElement() {
    // The TV UI marks the focused element with .zylon-focus; fall back to the
    // real DOM focus where it is used instead.
    return document.querySelector('.zylon-focus') || document.activeElement;
}

function isPlayerFocused() {
    const focused = focusedElement();
    if (!focused || focused === document.body || focused === document.documentElement) {
        return true;
    }
    if (focused.tagName === 'VIDEO') return true;

    let interactive = false;
    try {
        interactive = focused.matches(INTERACTIVE_SELECTOR);
    } catch (err) {}

    if (interactive) return false;

    const player = getPlayer();
    return !!(player && (focused === player || player.contains(focused) ||
        focused.contains(player)));
}

function canStartHold(video) {
    if (!configRead(SETTING_KEY)) return false;
    if (!video || video.paused || video.ended) return false;
    if (!(video.clientWidth > 0 && video.clientHeight > 0)) return false;
    if (!isPlaybackRoute()) return false;
    if (!isPlayerFocused()) return false;
    return true;
}

function resumePlayback(video) {
    const player = getPlayer();
    try {
        if (player && typeof player.playVideo === 'function') {
            player.playVideo();
            return;
        }
    } catch (err) {}
    const promise = video.play();
    if (promise && promise.catch) promise.catch(() => {});
}

function engage() {
    holdTimer = null;
    const video = activeVideo;
    if (!video || !configRead(SETTING_KEY)) {
        reset();
        return;
    }

    originalRate = video.playbackRate || 1;
    holding = true;

    // If the app paused the video from the initial keydown, resume it so the
    // 2x burst is actually visible.
    if (video.paused) resumePlayback(video);

    try {
        video.playbackRate = HOLD_RATE;
    } catch (err) {}
}

function reset() {
    if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
    }
    holding = false;
    activeVideo = null;
    originalRate = null;
}

function release() {
    const video = activeVideo;
    const rate = originalRate;

    if (holding && video) {
        try {
            video.playbackRate = rate != null ? rate : (configRead('videoSpeed') || 1);
        } catch (err) {}
        if (video.paused) resumePlayback(video);
    }

    reset();
}

function onKeyDown(event) {
    if (!OK_KEYCODES[event.keyCode]) return;
    if (event.repeat) return;
    if (holding || holdTimer) return;

    const video = getVideo();
    if (!canStartHold(video)) return;

    activeVideo = video;
    holdTimer = setTimeout(engage, HOLD_MS);
}

function onKeyUp(event) {
    if (!OK_KEYCODES[event.keyCode]) return;
    if (!holdTimer && !holding) return;

    if (holding) {
        // Swallow the release so the app does not toggle playback after the
        // 2x burst (some builds act on keyup as well as keydown).
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }

    release();
}

function onKeyPress(event) {
    // Some remotes emit keypress for OK; swallow it while a burst is active.
    if (holding && OK_KEYCODES[event.keyCode]) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }
}

window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('keyup', onKeyUp, true);
window.addEventListener('keypress', onKeyPress, true);
window.addEventListener('blur', release);

configChangeEmitter.addEventListener('configChange', (event) => {
    if (event && event.detail && event.detail.key === SETTING_KEY) {
        release();
    }
});
