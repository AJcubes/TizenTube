// Hold OK to play at 2x speed while the button is held, then restore the
// previous speed on release. Mirrors the "press and hold" gesture from the
// YouTube mobile app. Works on the watch page and in Shorts.
//
// A short press is left completely untouched: we never intercept keydown, so
// the app's normal OK action (play/pause, controls, Shorts actions, ...) still
// runs. Only after the press passes the hold threshold do we start the 2x
// burst, and on release we swallow the keyup so the app cannot also act on it
// after the burst.

import { t } from 'i18next';
import { configRead, configChangeEmitter } from '../config.js';
import { showToast } from '../ui/ytUI.js';

const SETTING_KEY = 'enableLongPressSpeed';
const HOLD_MS = 400;
const HOLD_RATE = 2;

// Shorts swaps the playing video (and can reset its rate) when it loops or
// moves on. Re-apply the hold speed on a light interval so a fresh video
// keeps the burst instead of flipping between 1x and 2x — that flapping is
// what made the audio sound glitchy.
const REASSERT_MS = 250;

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
let reassertTimer = null;
let holding = false;

// Each entry is { video, rate } so release can restore every video we touched.
let activeVideos = [];

function getPlayer() {
    return document.querySelector('.html5-video-player');
}

function allVideos() {
    return Array.prototype.slice.call(document.getElementsByTagName('video'));
}

function isVisible(video) {
    return !!(video && ((video.clientWidth || 0) > 0 || (video.clientHeight || 0) > 0));
}

function currentRate(video) {
    const rate = Number(video && video.playbackRate);
    return (isFinite(rate) && rate > 0) ? rate : 1;
}

function scoreVideo(video) {
    let score = (video.clientWidth || 0) * (video.clientHeight || 0);

    // Prefer the YouTube main video, but only when it is actually on screen;
    // Shorts can keep hidden preload videos around.
    if (score > 0 && video.classList &&
        video.classList.contains('html5-main-video')) {
        score += 1000000000;
    }
    // Prefer whatever is actually playing/audible over a paused preload.
    if (!video.paused && !video.ended) score += 1000000;
    if (video.muted) score -= 100000;
    if (!video.currentSrc && !video.src) score -= 10000000;

    return score;
}

// Every visible video that is actually playing, so a Shorts transition cannot
// leave one Short at 2x and the next at 1x. Falls back to the best visible
// video when nothing is playing.
function getTargetVideos() {
    const videos = allVideos();
    const playing = [];
    let best = null;
    let bestScore = -Infinity;

    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        if (!isVisible(video)) continue;

        if (!video.paused && !video.ended && (video.readyState || 0) >= 2) {
            playing.push(video);
        }

        const score = scoreVideo(video);
        if (score > bestScore) {
            bestScore = score;
            best = video;
        }
    }

    if (playing.length) return playing;
    return best ? [best] : [];
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

function isInsideVideoContainer(video, element) {
    if (!video || !element) return false;

    // Focus may sit on the video itself, on a container above it (the whole
    // Shorts row) or on something inside it.
    if (element === video || element.contains(video)) return true;

    let node = video;
    while (node && node !== document.body) {
        if (node.contains && node.contains(element)) return true;
        node = node.parentElement;
    }
    return false;
}

function isPlayerFocused(video) {
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

    // The Shorts feed renders its video controls outside the player container,
    // so accept any non-interactive focus that shares the video's container.
    if (isShorts() && video && isInsideVideoContainer(video, focused)) {
        return true;
    }

    const player = getPlayer();
    return !!(player && (focused === player || player.contains(focused) ||
        focused.contains(player)));
}

function canStartHold() {
    if (!configRead(SETTING_KEY)) return false;
    if (!isPlaybackRoute()) return false;

    const videos = getTargetVideos();
    if (!videos.length) return false;

    // Require a visible video that is actually playing right now.
    let playing = false;
    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        if (!video.paused && !video.ended && (video.readyState || 0) >= 2) {
            playing = true;
            break;
        }
    }
    if (!playing) return false;

    return isPlayerFocused(videos[0]);
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

function setRate(video, rate) {
    if (!video) return;
    if (Math.abs(currentRate(video) - rate) < 0.01) return;
    try {
        video.playbackRate = rate;
    } catch (err) {}
}

// The app (and speedUI's canplay handler) resets playbackRate on Shorts
// transitions. Correct it the instant it changes instead of waiting for the
// next tick, otherwise the burst audibly dips to 1x for up to REASSERT_MS.
function onRateChange(event) {
    if (!holding) return;
    const video = event.currentTarget;
    if (!video || !document.contains(video) || video.ended) return;
    if (Math.abs(currentRate(video) - HOLD_RATE) < 0.01) return;
    setRate(video, HOLD_RATE);
}

function trackVideo(video, rate) {
    activeVideos.push({ video: video, rate: rate });
    video.addEventListener('ratechange', onRateChange);
}

function untrackAll() {
    for (let i = 0; i < activeVideos.length; i++) {
        const video = activeVideos[i].video;
        if (video && video.removeEventListener) {
            video.removeEventListener('ratechange', onRateChange);
        }
    }
    activeVideos = [];
}

function applyHoldRate() {
    for (let i = 0; i < activeVideos.length; i++) {
        const entry = activeVideos[i];
        if (!entry.video || !document.contains(entry.video)) continue;
        if (entry.video.ended) continue;
        setRate(entry.video, HOLD_RATE);
    }
}

// Take over videos that appeared after the hold started (a newly loaded
// Short) without losing the originals we still need to restore.
function adoptTargets() {
    const videos = getTargetVideos();
    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        let known = false;
        for (let j = 0; j < activeVideos.length; j++) {
            if (activeVideos[j].video === video) {
                known = true;
                break;
            }
        }
        if (!known) {
            trackVideo(video, currentRate(video));
        }
    }
}

// A new Short starting mid-hold is picked up immediately (media events do
// not bubble, but a capture listener on document still sees them).
function onPlay(event) {
    if (!holding) return;
    const video = event.target;
    if (!video || video.tagName !== 'VIDEO' || !isVisible(video)) return;
    adoptTargets();
    applyHoldRate();
}

function stopReassert() {
    if (reassertTimer) {
        clearInterval(reassertTimer);
        reassertTimer = null;
    }
}

function startReassert() {
    stopReassert();
    reassertTimer = setInterval(function () {
        if (!holding) return;

        if (!configRead(SETTING_KEY)) {
            release();
            return;
        }

        adoptTargets();
        applyHoldRate();
    }, REASSERT_MS);
}

function resetState() {
    if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
    }
    stopReassert();
    holding = false;
    untrackAll();
}

function notify(on) {
    try {
        if (on) {
            showToast(t('player.playbackSpeed.holdOn'),
                t('player.playbackSpeed.holdOnSubtitle'));
        } else {
            showToast(t('player.playbackSpeed.holdOff'),
                t('player.playbackSpeed.holdOffSubtitle'));
        }
    } catch (err) {}
}

function engage() {
    holdTimer = null;
    if (!configRead(SETTING_KEY)) {
        resetState();
        return;
    }

    const videos = getTargetVideos();
    if (!videos.length) {
        resetState();
        return;
    }

    untrackAll();
    for (let i = 0; i < videos.length; i++) {
        trackVideo(videos[i], currentRate(videos[i]));
    }
    holding = true;

    // If the app paused the video from the initial keydown, resume it so the
    // 2x burst is actually visible.
    for (let i = 0; i < videos.length; i++) {
        if (videos[i].paused) resumePlayback(videos[i]);
    }

    applyHoldRate();
    startReassert();
    notify(true);
}

function release() {
    const wasHolding = holding;
    const entries = activeVideos;

    // Stop re-asserting before restoring, otherwise the interval would fight
    // the restore for a tick.
    holding = false;
    stopReassert();

    for (let i = 0; i < entries.length; i++) {
        const video = entries[i].video;
        if (!video || !document.contains(video)) continue;

        setRate(video, entries[i].rate);
        // Only resume a video that is still on screen. A prior Short left
        // hidden by a transition must not start playing again alongside the
        // current one.
        if (video.paused && !video.ended && isVisible(video)) {
            resumePlayback(video);
        }
    }

    resetState();

    if (wasHolding) notify(false);
}

function onKeyDown(event) {
    if (!OK_KEYCODES[event.keyCode]) return;
    if (event.repeat) return;
    if (holding || holdTimer) return;
    if (!canStartHold()) return;

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
document.addEventListener('play', onPlay, true);

configChangeEmitter.addEventListener('configChange', (event) => {
    if (event && event.detail && event.detail.key === SETTING_KEY) {
        release();
    }
});
