import sha256 from '../tiny-sha256.js';
import { configRead } from '../config.js';
import { showToast } from '../ui/ytUI.js';
import { t } from 'i18next';

// Copied from https://github.com/ajayyy/SponsorBlock/blob/da1a535de784540ee10166a75a3eb8537073838c/src/config.ts#L113-L134
const barTypes = {
  sponsor: {
    color: '#00d400',
    opacity: '0.7',
    name: t('sponsorblock.segments.sponsor') || 'sponsored segment'
  },
  intro: {
    color: '#00ffff',
    opacity: '0.7',
    name: t('sponsorblock.segments.intro') || 'intro'
  },
  outro: {
    color: '#0202ed',
    opacity: '0.7',
    name: t('sponsorblock.segments.outro') || 'outro'
  },
  interaction: {
    color: '#cc00ff',
    opacity: '0.7',
    name: t('sponsorblock.segments.interaction') || 'interaction reminder'
  },
  selfpromo: {
    color: '#ffff00',
    opacity: '0.7',
    name: t('sponsorblock.segments.selfpromo') || 'self-promotion'
  },
  preview: {
    color: '#008fd6',
    opacity: '0.7',
    name: t('sponsorblock.segments.preview') || 'recap or preview'
  },
  filler: {
    color: "#7300FF",
    opacity: "0.9",
    name: t('sponsorblock.segments.filler') || 'tangents'
  },
  music_offtopic: {
    color: '#ff9900',
    opacity: '0.7',
    name: t('sponsorblock.segments.music_offtopic') || 'non-music part'
  },
  poi_highlight: {
    color: '#9b044c',
    opacity: '0.7',
    name: t('sponsorblock.segments.poi_highlight') || 'highlight'
  }
};

const sponsorblockAPI = 'https://sponsor.ajay.app/api';

// SponsorBlock used to key off hashchange only, which never fires while the
// Shorts feed scrolls between videos. Track the current video ourselves so
// Shorts get segments too.
const SHORTS_POLL_MS = 350;
const SHORTS_MAX_SECONDS = 200;
const SHORTS_IDLE_TIMEOUT_MS = 600000;

// Sticky: the page can stop reporting that the feed is open right after a
// transition, so remember Shorts until a long video clearly takes over.
let shortsMode = false;
let lastShortsSignal = 0;

function getPlayer() {
  return document.querySelector('.html5-video-player');
}

function visibleVideo() {
  // Pick the largest visible video so a hidden preload cannot be mistaken for
  // the video that is actually on screen.
  let best = null;
  let bestScore = -1;
  const videos = document.getElementsByTagName('video');
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const area = (video.clientWidth || 0) * (video.clientHeight || 0);
    let score = area;
    if (area > 0 && video.classList &&
        video.classList.contains('html5-main-video')) {
      score += 1000000000;
    }
    if (!video.paused && !video.ended) score += 100000;
    if (!video.currentSrc && !video.src) score -= 1000000;
    if (score > bestScore) {
      bestScore = score;
      best = video;
    }
  }
  return bestScore > 0 ? best : null;
}

// Match a route segment, not a raw substring: a watch URL whose video ID
// happens to contain "shorts" is still a regular video.
const SHORTS_ROUTE_RE = /(?:^|[\s/])shorts(?:$|[\s/?&#])/;
const WATCH_ROUTE_RE = /(?:^|[\s/])watch(?:$|[\s/?&#])/;

// Only the client route counts: the first segment of the hash (or pathname).
// The trailing query is dropped so a "?next=/shorts/..." link cannot flip the
// classification. The href is included because some builds expose the route
// only there.
function routeText() {
  const parts = [];

  const hash = (location.hash || '').toLowerCase();
  if (hash) parts.push(hash.replace(/^#/, '').split('?')[0]);

  const pathname = (location.pathname || '').toLowerCase();
  if (pathname) parts.push(pathname);

  const href = (location.href || '').toLowerCase();
  const noOrigin = href.replace(/^[a-z]+:\/\/[^/]*/, '');
  const hashIndex = noOrigin.indexOf('#');
  const beforeHash = (hashIndex === -1 ? noOrigin : noOrigin.slice(0, hashIndex))
    .split('?')[0];
  const fragment = hashIndex === -1
    ? ''
    : noOrigin.slice(hashIndex + 1).split('?')[0];
  if (beforeHash) parts.push(beforeHash);
  if (fragment) parts.push(fragment);

  return parts.join(' ');
}

// The Short ID named by the current route, if any. Video IDs are
// case-sensitive, so the original case must be preserved for the API hash.
function routeShortsId() {
  const source = (location.hash || '') || (location.href || '');
  const match = source.match(/\/shorts\/([A-Za-z0-9_-]{6,})/i);
  return match ? match[1] : null;
}

function isShortsRoute() {
  return SHORTS_ROUTE_RE.test(routeText());
}

function isWatchRoute() {
  return WATCH_ROUTE_RE.test(routeText());
}

function hasShortsSignal() {
  if (isShortsRoute()) return true;

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

function updateShortsMode(video) {
  const now = Date.now();
  if (hasShortsSignal()) {
    shortsMode = true;
    lastShortsSignal = now;
    return true;
  }

  if (!shortsMode) return false;

  // A clearly long video means we left the feed even if the page still
  // reports Shorts for a moment.
  const duration = video ? video.duration : NaN;
  const currentTime = video ? (video.currentTime || 0) : 0;
  if (isFinite(duration) && duration > SHORTS_MAX_SECONDS && currentTime > 5) {
    shortsMode = false;
    return false;
  }

  if (!video && now - lastShortsSignal > SHORTS_IDLE_TIMEOUT_MS) {
    shortsMode = false;
    return false;
  }

  return true;
}

function playerVideoId() {
  const player = getPlayer();
  if (player && typeof player.getVideoData === 'function') {
    try {
      const data = player.getVideoData();
      if (data && data.video_id) return data.video_id;
    } catch (err) {}
  }
  return null;
}

// The Short that is actually on screen, or null when this is a regular video.
function shortsVideoId() {
  // Normally the watch route is unambiguous: leave Shorts mode immediately so
  // a short regular video is not classified as a Short after the feed. The
  // exception is a positive Shorts signal (the player still says
  // "shortspage"), which wins over a stale watch hash.
  if (isWatchRoute() && !hasShortsSignal()) {
    shortsMode = false;
    return null;
  }

  const video = visibleVideo();
  if (!updateShortsMode(video)) return null;

  // Do not mistake a long video for a Short while the sticky flag is still
  // set right after leaving the feed.
  if (video) {
    const duration = video.duration;
    if (isFinite(duration) && duration > SHORTS_MAX_SECONDS) return null;
  }

  const fromPlayer = playerVideoId();
  if (fromPlayer) return fromPlayer;

  return routeShortsId();
}

// A handler only skips a Short when the player (or, when the player exposes no
// video data, the route) positively confirms it is still that same Short. A
// missing ID is not proof: during a swipe the player data can be empty for a
// moment while the hash still names the previous Short. expectedPlayerId is the
// ID the player reported when this handler was created; if it was known and the
// player has since gone blank, the route is stale and must not be trusted.
function confirmsShortId(videoID, expectedPlayerId) {
  if (!videoID) return false;

  const player = getPlayer();
  if (player && typeof player.getVideoData === 'function') {
    const fromPlayer = playerVideoId();
    if (fromPlayer) return fromPlayer === videoID;
    if (expectedPlayerId) return false;
  }

  return routeShortsId() === videoID;
}

function resolveVideo() {
  const shortsId = shortsVideoId();
  if (shortsId) return { videoID: shortsId, isShorts: true };

  // A hack, but it works: the TV app puts the watch URL in the hash.
  let videoID = null;
  try {
    const hashURL = new URL(location.hash.substring(1), location.href);
    const fromHash = hashURL.searchParams.get('v');
    const fromURL = new URL(location.href).searchParams.get('v');
    videoID = fromHash || fromURL || null;
  } catch (err) {}
  return { videoID: videoID, isShorts: false };
}

class SponsorBlockHandler {
  video = null;
  active = true;

  attachVideoTimeout = null;
  nextSkipTimeout = null;
  sliderInterval = null;

  observer = null;
  scheduleSkipHandler = null;
  durationChangeHandler = null;
  segments = null;
  skippableCategories = [];
  manualSkippableCategories = [];
  skippedCategories = new Map();

  constructor(videoID, isShorts) {
    this.videoID = videoID;
    this.isShorts = !!isShorts;
    // Remember what the player reported at bind time so a later blank read can
    // be distinguished from "this player never exposes video data".
    this.boundPlayerId = this.isShorts ? playerVideoId() : null;
  }

  async init() {
    const videoHash = sha256(this.videoID).substring(0, 4);
    const categories = [
      'sponsor',
      'intro',
      'outro',
      'interaction',
      'selfpromo',
      'preview',
      'filler',
      'music_offtopic',
      'poi_highlight'
    ];
    const resp = await fetch(
      `${sponsorblockAPI}/skipSegments/${videoHash}?categories=${encodeURIComponent(
        JSON.stringify(categories)
      )}`
    );
    const results = await resp.json();

    // The feed may have moved on while the request was in flight.
    if (!this.active) return;

    const result = results.find((v) => v.videoID === this.videoID);
    console.info(this.videoID, 'Got it:', result);

    if (!result || !result.segments || !result.segments.length) {
      console.info(this.videoID, 'No segments found.');
      return;
    }

    this.segments = result.segments;
    this.manualSkippableCategories = configRead('sponsorBlockManualSkips');
    this.skippableCategories = this.getSkippableCategories();

    this.scheduleSkipHandler = () => {
      if (!this.isShorts && this.segmentsoverlay) {
        const slider = document.querySelector('div[idomkey="slider"]');
        const sliderRect = slider?.getBoundingClientRect();
        const isOldUI = !document.querySelector('div[idomkey="Metadata-Section"]');
        if (isOldUI && sliderRect) {
          this.segmentsoverlay.style.setProperty('top', `${sliderRect.top}px`, 'important');
        }
      }
      this.scheduleSkip();
    }
    this.durationChangeHandler = () => this.buildOverlay();

    this.attachVideo();
    // Shorts have no progress bar to draw segment markers on, and the slider
    // retry loop would never resolve there.
    if (!this.isShorts) this.buildOverlay();
  }

  getSkippableCategories() {
    const skippableCategories = [];
    if (configRead('enableSponsorBlockSponsor')) {
      skippableCategories.push('sponsor');
    }
    if (configRead('enableSponsorBlockIntro')) {
      skippableCategories.push('intro');
    }
    if (configRead('enableSponsorBlockOutro')) {
      skippableCategories.push('outro');
    }
    if (configRead('enableSponsorBlockInteraction')) {
      skippableCategories.push('interaction');
    }
    if (configRead('enableSponsorBlockSelfPromo')) {
      skippableCategories.push('selfpromo');
    }
    if (configRead('enableSponsorBlockPreview')) {
      skippableCategories.push('preview');
    }
    if (configRead('enableSponsorBlockFiller')) {
      skippableCategories.push('filler');
    }
    if (configRead('enableSponsorBlockMusicOfftopic')) {
      skippableCategories.push('music_offtopic');
    }
    return skippableCategories;
  }

  attachVideo() {
    clearTimeout(this.attachVideoTimeout);
    this.attachVideoTimeout = null;

    // On Shorts the first <video> can be a hidden preload; bind to the one on
    // screen instead.
    const next = visibleVideo() || document.querySelector('video');
    if (!next) {
      console.info(this.videoID, 'No video yet...');
      this.attachVideoTimeout = setTimeout(() => this.attachVideo(), 100);
      return;
    }

    // The feed can swap the element between Shorts; never keep listeners on a
    // detached video.
    if (next === this.video) return;

    this.detachVideo();
    this.video = next;

    console.info(this.videoID, 'Video found, binding...');

    this.video.addEventListener('play', this.scheduleSkipHandler);
    this.video.addEventListener('pause', this.scheduleSkipHandler);
    this.video.addEventListener('timeupdate', this.scheduleSkipHandler);
    this.video.addEventListener('durationchange', this.durationChangeHandler);
  }

  // Rebind if the video that was playing was replaced or removed.
  reattachIfNeeded() {
    if (!this.video || !document.contains(this.video)) {
      this.attachVideo();
    }
  }

  detachVideo() {
    if (this.video) {
      this.video.removeEventListener('play', this.scheduleSkipHandler);
      this.video.removeEventListener('pause', this.scheduleSkipHandler);
      this.video.removeEventListener('timeupdate', this.scheduleSkipHandler);
      this.video.removeEventListener(
        'durationchange',
        this.durationChangeHandler
      );
      this.video = null;
    }
  }

  buildOverlay() {
    if (this.isShorts) return;

    if (this.segmentsoverlay) {
      console.info('Overlay already built');
      return;
    }

    if (!this.video || !this.video.duration) {
      console.info('No video duration yet');
      return;
    }

    const videoDuration = this.video.duration;
    const slider = document.querySelector('div[idomkey="slider"]');
    if (!slider) return setTimeout(() => this.buildOverlay(), 100);

    this.segmentsoverlay = document.createElement('div');

    this.segmentsoverlay.classList.add('ytLrProgressBarSlider', 'ytLrProgressBarSliderRectangularProgressBar');
    this.segmentsoverlay.style.setProperty('z-index', '10', 'important');
    this.segmentsoverlay.style.setProperty('background-color', 'rgba(0, 0, 0, 0)', 'important');
    this.segmentsoverlay.style.setProperty('width', '72rem', 'important');
    this.segmentsoverlay.style.setProperty('left', '4rem', 'important');
    const sliderRect = slider.getBoundingClientRect();
    if (!slider.classList.contains('ytLrProgressBarSlider')) {
      for (let i = 0; i < slider.classList.length; i++) {
        this.segmentsoverlay.classList.add(slider.classList[i]);
      }
      this.segmentsoverlay.style.setProperty('height', `${sliderRect.height}px`, 'important');
      this.segmentsoverlay.style.setProperty('bottom', `${sliderRect.bottom - sliderRect.top}px`, 'important');      
    }
    this.segments.forEach((segment) => {
      const [start, end] = segment.segment;
      const barType = barTypes[segment.category] || {
        color: 'blue',
        opacity: 0.7
      };

      const leftPercent = videoDuration ? (100.0 * start) / videoDuration : 0;
      const widthPercent = videoDuration ? (100.0 * (end - start)) / videoDuration : 0;

      const elm = document.createElement('div');
      elm.style.setProperty('background-color', barType.color, 'important');
      elm.style.setProperty('opacity', barType.opacity, 'important');
      elm.style.setProperty('height', '100%', 'important');
      elm.style.setProperty('width', `${segment.category === 'poi_highlight' ? 1 : widthPercent}%`, 'important');
      elm.style.setProperty('left', `${leftPercent}%`, 'important');
      elm.style.setProperty('position', 'absolute', 'important');
      console.info('Generated element', elm, 'from', segment);
      this.segmentsoverlay.appendChild(elm);
    });

    this.observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        if (m.removedNodes) {
          for (const node of m.removedNodes) {
            if (node === this.segmentsoverlay) {
              console.info('bringing back segments overlay');
              this.slider.appendChild(this.segmentsoverlay);
            }
          }
        }

        if (document.querySelector('ytlr-progress-bar').getAttribute('hybridnavfocusable') === 'false') {
          this.segmentsoverlay.style.setProperty('display', 'none', 'important');
        } else {
          this.segmentsoverlay.style.setProperty('display', 'block', 'important');
        }
      });
    });

    this.sliderInterval = setInterval(() => {
      this.slider = document.querySelector('ytlr-redux-connect-ytlr-progress-bar');
      if (this.slider) {
        clearInterval(this.sliderInterval);
        this.sliderInterval = null;
        this.observer.observe(this.slider, {
          childList: true,
          subtree: true
        });
        this.slider.appendChild(this.segmentsoverlay);
      }
    }, 500);
  }

  scheduleSkip() {
    clearTimeout(this.nextSkipTimeout);
    this.nextSkipTimeout = null;

    if (!this.active) {
      console.info(this.videoID, 'No longer active, ignoring...');
      return;
    }

    // The feed may have moved on before the poll swapped handlers; never skip
    // using the previous Short's segments.
    if (this.isShorts && !confirmsShortId(this.videoID, this.boundPlayerId)) return;

    if (this.video.paused) {
      console.info(this.videoID, 'Currently paused, ignoring...');
      return;
    }

    // Sometimes timeupdate event (that calls scheduleSkip) gets fired right before
    // already scheduled skip routine below. Let's just look back a little bit
    // and, in worst case, perform a skip at negative interval (immediately)...
    const currentTime = this.video.currentTime;
    const nextSegments = this.segments.filter((seg) => {
      // Shorts are often already past the segment start by the time the API
      // responds, so also catch a segment we are currently inside.
      if (this.isShorts &&
          this.skippableCategories.includes(seg.category) &&
          seg.segment[0] <= currentTime &&
          seg.segment[1] > currentTime + 0.1) {
        return true;
      }
      return seg.segment[0] > currentTime - 0.3 &&
        seg.segment[1] > currentTime - 0.3;
    });
    nextSegments.sort((s1, s2) => s1.segment[0] - s2.segment[0]);

    if (!nextSegments.length) {
      console.info(this.videoID, 'No more segments');
      return;
    }

    const [segment] = nextSegments;
    const [start, end] = segment.segment;
    console.info(
      this.videoID,
      'Scheduling skip of',
      segment,
      'in',
      start - this.video.currentTime
    );

    this.nextSkipTimeout = setTimeout(() => {
      // The handler may have been swapped to the next Short after this timer
      // was queued.
      if (!this.active) return;
      if (this.isShorts && !confirmsShortId(this.videoID, this.boundPlayerId)) return;
      if (this.video.paused) {
        console.info(this.videoID, 'Currently paused, ignoring...');
        return;
      }
      if (!this.skippableCategories.includes(segment.category)) {
        console.info(
          this.videoID,
          'Segment',
          segment.category,
          'is not skippable, ignoring...'
        );
        return;
      }

      const skipName = barTypes[segment.category]?.name || segment.category;
      console.info(this.videoID, 'Skipping', segment);
      if (!this.manualSkippableCategories.includes(segment.category)) {
        const wasSkippedBefore = this.skippedCategories.get(segment.UUID)
        if (wasSkippedBefore) {
          wasSkippedBefore.count++;
          wasSkippedBefore.lastSkipped = Date.now();
          this.skippedCategories.set(segment.UUID, wasSkippedBefore);

          if (wasSkippedBefore.lastSkipped - wasSkippedBefore.firstSkipped < 1000) {
            if (!wasSkippedBefore.hasShownToast) {
              if (configRead('enableSponsorBlockToasts')) {
                showToast('SponsorBlock', t('sponsorblock.toasts.notSkipping', { segment: skipName, count: wasSkippedBefore.count }));
              }
              wasSkippedBefore.hasShownToast = true;
              this.skippedCategories.set(segment.UUID, wasSkippedBefore);
            }
            return;
          }
        } else {
          this.skippedCategories.set(segment.UUID, {
            count: 1,
            firstSkipped: Date.now(),
            lastSkipped: Date.now(),
            hasShownToast: false
          });
        }
        if (configRead('enableSponsorBlockToasts')) {
          showToast('SponsorBlock', t('sponsorblock.toasts.skipping', { segment: skipName }));
        }
        if (this.video.duration - end < 1) {
          this.video.currentTime = end - 1;
        } else this.video.currentTime = end;
        this.scheduleSkip();
      }
    }, (start - this.video.currentTime) * 1000);
  }

  destroy() {
    console.info(this.videoID, 'Destroying');

    this.active = false;

    if (this.nextSkipTimeout) {
      clearTimeout(this.nextSkipTimeout);
      this.nextSkipTimeout = null;
    }

    if (this.attachVideoTimeout) {
      clearTimeout(this.attachVideoTimeout);
      this.attachVideoTimeout = null;
    }

    if (this.sliderInterval) {
      clearInterval(this.sliderInterval);
      this.sliderInterval = null;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.segmentsoverlay) {
      this.segmentsoverlay.remove();
      this.segmentsoverlay = null;
    }

    this.detachVideo();

    this.skippedCategories.clear();
  }
}

// When this global variable was declared using let and two consecutive hashchange
// events were fired (due to bubbling? not sure...) the second call handled below
// would not see the value change from first call, and that would cause multiple
// SponsorBlockHandler initializations... This has been noticed on Chromium 38.
// This either reveals some bug in chromium/webpack/babel scope handling, or
// shows my lack of understanding of javascript. (or both)
window.sponsorblock = null;

function sponsorBlockEnabledFor(isShorts) {
  if (!configRead('enableSponsorBlock')) return false;
  return !isShorts || configRead('enableSponsorBlockShorts');
}

function syncHandler() {
  const resolved = resolveVideo();
  const videoID = resolved.videoID;
  const enabled = sponsorBlockEnabledFor(resolved.isShorts);
  // Also recreate when only the classification changed: the first poll can
  // happen before metadata is known, and the handler must stop treating a
  // regular video as a Short once that resolves. Toggling the Shorts setting
  // off must also tear down an existing Shorts handler.
  const needsReload =
    videoID &&
    (enabled
      ? !window.sponsorblock ||
        window.sponsorblock.videoID != videoID ||
        window.sponsorblock.isShorts !== resolved.isShorts
      : !!window.sponsorblock);

  if (!needsReload) {
    if (window.sponsorblock && window.sponsorblock.reattachIfNeeded) {
      window.sponsorblock.reattachIfNeeded();
    }
    return;
  }

  console.info(
    'SponsorBlock video change',
    videoID,
    resolved.isShorts ? '(shorts)' : '',
    window.sponsorblock ? window.sponsorblock.videoID : null
  );

  if (window.sponsorblock) {
    try {
      window.sponsorblock.destroy();
    } catch (err) {
      console.warn('window.sponsorblock.destroy() failed!', err);
    }
    window.sponsorblock = null;
  }

  if (enabled) {
    window.sponsorblock = new SponsorBlockHandler(videoID, resolved.isShorts);
    window.sponsorblock.init();
  } else {
    console.info('SponsorBlock disabled, not loading');
  }
}

window.addEventListener('hashchange', syncHandler, false);
// Shorts change video without a hashchange, so poll for the current video.
setInterval(syncHandler, SHORTS_POLL_MS);

// Back leaves the feed. Drop the sticky flag right away so a short regular
// video watched afterwards is not mistaken for a Short.
document.addEventListener('keydown', (event) => {
  if (!event || !event.isTrusted) return;
  const keyCode = event.keyCode || event.which;
  if (keyCode === 27 || keyCode === 403 || keyCode === 461 ||
      keyCode === 10009) {
    shortsMode = false;
    lastShortsSignal = 0;
  }
}, true);
