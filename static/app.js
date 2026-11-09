const TZ = "Europe/Tallinn";
const WINDOW = 180;
const EXTEND_AT = 25;

const loginView = document.querySelector("#login-view");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const usernameInput = document.querySelector("#username");
const passwordInput = document.querySelector("#password");
const app = document.querySelector("#app");
const cameraSelect = document.querySelector("#camera");
const view = document.querySelector("#view");
const notice = document.querySelector("#notice");
const badge = document.querySelector("#badge");
const clock = document.querySelector("#clock");
const cameraName = document.querySelector("#camera-name");
const playButton = document.querySelector("#play");
const whenInput = document.querySelector("#when");
const scrubber = document.querySelector("#scrub");
const hoursEl = document.querySelector("#hours");
const hourEvents = document.querySelector("#hour-events");
const motionDate = document.querySelector("#motion-date");
const motionCount = document.querySelector("#motion-count");
const motionPrev = document.querySelector("#motion-prev");
const motionNext = document.querySelector("#motion-next");
const statusEl = document.querySelector("#status");

const state = {
  cameras: [],
  cameraId: null,
  generation: 0,
  runner: null,
  mode: "live",
  playing: false,
  clock: false,
  speed: 1,
  playhead: 0,
  anchorTime: 0,
  anchorPerf: 0,
  shownId: null,
  frames: [],
  bufferStart: 0,
  bufferStop: 0,
  extending: false,
  earliest: null,
  offset: 0,
  motionDay: "",
  motionHour: null,
  motion: null,
  motionToken: 0,
  objectUrl: null,
  primedFor: null,
};

let tail = Promise.resolve();
let pending = 0;
let pictureAbort = null;

function enqueue(task) {
  pending += 1;
  const timer = setTimeout(() => {
    document.body.classList.add("is-busy");
  }, 180);
  const run = tail.then(task, task);
  tail = run.then(release, release);
  return run;

  function release() {
    clearTimeout(timer);
    pending -= 1;
    if (pending === 0) {
      document.body.classList.remove("is-busy");
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function serverNow() {
  return Date.now() / 1000 + state.offset;
}

function noteServerTime(serverTime) {
  if (typeof serverTime === "number") {
    state.offset = serverTime - Date.now() / 1000;
  }
}

function parts(unix) {
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map = {};
  for (const part of format.formatToParts(new Date(unix * 1000))) {
    map[part.type] = part.value;
  }
  return map;
}

function tallinnOffset(unix) {
  const part = parts(unix);
  const asUtc = Date.UTC(+part.year, +part.month - 1, +part.day, +part.hour, +part.minute, +part.second);
  return asUtc / 1000 - unix;
}

function parseTallinn(value) {
  if (!value || !value.includes("T")) {
    return null;
  }
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute || 0, second || 0) / 1000;
  let unix = wall - tallinnOffset(wall);
  const corrected = wall - tallinnOffset(unix);
  if (Math.abs(corrected - unix) > 1) {
    unix = corrected;
  }
  return unix;
}

function tallinnInput(unix) {
  const part = parts(unix);
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}`;
}

function tallinnDay(unix) {
  const part = parts(unix);
  return `${part.year}-${part.month}-${part.day}`;
}

function formatAge(seconds) {
  const value = Math.max(0, Math.round(seconds));
  if (value < 90) {
    return value + "s behind";
  }
  const minutes = Math.round(value / 60);
  if (minutes < 90) {
    return minutes + " min behind";
  }
  const hours = Math.round(value / 3600);
  if (hours < 48) {
    return hours + " h behind";
  }
  return Math.round(value / 86400) + " days behind";
}

function formatClock(unix) {
  const part = parts(unix);
  return `${part.day}.${part.month}.${part.year} ${part.hour}:${part.minute}:${part.second}`;
}

function formatDay(day) {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year}`;
}

function shiftDay(day, amount) {
  const unix = parseTallinn(day + "T12:00:00");
  return tallinnDay(unix + amount * 86400);
}

function mediaTime() {
  if (state.clock) {
    return state.anchorTime + ((performance.now() - state.anchorPerf) / 1000) * state.speed;
  }
  return state.playhead;
}

function clampTime(unix) {
  let value = unix;
  const latest = serverNow() - 5;
  if (value > latest) {
    value = latest;
  }
  if (state.earliest && value < state.earliest) {
    value = state.earliest;
  }
  return value;
}

function indexAt(frames, unix) {
  let low = 0;
  let high = frames.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (frames[mid].time <= unix) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function cameraById(id) {
  return state.cameras.find((camera) => camera.id === id);
}

function setStatus(text, detail) {
  statusEl.textContent = text;
  statusEl.title = detail || "";
}

function setNotice(text) {
  notice.hidden = false;
  notice.textContent = text;
}

function hideNotice() {
  notice.hidden = true;
}

function setModeUI() {
  const live = state.mode === "live";
  badge.textContent = !state.playing ? "Paused" : live ? "Live" : "Playback";
  badge.className = "badge" + (state.playing ? (live ? "" : " past") : " paused");
  playButton.textContent = state.playing ? "Pause" : "Play";
  for (const button of document.querySelectorAll("[data-speed]")) {
    button.setAttribute("aria-pressed", Number(button.dataset.speed) === state.speed ? "true" : "false");
  }
  const now = serverNow();
  for (const button of document.querySelectorAll("[data-step]")) {
    const target = (live ? now : mediaTime()) + Number(button.dataset.step);
    button.disabled = target > now - 1;
  }
  document.querySelector("#frame-forward").disabled = live;
}

function renderClock() {
  const unix = state.mode === "live" ? state.playhead || serverNow() : mediaTime();
  if (unix) {
    clock.textContent = formatClock(unix);
    clock.dateTime = new Date(unix * 1000).toISOString();
    if (document.activeElement !== whenInput) {
      whenInput.value = tallinnInput(unix);
    }
  }
  updateScrubber();
  setModeUI();
}

function updateScrubber() {
  if (state.mode !== "past" || state.bufferStop <= state.bufferStart) {
    scrubber.disabled = true;
    return;
  }
  scrubber.disabled = false;
  scrubber.min = String(state.bufferStart);
  scrubber.max = String(state.bufferStop);
  if (document.activeElement !== scrubber) {
    const value = Math.min(state.bufferStop, Math.max(state.bufferStart, Math.round(mediaTime())));
    scrubber.value = String(value);
  }
}

function tickClock() {
  if (state.clock) {
    renderClock();
    requestAnimationFrame(tickClock);
  }
}

async function api(path, options) {
  return enqueue(async () => {
    const response = await fetch(path, {
      method: options && options.method ? options.method : "GET",
      body: options && options.body ? options.body : undefined,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(45000),
    });
    const data = await response.json().catch(() => ({}));
    if (path === "/api/me") {
      return data;
    }
    if (response.status === 401) {
      showLogin(data.error || "Sign in again.");
      throw new Error(data.error || "Sign in again.");
    }
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "The server did not answer.");
    }
    return data;
  });
}

function loadPicture(url, gen) {
  return enqueue(() => fetchPicture(url, gen));
}

async function fetchPicture(url, gen) {
  if (gen !== state.generation) {
    return false;
  }
  if (pictureAbort) {
    pictureAbort.abort();
  }
  const controller = new AbortController();
  pictureAbort = controller;
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      return false;
    }
    throw error;
  }
  if (!response.ok || gen !== state.generation) {
    return false;
  }
  const blob = await response.blob();
  if (gen !== state.generation) {
    return false;
  }
  const objectUrl = URL.createObjectURL(blob);
  view.src = objectUrl;
  try {
    await view.decode();
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    return false;
  }
  if (!view.naturalWidth || gen !== state.generation) {
    URL.revokeObjectURL(objectUrl);
    return false;
  }
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
  }
  state.objectUrl = objectUrl;
  return true;
}

async function showFrame(frame, gen) {
  setStatus("Loading the picture…");
  const started = performance.now();
  const ok = await loadPicture(frame.url, gen);
  if (!ok || gen !== state.generation) {
    return 0;
  }
  state.shownId = frame.id;
  state.lastPictureMs = Math.max(1, Math.round(performance.now() - started));
  const current = cameraById(state.cameraId);
  view.alt = (current ? current.name : "Camera") + " at " + formatClock(frame.time);
  hideNotice();
  return true;
}

function clearPicture() {
  if (pictureAbort) {
    pictureAbort.abort();
  }
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
  view.removeAttribute("src");
  state.shownId = null;
}

async function runLive(gen) {
  if (state.runner === gen) {
    return;
  }
  state.runner = gen;
  state.mode = "live";
  state.clock = false;
  setModeUI();
  try {
    while (state.mode === "live" && state.playing && state.generation === gen) {
      setStatus("Waiting for the latest frame…");
      let meta;
      try {
        meta = await api("/api/live?camera=" + state.cameraId);
      } catch (error) {
        if (gen !== state.generation) {
          return;
        }
        setStatus(error.message);
        await sleep(1200);
        continue;
      }
      if (gen !== state.generation || !state.playing || state.mode !== "live") {
        return;
      }
      noteServerTime(meta.serverTime);
      const frame = meta.frame;
      if (!frame) {
        setNotice("No frame");
        setStatus("No frame yet. Waiting before asking again.");
        await sleep(1500);
        continue;
      }
      if (state.shownId !== frame.id) {
        const shown = await showFrame(frame, gen);
        if (gen !== state.generation) {
          return;
        }
        if (!shown) {
          setStatus("Picture did not load. Waiting before trying again.");
          await sleep(800);
          continue;
        }
      }
      state.playhead = frame.time;
      renderClock();
      const age = Math.max(0, serverNow() - frame.time);
      setStatus(
        age < 3 ? "Live" : "Last picture is " + formatAge(age),
        frame.server + " answered in " + meta.ms + " ms. Picture " + (state.lastPictureMs || 0) + " ms. Asked " + (meta.probed || []).join(", ")
      );
      document.title = "Live · Inservo";
      if (state.primedFor !== state.cameraId) {
        state.primedFor = state.cameraId;
        primeCamera();
      }
      let wait = 2000;
      if (age < 1) {
        wait = Math.round((1.1 - age) * 1000);
      } else if (age < 5) {
        wait = 800;
      }
      await sleep(Math.max(250, wait));
    }
  } finally {
    if (state.runner === gen) {
      state.runner = null;
    }
  }
}

function primeCamera() {
  const cameraId = state.cameraId;
  api("/api/range?camera=" + cameraId)
    .then((data) => {
      if (cameraId === state.cameraId) {
        state.earliest = data.earliest;
        noteServerTime(data.serverTime);
      }
    })
    .catch(() => {});
  loadMotion(tallinnDay(serverNow()));
}

function appendFrames(frames) {
  const seen = new Set(state.frames.map((frame) => frame.id));
  for (const frame of frames) {
    if (!seen.has(frame.id)) {
      state.frames.push(frame);
      seen.add(frame.id);
    }
  }
    state.frames.sort((a, b) => a.time - b.time || Number(a.id) - Number(b.id));
}

function maybeExtend(unix, gen, force) {
  if (state.extending || (!force && unix < state.bufferStop - EXTEND_AT)) {
    return;
  }
  const now = serverNow();
  if (state.bufferStop >= now - 2) {
    return;
  }
  const start = state.bufferStop;
  const stop = Math.min(start + WINDOW, Math.floor(now));
  if (stop <= start) {
    return;
  }
  state.extending = true;
  api("/api/frames?camera=" + state.cameraId + "&start=" + start + "&stop=" + stop)
    .then((data) => {
      if (gen !== state.generation) {
        return;
      }
      appendFrames(data.frames);
      state.bufferStop = data.stop;
      updateScrubber();
    })
    .catch((error) => {
      if (gen === state.generation) {
        setStatus(error.message);
      }
    })
    .finally(() => {
      if (gen === state.generation) {
        state.extending = false;
      }
    });
}

async function present(unix, gen) {
  const index = indexAt(state.frames, unix);
  let frame = index >= 0 ? state.frames[index] : null;
  if (!frame && state.frames.length && state.frames[0].time - unix <= 2) {
    frame = state.frames[0];
  }
  renderClock();
  if (!frame) {
    setNotice("No frame");
    setStatus("No frames in this range.");
    return false;
  }
  const gap = unix - frame.time;
  if (gap > 3) {
    setNotice("No frame");
  }
  const ok = await showFrame(frame, gen);
  renderClock();
  return ok;
}

async function playPast(gen) {
  if (state.runner === gen) {
    return;
  }
  state.runner = gen;
  state.anchorTime = state.playhead;
  state.anchorPerf = performance.now();
  state.clock = true;
  requestAnimationFrame(tickClock);
  try {
    while (state.mode === "past" && state.playing && state.generation === gen) {
      const unix = mediaTime();
      state.playhead = unix;
      if (!state.frames.length) {
        setStatus("No frames in this range.");
        await sleep(400);
        continue;
      }
      const last = state.frames[state.frames.length - 1];
      if (unix > last.time + 1.2) {
        if (state.extending) {
          setStatus("Waiting for the next frames…");
          await sleep(250);
          continue;
        }
        const roomAhead = state.bufferStop < serverNow() - 2 && !state.lookedAhead;
        if (roomAhead) {
          state.lookedAhead = true;
          setNotice("No frame");
          setStatus("Looking ahead for the next frame…");
          maybeExtend(state.bufferStop, gen, true);
          await sleep(250);
          continue;
        }
        state.playhead = last.time;
        state.clock = false;
        state.playing = false;
        renderClock();
        setStatus("End of footage.");
        document.title = "Paused · Inservo";
        return;
      }
      let index = indexAt(state.frames, unix);
      if (index < 0) {
        const first = state.frames[0];
        if (first.time - unix > 2) {
          setNotice("No frame");
          state.anchorTime = first.time;
          state.anchorPerf = performance.now();
          continue;
        }
        index = 0;
      }
      const frame = state.frames[index];
      const next = state.frames[index + 1];
      if (next && next.time - frame.time > 4 && unix - frame.time > 1.2) {
        setNotice("No frame");
        state.anchorTime = next.time;
        state.anchorPerf = performance.now();
        continue;
      }
      if (state.shownId !== frame.id) {
        const shown = await showFrame(frame, gen);
        if (state.generation !== gen) {
          return;
        }
        if (!shown) {
          await sleep(400);
          continue;
        }
        state.lookedAhead = false;
      }
      maybeExtend(unix, gen);
      const ahead = (next ? next.time : frame.time + 1) - mediaTime();
      const waitMs = Math.max(40, Math.min(400, (ahead / state.speed) * 1000));
      setStatus("Playing", state.frames.length + " frames loaded");
      document.title = "Playing · Inservo";
      await sleep(Number.isFinite(waitMs) ? waitMs : 200);
    }
  } finally {
    if (state.runner === gen) {
      state.runner = null;
      state.clock = false;
    }
  }
}

async function seek(unix, play) {
  if (state.clock) {
    state.playhead = mediaTime();
  }
  state.clock = false;
  const target = clampTime(unix);
  const gen = ++state.generation;
  state.mode = "past";
  state.playing = play;
  state.lookedAhead = false;
  state.playhead = target;
  state.anchorTime = target;
  setModeUI();
  renderClock();
  const inside = state.frames.length && target >= state.bufferStart && target <= state.bufferStop;
  if (!inside) {
    setStatus("Loading footage…");
    state.frames = [];
    state.bufferStart = 0;
    state.bufferStop = 0;
    const start = Math.floor(target - 2);
    const stop = Math.min(Math.floor(target + WINDOW), Math.floor(serverNow()));
    let data;
    try {
      data = await api("/api/frames?camera=" + state.cameraId + "&start=" + start + "&stop=" + stop);
    } catch (error) {
      if (gen === state.generation) {
        setStatus(error.message);
      }
      return;
    }
    if (gen !== state.generation) {
      return;
    }
    state.frames = data.frames.slice();
    state.bufferStart = data.start;
    state.bufferStop = data.stop;
    setStatus(
      data.frames.length ? "Footage loaded" : "No frames in this range.",
      data.frames.length + " frames in " + data.ms + " ms from " + data.servers.join(", ")
    );
  }
  await present(target, gen);
  if (gen !== state.generation) {
    return;
  }
  loadMotion(tallinnDay(target));
  if (state.playing) {
    playPast(gen);
  } else {
    setStatus("Paused");
    document.title = "Paused · Inservo";
  }
}

function goLive() {
  if (state.mode === "live" && state.playing) {
    return;
  }
  if (state.clock) {
    state.playhead = mediaTime();
  }
  state.clock = false;
  if (state.mode !== "live") {
    state.generation += 1;
  }
  state.mode = "live";
  state.playing = true;
  setModeUI();
  runLive(state.generation);
}

function pause() {
  if (!state.playing) {
    return;
  }
  if (state.clock) {
    state.playhead = mediaTime();
  }
  state.clock = false;
  state.playing = false;
  renderClock();
  setStatus("Paused");
  document.title = "Paused · Inservo";
}

function play() {
  if (state.playing) {
    return;
  }
  state.playing = true;
  setModeUI();
  if (state.mode === "live") {
    runLive(state.generation);
  } else {
    playPast(state.generation);
  }
}

function step(seconds) {
  const base = state.mode === "live" ? serverNow() : mediaTime();
  const target = base + seconds;
  if (target >= serverNow() - 5) {
    goLive();
    return;
  }
  seek(target, state.playing);
}

function stepFrame(direction) {
  if (state.mode === "live") {
    if (direction < 0) {
      seek(serverNow() - 2, false);
    }
    return;
  }
  const index = indexAt(state.frames, mediaTime());
  const nextIndex = direction > 0 ? index + 1 : index - 1;
  const frame = state.frames[nextIndex];
  if (!frame) {
    step(direction > 0 ? 2 : -2);
    return;
  }
  pause();
  state.playhead = frame.time;
  state.anchorTime = frame.time;
  const gen = ++state.generation;
  state.mode = "past";
  showFrame(frame, gen).then((shown) => {
    if (gen !== state.generation) {
      return;
    }
    if (!shown) {
      setStatus("Picture did not load.");
      return;
    }
    renderClock();
    setStatus("Paused");
  }).catch((error) => {
    if (gen === state.generation) {
      setStatus(error.message);
    }
  });
}

function renderMotion() {
  const motion = state.motion;
  hoursEl.replaceChildren();
  hourEvents.replaceChildren();
  if (!motion) {
    motionDate.textContent = "Motion";
    motionCount.textContent = "";
    return;
  }
  motionDate.textContent = formatDay(motion.day);
  const total = motion.hours.reduce((sum, count) => sum + count, 0);
  motionCount.textContent = total === 1 ? "1 motion" : total + " motions";
  const max = Math.max(1, ...motion.hours);
  const playPart = parts(mediaTime() || serverNow());
  const playDay = `${playPart.year}-${playPart.month}-${playPart.day}`;
  motion.hours.forEach((count, hour) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hour";
    if (motion.day === playDay && Number(playPart.hour) === hour) {
      button.classList.add("current");
    }
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.height = Math.max(2, Math.round((count / max) * 64)) + "px";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = String(hour).padStart(2, "0");
    button.append(bar, label);
    button.title = count === 1 ? "1 motion" : count + " motions";
    button.addEventListener("click", () => {
      state.motionHour = hour;
      renderHourEvents();
      const first = motion.events.find((event) => event.hour === hour);
      const start = parseTallinn(motion.day + "T" + String(hour).padStart(2, "0") + ":00:00");
      seek(first ? first.time : start, true);
    });
    hoursEl.append(button);
  });
  const today = tallinnDay(serverNow());
  motionNext.disabled = motion.day >= today;
  renderHourEvents();
}

function renderHourEvents() {
  hourEvents.replaceChildren();
  if (!state.motion || state.motionHour === null) {
    return;
  }
  const events = state.motion.events.filter((event) => event.hour === state.motionHour);
  const visible = events.slice(0, 300);
  for (const event of visible) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = parts(event.time).hour + ":" + parts(event.time).minute + ":" + parts(event.time).second;
    button.addEventListener("click", () => {
      seek(event.time, true);
    });
    item.append(button);
    hourEvents.append(item);
  }
  if (events.length > visible.length) {
    const item = document.createElement("li");
    item.textContent = "Showing " + visible.length + " of " + events.length;
    hourEvents.append(item);
  }
}

function loadMotion(day) {
  if (!day || !state.cameraId) {
    return;
  }
  if (state.motion && state.motion.day === day && state.motionCamera === state.cameraId) {
    renderMotion();
    return;
  }
  const token = ++state.motionToken;
  const cameraId = state.cameraId;
  api("/api/events?camera=" + cameraId + "&day=" + day)
    .then((data) => {
      if (token !== state.motionToken || cameraId !== state.cameraId) {
        return;
      }
      state.motion = data;
      state.motionCamera = cameraId;
      state.motionDay = day;
      if (state.motionHour === null) {
        state.motionHour = Number(parts(serverNow()).hour);
      }
      renderMotion();
    })
    .catch((error) => {
      if (token === state.motionToken) {
        setStatus(error.message);
      }
    });
}

function showLogin(message) {
  state.generation += 1;
  state.playing = false;
  state.clock = false;
  app.hidden = true;
  loginView.hidden = false;
  document.title = "Inservo";
  if (message) {
    loginError.hidden = false;
    loginError.textContent = message;
  }
}

function startApp(cameras) {
  state.cameras = cameras;
  loginView.hidden = true;
  app.hidden = false;
  loginError.hidden = true;
  cameraSelect.replaceChildren();
  if (!cameras.length) {
    setStatus("This account has no cameras.");
    return;
  }
  for (const camera of cameras) {
    const option = document.createElement("option");
    option.value = String(camera.id);
    option.textContent = camera.name;
    cameraSelect.append(option);
  }
  selectCamera(cameras[0].id);
}

function selectCamera(id) {
  const camera = cameraById(id);
  if (!camera) {
    return;
  }
  state.cameraId = camera.id;
  state.generation += 1;
  state.clock = false;
  state.playing = true;
  state.mode = "live";
  state.frames = [];
  state.bufferStart = 0;
  state.bufferStop = 0;
  state.earliest = null;
  state.motion = null;
  state.motionHour = null;
  state.primedFor = null;
  cameraSelect.value = String(camera.id);
  cameraName.textContent = camera.name;
  clearPicture();
  setModeUI();
  setStatus("Waiting for the latest frame…");
  runLive(state.generation);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  const button = document.querySelector("#login-button");
  button.disabled = true;
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value,
      }),
    });
    passwordInput.value = "";
    noteServerTime(data.serverTime);
    startApp(data.cameras);
  } catch (error) {
    loginError.hidden = false;
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#logout").addEventListener("click", async () => {
  state.generation += 1;
  state.playing = false;
  state.clock = false;
  try {
    await api("/api/logout", { method: "POST" });
  } catch (error) {
    setStatus(error.message);
  }
  clearPicture();
  showLogin("");
  loginError.hidden = true;
});

cameraSelect.addEventListener("change", () => {
  selectCamera(Number(cameraSelect.value));
});

playButton.addEventListener("click", () => {
  if (state.playing) {
    pause();
  } else {
    play();
  }
});

document.querySelector("#live").addEventListener("click", goLive);

for (const button of document.querySelectorAll("[data-speed]")) {
  button.addEventListener("click", () => {
    const speed = Number(button.dataset.speed);
    if (state.clock) {
      state.anchorTime = mediaTime();
      state.anchorPerf = performance.now();
    }
    state.speed = speed;
    setModeUI();
  });
}

for (const button of document.querySelectorAll("[data-step]")) {
  button.addEventListener("click", () => {
    step(Number(button.dataset.step));
  });
}

document.querySelector("#frame-back").addEventListener("click", () => {
  stepFrame(-1);
});
document.querySelector("#frame-forward").addEventListener("click", () => {
  stepFrame(1);
});

document.querySelector("#go-time").addEventListener("click", () => {
  const unix = parseTallinn(whenInput.value);
  if (!unix) {
    return;
  }
  if (unix >= serverNow() - 5) {
    goLive();
    return;
  }
  seek(unix, true);
});

document.querySelector("#fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    app.requestFullscreen();
  }
});

document.addEventListener("fullscreenchange", () => {
  const button = document.querySelector("#fullscreen");
  button.textContent = document.fullscreenElement ? "Exit" : "Full screen";
});

motionPrev.addEventListener("click", () => {
  const day = state.motion ? state.motion.day : tallinnDay(serverNow());
  loadMotion(shiftDay(day, -1));
});

motionNext.addEventListener("click", () => {
  const day = state.motion ? state.motion.day : tallinnDay(serverNow());
  loadMotion(shiftDay(day, 1));
});

let scrubWant = null;
let scrubbing = false;

scrubber.addEventListener("input", () => {
  scrubWant = Number(scrubber.value);
  pumpScrub();
});

async function pumpScrub() {
  if (scrubbing) {
    return;
  }
  scrubbing = true;
  if (state.clock) {
    state.playhead = mediaTime();
  }
  state.clock = false;
  state.playing = false;
  const gen = ++state.generation;
  state.mode = "past";
  setModeUI();
  while (scrubWant !== null && gen === state.generation) {
    const unix = scrubWant;
    scrubWant = null;
    state.playhead = unix;
    state.anchorTime = unix;
    renderClock();
    const index = indexAt(state.frames, unix);
    const frame = index >= 0 ? state.frames[index] : null;
    if (frame && frame.id !== state.shownId) {
      await showFrame(frame, gen);
    }
  }
  if (gen === state.generation) {
    setStatus("Paused");
    document.title = "Paused · Inservo";
  }
  scrubbing = false;
}

document.addEventListener("keydown", (event) => {
  if (app.hidden) {
    return;
  }
  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    if (state.playing) {
      pause();
    } else {
      play();
    }
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    step(event.shiftKey ? -60 : -10);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    step(event.shiftKey ? 60 : 10);
  } else if (event.key === "l" || event.key === "L") {
    goLive();
  } else if (event.key === "f" || event.key === "F") {
    document.querySelector("#fullscreen").click();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

async function boot() {
  try {
    const me = await api("/api/me");
    if (me.ok) {
      noteServerTime(me.serverTime);
      startApp(me.cameras);
      return;
    }
  } catch (error) {
    setStatus(error.message);
  }
  showLogin("");
  loginError.hidden = true;
}

boot();
