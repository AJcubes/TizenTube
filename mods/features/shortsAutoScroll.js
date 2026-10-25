// Automatically moves to the next Short once the current one finishes.

import { configRead, configChangeEmitter } from '../config.js';
import { onPlayer } from '../utils/Player.js';

const SETTING_KEY = 'enableShortsAutoScroll';
const ARROW_DOWN_KEYCODE = 40;

// Shorts normally loop, so no "ended" event fires. Some Shorts stop on an end
// screen instead, which also stops "timeupdate". A watchdog keeps this working
// in both cases, and retries if the navigation key was not handled.
const POLL_INTERVAL_MS = 400;
const RETRY_DELAY_MS = 1600;
const SLOW_RETRY_DELAY_MS = 4000;
const FAST_RETRY_LIMIT = 6;
const END_EPSILON_SECONDS = 1.5;
const STUCK_AT_END_SECONDS = 0.3;
const STUCK_AT_END_MS = 1000;
const REWIND_EPSILON_SECONDS = 1.0;
const MANUAL_NAV_GUARD_MS = 1200;

let player = null;

// State for the Short that is currently on screen.
let shortId = null;
let lastTime = 0;
let advancing = false;
let attempts = 0;
let lastAttemptTime = 0;
let stuckSince = 0;
let stuckAtTime = 0;
let lastManualNavTime = 0;

function getPlayer() {
    if (!player || !document.contains(player)) {
        player = document.querySelector('.html5-video-player');
    }
    return player;
}

function getVideo(pl) {
    let video = null;
    try {
        video = pl.querySelector('video.html5-main-video');
    } catch (err) {}
    if (!video) video = pl.querySelector('video');
    if (!video) video = document.querySelector('video');
    return video;
}

function isShorts(pl) {
    // The route is the most stable signal; player stats can be missing or
    // change while the Shorts feed is open.
    if (location.href.indexOf('/shorts') !== -1) return true;

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

function getShortId(pl, video) {
    let videoId = null;
    try {
        const data = pl.getVideoData();
        if (data && data.video_id) videoId = data.video_id;
    } catch (err) {}

    const src = video ? (video.currentSrc || video.src || '') : '';

    // If either value changes, the feed moved to another Short.
    if (videoId && src) return videoId + '|' + src;
    return videoId || src || null;
}

function isPlayerEnded(pl) {
    try {
        const state = pl.getPlayerStateObject();
        return !!(state && state.isEnded);
    } catch (err) {
        return false;
    }
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

function resetState(id, currentTime) {
    shortId = id;
    lastTime = currentTime || 0;
    advancing = false;
    attempts = 0;
    lastAttemptTime = 0;
    stuckSince = 0;
    stuckAtTime = 0;
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
        resetState(null, 0);
        return;
    }

    const pl = getPlayer();
    if (!pl) return;

    const video = getVideo(pl);
    if (!video) return;

    if (!isShorts(pl)) {
        resetState(null, 0);
        return;
    }

    const now = Date.now();
    const id = getShortId(pl, video);
    const currentTime = video.currentTime || 0;
    const duration = video.duration;

    // A different Short is showing: we advanced successfully, the user
    // scrolled, or the feed moved on. Re-arm for the new one.
    if (id !== shortId) {
        resetState(id, currentTime);
        return;
    }

    // The user just pressed a navigation key. Re-arm and never mistake their
    // manual scroll for the end of a Short.
    if (now - lastManualNavTime < MANUAL_NAV_GUARD_MS) {
        resetState(id, currentTime);
        return;
    }

    const hasDuration = isFinite(duration) && duration > 1;
    const nearEnd = hasDuration &&
        currentTime >= duration - END_EPSILON_SECONDS;
    const rewound = lastTime > REWIND_EPSILON_SECONDS &&
        currentTime + REWIND_EPSILON_SECONDS < lastTime;
    const lastWasAtEnd = hasDuration &&
        lastTime >= duration - END_EPSILON_SECONDS;

    // Shorts loop back to the start instead of firing "ended".
    const wrapped = rewound && lastWasAtEnd;

    // Native end, player-reported end, or a frozen end screen.
    const ended = video.ended === true || isPlayerEnded(pl);

    let stuckAtEnd = false;
    if (hasDuration && nearEnd && currentTime >= duration - STUCK_AT_END_SECONDS) {
        if (stuckSince === 0 || Math.abs(currentTime - stuckAtTime) > 0.05) {
            stuckSince = now;
            stuckAtTime = currentTime;
        } else if (now - stuckSince >= STUCK_AT_END_MS) {
            stuckAtEnd = true;
        }
    } else {
        stuckSince = 0;
        stuckAtTime = 0;
    }

    const finished = ended || wrapped || stuckAtEnd;

    lastTime = currentTime;

    if (!finished) {
        // Playback is running again (or was replayed); wait for the next real
        // ending instead of sending more keys.
        if (advancing) {
            advancing = false;
            attempts = 0;
            lastAttemptTime = 0;
        }
        return;
    }

    if (!advancing) {
        advancing = true;
        attempts = 0;
        lastAttemptTime = 0;
    }

    const retryDelay = attempts < FAST_RETRY_LIMIT ?
        RETRY_DELAY_MS : SLOW_RETRY_DELAY_MS;

    if (attempts === 0 || now - lastAttemptTime >= retryDelay) {
        attempts += 1;
        lastAttemptTime = now;
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

// Real remote presses are trusted; our synthetic ones are not.
document.addEventListener('keydown', function (event) {
    if (!event || !event.isTrusted) return;
    const keyCode = event.keyCode || event.which;
    if (keyCode === 38 || keyCode === 40) {
        lastManualNavTime = Date.now();
    }
}, true);

configChangeEmitter.addEventListener('configChange', function (event) {
    if (event && event.detail && event.detail.key === SETTING_KEY) {
        resetState(null, 0);
    }
});

setInterval(check, POLL_INTERVAL_MS);
