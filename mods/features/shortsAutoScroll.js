// Automatically moves to the next Short once the current one finishes.
//
// Shorts loop instead of firing "ended", and the page can stop reporting that
// the Shorts feed is open right after navigating between Shorts. Shorts mode
// is therefore sticky, and the end of a Short is detected from several
// independent signals: a loop back to the start, a player-reported end, the
// playhead reaching the end, or an end screen that stops the playhead.

import { configRead, configChangeEmitter } from '../config.js';
import { onPlayer } from '../utils/Player.js';

const SETTING_KEY = 'enableShortsAutoScroll';
const ARROW_DOWN_KEYCODE = 40;

const POLL_INTERVAL_MS = 350;
const RETRY_DELAY_MS = 2000;
const SLOW_RETRY_DELAY_MS = 4000;
const FAST_RETRY_LIMIT = 5;
const NEAR_END_SECONDS = 0.35;
const REWIND_SECONDS = 0.8;
const FROZEN_EPSILON_SECONDS = 0.05;
const FROZEN_END_MS = 1200;
const FROZEN_END_WINDOW_SECONDS = 5;
const SHORTS_MAX_SECONDS = 200;
const SHORTS_IDLE_TIMEOUT_MS = 600000;
const MANUAL_NAV_GUARD_MS = 2500;

const NAV_KEYCODES = { 38: true, 40: true };

let player = null;

// Sticky once the Shorts feed is seen; the page may stop reporting it after
// navigating between Shorts.
let shortsMode = false;
let lastShortsSignal = 0;

// State for the Short that is currently on screen.
let lastId = null;
let lastTime = 0;
let pressedId = null;
let lastPressTime = 0;
let attempts = 0;
let frozenSince = 0;
let frozenAtTime = 0;
let lastManualNavTime = 0;

function getPlayer() {
    if (!player || !document.contains(player)) {
        player = document.querySelector('.html5-video-player');
    }
    return player;
}

function getVideo(pl) {
    // Pick the largest visible video so a hidden preload or ad cannot be
    // mistaken for the Short that is on screen.
    let best = null;
    let bestScore = -1;
    const videos = document.getElementsByTagName('video');
    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        const area = (video.clientWidth || 0) * (video.clientHeight || 0);
        let score = area;
        // Prefer the YouTube main video, but only when it is actually on
        // screen; otherwise a hidden player would shadow the Short.
        if (area > 0 && video.classList &&
            video.classList.contains('html5-main-video')) {
            score += 1000000000;
        }
        if (!video.currentSrc && !video.src) score -= 1000000;
        if (score > bestScore) {
            bestScore = score;
            best = video;
        }
    }
    if (best && bestScore > 0) return best;
    try {
        return pl.querySelector('video.html5-main-video') ||
            pl.querySelector('video');
    } catch (err) {
        return null;
    }
}

function hasShortsSignal(pl) {
    if (location.href.toLowerCase().indexOf('shorts') !== -1) return true;

    try {
        const stats = pl.getVideoStats();
        if (!stats) return false;
        const keys = Object.keys(stats);
        for (let i = 0; i < keys.length; i++) {
            if (stats[keys[i]] === 'shortspage') return true;
        }
    } catch (err) {}

    return false;
}

function updateShortsMode(pl, video, now) {
    if (hasShortsSignal(pl)) {
        shortsMode = true;
        lastShortsSignal = now;
        return true;
    }

    if (!shortsMode) return false;

    const currentTime = video ? (video.currentTime || 0) : 0;
    const duration = video ? video.duration : NaN;

    // Strong evidence that a regular, long video is playing: leave Shorts
    // mode so normal videos never auto-advance.
    if (isFinite(duration) && duration > SHORTS_MAX_SECONDS &&
        currentTime > 5) {
        shortsMode = false;
        return false;
    }

    // The app left the player entirely for a long time.
    if (!video && now - lastShortsSignal > SHORTS_IDLE_TIMEOUT_MS) {
        shortsMode = false;
        return false;
    }

    return true;
}

function getVideoId(pl) {
    try {
        const data = pl.getVideoData();
        if (data && data.video_id) return data.video_id;
    } catch (err) {}
    return null;
}

function getId(video, videoId) {
    const src = video ? (video.currentSrc || video.src || '') : '';
    // Combine every signal we have: if either the video id or the media URL
    // changes, the feed moved to another Short.
    return (videoId || '') + '|' + src;
}

function getPlayerState(pl) {
    try {
        return pl.getPlayerStateObject() || null;
    } catch (err) {
        return null;
    }
}

function hasPlayerEnded(state) {
    return !!(state && (state.isEnded === true || state.playerState === 0));
}

function pressArrowDown() {
    ['keydown', 'keyup'].forEach(function (type) {
        try {
            const event = document.createEvent('Event');
            event.initEvent(type, true, true);
            event.keyCode = ARROW_DOWN_KEYCODE;
            event.which = ARROW_DOWN_KEYCODE;
            event.key = 'ArrowDown';
            event.code = 'ArrowDown';
            document.dispatchEvent(event);
        } catch (err) {}
    });
}

function retryDelay() {
    return attempts < FAST_RETRY_LIMIT ?
        RETRY_DELAY_MS : SLOW_RETRY_DELAY_MS;
}

function resetState() {
    lastId = null;
    lastTime = 0;
    pressedId = null;
    lastPressTime = 0;
    attempts = 0;
    frozenSince = 0;
    frozenAtTime = 0;
}

function check() {
    try {
        checkInner();
    } catch (err) {
        // A failed check must never stop the watchdog.
    }
}

function checkInner() {
    if (!configRead(SETTING_KEY)) {
        // Keep sticky Shorts mode while disabled. The page can stop
        // reporting that the feed is open, so forgetting it here would make
        // turning the setting off and on unable to re-arm inside the feed.
        resetState();
        return;
    }

    const pl = getPlayer();
    if (!pl) {
        resetState();
        return;
    }

    const video = getVideo(pl);
    const now = Date.now();

    if (!updateShortsMode(pl, video, now)) {
        resetState();
        return;
    }

    if (!video) return;

    const currentTime = video.currentTime || 0;
    const duration = video.duration;
    const durationKnown = isFinite(duration) && duration > 0;
    const videoId = getVideoId(pl);
    const id = getId(video, videoId);

    // The feed moved to another Short: our press worked, the user scrolled,
    // or the feed moved on by itself. Re-arm for the new Short.
    if (id !== lastId) {
        lastId = id;
        lastTime = currentTime;
        pressedId = null;
        lastPressTime = 0;
        attempts = 0;
        frozenSince = 0;
        frozenAtTime = 0;
        return;
    }

    // Shorts loop back to the start instead of firing "ended".
    const rewound = lastTime > REWIND_SECONDS &&
        currentTime + REWIND_SECONDS < lastTime;

    // Native end, player-reported end, or the playhead at the very end.
    const state = getPlayerState(pl);
    const ended = video.ended === true || hasPlayerEnded(state);
    const nearEnd = durationKnown && currentTime >= duration - NEAR_END_SECONDS;

    // A frozen end screen: the playhead stopped moving near the end. This
    // covers end cards that pause the video without reporting "ended".
    let frozenAtEnd = false;
    if (durationKnown && currentTime > 1 &&
        currentTime >= duration - FROZEN_END_WINDOW_SECONDS) {
        if (frozenSince === 0 ||
            Math.abs(currentTime - frozenAtTime) > FROZEN_EPSILON_SECONDS) {
            frozenSince = now;
            frozenAtTime = currentTime;
        } else if (now - frozenSince >= FROZEN_END_MS) {
            frozenAtEnd = true;
        }
    } else {
        frozenSince = 0;
        frozenAtTime = 0;
    }

    const finished = ended || rewound || nearEnd || frozenAtEnd;

    lastTime = currentTime;

    if (!finished) return;

    // The user just pressed a navigation key. Never mistake their manual
    // scroll for the end of a Short.
    if (now - lastManualNavTime < MANUAL_NAV_GUARD_MS) return;

    if (pressedId === id) {
        // Already advancing this Short; retry on a delay so we don't spam
        // keys while the feed is switching.
        if (now - lastPressTime >= retryDelay()) {
            attempts += 1;
            lastPressTime = now;
            pressArrowDown();
        }
    } else {
        pressedId = id;
        attempts = 1;
        lastPressTime = now;
        pressArrowDown();
    }
}

onPlayer(function (pl) {
    player = pl;
    try {
        pl.addEventListener('onStateChange', check);
    } catch (err) {}
});

// Media events do not bubble, so listen in the capture phase.
function onMediaEvent(event) {
    if (event.target && event.target.tagName === 'VIDEO') check();
}
document.addEventListener('timeupdate', onMediaEvent, true);
document.addEventListener('ended', onMediaEvent, true);
document.addEventListener('playing', onMediaEvent, true);
document.addEventListener('pause', onMediaEvent, true);
document.addEventListener('seeking', onMediaEvent, true);
document.addEventListener('seeked', onMediaEvent, true);

// Real remote presses are trusted; our synthetic ones are not.
document.addEventListener('keydown', function (event) {
    if (!event || !event.isTrusted) return;
    const keyCode = event.keyCode || event.which;

    if (NAV_KEYCODES[keyCode]) {
        lastManualNavTime = Date.now();
    }

    // Back left the feed; re-arm once the feed signals Shorts again.
    if (keyCode === 27 || keyCode === 403 || keyCode === 461 ||
        keyCode === 10009) {
        shortsMode = false;
        lastShortsSignal = 0;
        lastManualNavTime = Date.now();
    }
}, true);

configChangeEmitter.addEventListener('configChange', function (event) {
    if (event && event.detail && event.detail.key === SETTING_KEY) {
        // Cancel any press in flight, but keep sticky Shorts mode so that
        // toggling the setting does not require a fresh Shorts signal.
        resetState();
    }
});

setInterval(check, POLL_INTERVAL_MS);
