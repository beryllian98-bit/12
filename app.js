const EMOTIONS = [
  "angry",
  "disgusted",
  "fearful",
  "happy",
  "neutral",
  "other",
  "sad",
  "surprised",
  "unknown",
];

const FOLDER_ALIASES = {
  angry: ["angry", "anger", "生氣"],
  disgusted: ["disgusted", "disgust", "厭惡"],
  fearful: ["fearful", "fear", "scared", "害怕", "恐懼"],
  happy: ["happy", "happiness", "joy", "開心", "快樂"],
  neutral: ["neutral", "calm", "normal", "中性", "平靜"],
  other: ["other", "others", "其他"],
  sad: ["sad", "sadness", "難過", "悲傷"],
  surprised: ["surprised", "surprise", "驚訝"],
  unknown: ["unknown", "unknow", "un know", "不明"],
};

const AUDIO_TYPES = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm"]);
const TRACKS_PER_EMOTION = 12;
const MIC_RECORD_SECONDS = 6;

const audioFileInput = document.querySelector("#audioFileInput");
const startButton = document.querySelector("#startButton");
const playDetectedButton = document.querySelector("#playDetectedButton");
const stopButton = document.querySelector("#stopButton");
const statusText = document.querySelector("#statusText");
const emotionText = document.querySelector("#emotionText");
const confidenceText = document.querySelector("#confidenceText");
const trackText = document.querySelector("#trackText");
const player = document.querySelector("#player");
const levelMeter = document.querySelector("#levelMeter");
const emotionGrid = document.querySelector("#emotionGrid");

let audioContext;
let analyser;
let microphone;
let stream;
let testAudio;
let testAudioObjectUrl;
let rafId;
let micRecordTimer;
let lastBins;
let lastEmotion = "unknown";
let lastPlayAt = 0;
let analysisMode = "idle";
let detectedTrack = null;
let voteScores = {};
let expectedTestEmotion = "";
let musicLibrary = Object.fromEntries(EMOTIONS.map((emotion) => [emotion, []]));

function buildLockedMusicLibrary() {
  musicLibrary = Object.fromEntries(EMOTIONS.map((emotion) => {
    const tracks = Array.from({ length: TRACKS_PER_EMOTION }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        name: `${emotion}_music_${number}.wav`,
        url: `music/${emotion}/${emotion}_music_${number}.wav`,
      };
    });
    return [emotion, tracks];
  }));
  renderEmotionGrid(lastEmotion);
  statusText.textContent = "已鎖定內建 108 首音樂庫。可選電腦音訊，或用麥克風現場錄音分析。";
}

function renderEmotionGrid(activeEmotion = "unknown") {
  emotionGrid.innerHTML = "";
  EMOTIONS.forEach((emotion) => {
    const chip = document.createElement("div");
    chip.className = `emotion-chip${emotion === activeEmotion ? " active" : ""}`;
    chip.innerHTML = `<strong>${emotion}</strong><span>${musicLibrary[emotion].length} 首音樂</span>`;
    emotionGrid.append(chip);
  });
}

function normalizePathPart(part) {
  return part.trim().toLowerCase().replace(/[_-]+/g, " ");
}

function emotionFromPath(path) {
  const parts = path.split(/[\\/]/).map(normalizePathPart);
  return EMOTIONS.find((emotion) => {
    const aliases = FOLDER_ALIASES[emotion];
    return parts.some((part) => aliases.includes(part));
  });
}

function emotionFromFileName(file) {
  const source = `${file.webkitRelativePath || ""}/${file.name || ""}`;
  const normalized = normalizePathPart(source);
  return EMOTIONS.find((emotion) => {
    const aliases = FOLDER_ALIASES[emotion];
    return aliases.some((alias) => {
      const safeAlias = normalizePathPart(alias);
      return normalized.includes(safeAlias);
    });
  }) || "";
}

function loadMusic(files) {
  musicLibrary = Object.fromEntries(EMOTIONS.map((emotion) => [emotion, []]));

  Array.from(files).forEach((file) => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!AUDIO_TYPES.has(ext)) return;

    const relativePath = file.webkitRelativePath || file.name;
    const emotion = emotionFromPath(relativePath);
    if (emotion) {
      musicLibrary[emotion].push(file);
    }
  });

  const total = Object.values(musicLibrary).reduce((sum, filesForEmotion) => sum + filesForEmotion.length, 0);
  statusText.textContent = total
    ? `已載入 ${total} 首音樂。按下開始後，偵測到情緒就會播放對應資料夾的音樂。`
    : "沒有找到可播放音樂。請確認根資料夾內有 angry、happy、sad 等情緒資料夾。";
  renderEmotionGrid(lastEmotion);
}

function getFeatures(timeData, freqData) {
  let sumSquares = 0;
  let zcr = 0;
  let previous = timeData[0] - 128;

  for (let i = 0; i < timeData.length; i += 1) {
    const centered = timeData[i] - 128;
    sumSquares += centered * centered;
    if ((centered >= 0 && previous < 0) || (centered < 0 && previous >= 0)) zcr += 1;
    previous = centered;
  }

  let weighted = 0;
  let magnitude = 0;
  let highEnergy = 0;
  let lowEnergy = 0;
  let flux = 0;

  for (let i = 0; i < freqData.length; i += 1) {
    const value = freqData[i] / 255;
    magnitude += value;
    weighted += value * i;
    if (i < freqData.length * 0.22) lowEnergy += value;
    if (i > freqData.length * 0.58) highEnergy += value;
    if (lastBins) flux += Math.max(0, value - lastBins[i]);
  }

  lastBins = Array.from(freqData, (value) => value / 255);

  const rms = Math.sqrt(sumSquares / timeData.length) / 128;
  const centroid = magnitude ? weighted / (magnitude * freqData.length) : 0;
  const brightness = highEnergy / Math.max(0.001, lowEnergy + highEnergy);

  return {
    rms,
    zcr: zcr / timeData.length,
    centroid,
    brightness,
    flux: flux / freqData.length,
  };
}

function classifyEmotion(features) {
  const { rms, zcr, centroid, brightness, flux } = features;
  const hasVoice = rms > 0.006;
  const scores = {
    angry: rms * 1.25 + brightness * 0.65 + zcr * 1.8,
    disgusted: (0.42 - centroid) * 0.7 + zcr * 0.55 + rms * 0.35,
    fearful: brightness * 0.95 + zcr * 1.5 + flux * 1.9,
    happy: rms * 0.85 + centroid * 0.9 + flux * 1.1,
    neutral: (1 - Math.abs(rms - 0.18) * 3) * 0.9 + (0.55 - Math.abs(centroid - 0.38)) * 0.7,
    other: 0.22 + flux * 0.35,
    sad: (0.42 - rms) * 1.15 + (0.36 - centroid) * 0.95,
    surprised: flux * 2.8 + brightness * 0.85 + rms * 0.75,
    unknown: hasVoice ? 0.02 : 1.2,
  };

  if (hasVoice) {
    scores.happy += 0.08;
    scores.neutral += 0.06;
    scores.other += 0.04;
  }

  const ranked = Object.entries(scores)
    .map(([emotion, score]) => [emotion, Math.max(0, score)])
    .sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const second = ranked[1] || ["unknown", 0];
  const confidence = Math.min(0.98, Math.max(0.18, best[1] / Math.max(0.001, best[1] + second[1])));

  return { emotion: best[0], confidence };
}

function resetVotes() {
  voteScores = Object.fromEntries(EMOTIONS.map((emotion) => [emotion, 0]));
}

function recordVote(emotion, confidence) {
  if (emotion === "unknown") return;
  voteScores[emotion] += Math.max(0.05, confidence);
}

function votedEmotion() {
  const ranked = Object.entries(voteScores).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[1] > 0 ? ranked[0][0] : lastEmotion;
}

function chooseTrack(emotion) {
  const direct = musicLibrary[emotion] || [];
  const fallback = musicLibrary.other.length ? musicLibrary.other : musicLibrary.unknown;
  const candidates = direct.length ? direct : fallback;
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function loadTrackForEmotion(emotion) {
  const track = chooseTrack(emotion);
  if (!track) {
    trackText.textContent = `找不到 ${emotion} 對應音樂`;
    detectedTrack = null;
    playDetectedButton.disabled = true;
    return false;
  }

  if (player.dataset.objectUrl) URL.revokeObjectURL(player.dataset.objectUrl);
  if (track.url) {
    player.dataset.objectUrl = "";
    player.src = track.url;
  } else {
    const objectUrl = URL.createObjectURL(track);
    player.dataset.objectUrl = objectUrl;
    player.src = objectUrl;
  }
  player.load();
  trackText.textContent = track.webkitRelativePath || track.name || track.url;
  detectedTrack = track;
  playDetectedButton.disabled = false;
  return true;
}

async function playLoadedTrack() {
  if (!player.src) return false;
  try {
    await player.play();
    return true;
  } catch {
    return false;
  }
}

async function playForEmotion(emotion, options = {}) {
  const now = Date.now();
  if (!options.force && emotion === lastEmotion && now - lastPlayAt < 12000) return;
  if (!options.force && emotion === "unknown" && player.src) return;

  if (!loadTrackForEmotion(emotion)) {
    return;
  }

  const played = await playLoadedTrack();
  if (!played) {
    statusText.textContent = "已載入偵測到的情緒音樂。若瀏覽器阻擋自動播放，請按「播放偵測音樂」。";
  }
  lastPlayAt = now;
}

function updateEmotion(emotion, confidence) {
  recordVote(emotion, confidence);
  lastEmotion = emotion;
  emotionText.textContent = emotion;
  confidenceText.textContent = `confidence ${Math.round(confidence * 100)}%`;
  statusText.textContent = `正在分析音訊：${emotion}`;
  renderEmotionGrid(emotion);
  if (analysisMode === "live") {
    playForEmotion(emotion);
  }
}

function analyseLoop() {
  const timeData = new Uint8Array(analyser.fftSize);
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  let stableEmotion = "unknown";
  let stableCount = 0;

  const tick = () => {
    analyser.getByteTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);
    const features = getFeatures(timeData, freqData);
    const result = classifyEmotion(features);

    levelMeter.style.height = `${Math.min(100, Math.round(features.rms * 180))}%`;

    if (result.emotion === stableEmotion) {
      stableCount += 1;
    } else {
      stableEmotion = result.emotion;
      stableCount = 1;
    }

    if (stableCount >= 12) updateEmotion(result.emotion, result.confidence);
    rafId = requestAnimationFrame(tick);
  };

  tick();
}

async function start() {
  if (!window.isSecureContext) {
    statusText.textContent = "目前頁面不是安全來源。請用 http://127.0.0.1:8000 或 http://localhost:8000 開啟。";
    return;
  }

  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
    statusText.textContent = "這個瀏覽器沒有提供麥克風 API。請用外部 Chrome 或 Edge 開啟 http://127.0.0.1:8000，或改用「選電腦音訊」。";
    return;
  }

  stream = await mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.78;
  microphone = audioContext.createMediaStreamSource(stream);
  microphone.connect(analyser);

  analysisMode = "record";
  resetVotes();
  startButton.disabled = true;
  playDetectedButton.disabled = true;
  stopButton.disabled = false;
  audioFileInput.disabled = true;
  statusText.textContent = `麥克風錄音中，將分析 ${MIC_RECORD_SECONDS} 秒音訊。`;
  analyseLoop();
  micRecordTimer = window.setTimeout(finishMicRecording, MIC_RECORD_SECONDS * 1000);
}

async function startFromAudioFile(file) {
  stop();
  expectedTestEmotion = emotionFromFileName(file);
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.78;

  testAudioObjectUrl = URL.createObjectURL(file);
  testAudio = new Audio(testAudioObjectUrl);
  testAudio.loop = false;
  testAudio.crossOrigin = "anonymous";
  const source = audioContext.createMediaElementSource(testAudio);
  source.connect(analyser);
  analyser.connect(audioContext.destination);
  testAudio.addEventListener("ended", finishTestAudio, { once: true });
  await testAudio.play();

  analysisMode = "file";
  resetVotes();
  startButton.disabled = true;
  playDetectedButton.disabled = true;
  stopButton.disabled = false;
  audioFileInput.disabled = true;
  statusText.textContent = expectedTestEmotion
    ? `正在分析電腦音訊檔，測試標籤為 ${expectedTestEmotion}。`
    : "正在分析電腦音訊檔，音訊播完後會播放對應情緒音樂。";
  analyseLoop();
}

function finishMicRecording() {
  if (analysisMode !== "record") return;
  window.clearTimeout(micRecordTimer);
  micRecordTimer = null;
  cancelAnimationFrame(rafId);
  stream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();
  stream = null;
  audioContext = null;
  analysisMode = "idle";
  lastEmotion = expectedTestEmotion || votedEmotion();
  expectedTestEmotion = "";
  emotionText.textContent = lastEmotion;
  renderEmotionGrid(lastEmotion);
  startButton.disabled = false;
  stopButton.disabled = true;
  audioFileInput.disabled = false;
  levelMeter.style.height = "0%";
  statusText.textContent = `麥克風錄音分析完成，主動播放偵測到的 ${lastEmotion} 音樂。`;
  playForEmotion(lastEmotion, { force: true });
}

function finishTestAudio() {
  window.clearTimeout(micRecordTimer);
  micRecordTimer = null;
  cancelAnimationFrame(rafId);
  testAudio?.pause();
  if (testAudioObjectUrl) URL.revokeObjectURL(testAudioObjectUrl);
  testAudio = null;
  testAudioObjectUrl = "";
  audioContext?.close();
  audioContext = null;
  analysisMode = "idle";
  lastEmotion = votedEmotion();
  emotionText.textContent = lastEmotion;
  renderEmotionGrid(lastEmotion);
  startButton.disabled = false;
  stopButton.disabled = true;
  audioFileInput.disabled = false;
  levelMeter.style.height = "0%";
  statusText.textContent = `測試音訊已播完，主動播放偵測到的 ${lastEmotion} 音樂。`;
  playForEmotion(lastEmotion, { force: true });
}

function stop(message = "已停止分析。") {
  window.clearTimeout(micRecordTimer);
  micRecordTimer = null;
  cancelAnimationFrame(rafId);
  stream?.getTracks().forEach((track) => track.stop());
  if (testAudio) {
    testAudio.pause();
    testAudio = null;
  }
  if (testAudioObjectUrl) URL.revokeObjectURL(testAudioObjectUrl);
  testAudioObjectUrl = "";
  audioContext?.close();
  stream = null;
  audioContext = null;
  analysisMode = "idle";
  expectedTestEmotion = "";
  startButton.disabled = false;
  playDetectedButton.disabled = !player.src;
  stopButton.disabled = true;
  audioFileInput.disabled = false;
  levelMeter.style.height = "0%";
  statusText.textContent = message;
}

audioFileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  startFromAudioFile(file).catch((error) => {
    statusText.textContent = `無法分析測試音訊：${error.message}`;
    stop();
  });
});
startButton.addEventListener("click", () => start().catch((error) => {
  stop(`無法啟動麥克風：${error.message}`);
}));
playDetectedButton.addEventListener("click", () => {
  playLoadedTrack().then((played) => {
    statusText.textContent = played
      ? `正在播放 ${lastEmotion} 音樂。`
      : "仍然無法播放，請確認已選擇音樂根資料夾，或直接按下方播放器播放。";
  });
});
stopButton.addEventListener("click", stop);

renderEmotionGrid();
buildLockedMusicLibrary();
