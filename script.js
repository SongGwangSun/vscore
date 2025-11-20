// 게임 상태 관리
let gameState = {
    state: '',
    selectedGame: '',
    selectedLang: 'ko-KR',
    winScore: 11,
    totalSets: 3,
    currentSet: 1,
    player1Score: 0,
    player2Score: 0,
    player1Sets: 0,
    player2Sets: 0,
    scoreHistory: [],
    matchHistory: [],
    player1Name: 'Player 1',
    player2Name: 'Player 2',
    lastTapTime: 0,
    touchStartTime: 0,
    touchEndTime: 0
};

// 음성 합성 초기화
let speechSynthesis = window.speechSynthesis;
let speechUtterance = null;
// 캐시된 음성 목록
let voicesList = [];

// --- Recording state ---
let mediaRecorder = null;
let recordingStream = null;
let recordedChunks = [];
let currentRecordingFilename = null;
// cache of filename -> objectURL for playback (in-session) and loaded from IndexedDB
gameState.recordings = gameState.recordings || {};

// FFmpeg initialization
let ffmpegReady = false;
async function initFFmpeg() {
    try {
        if (typeof FFmpeg === 'undefined') return false;
        const { FFmpeg, fetchFile } = FFmpeg;
        if (ffmpegReady) return true;
        const ffmpeg = new FFmpeg.FFmpeg();
        if (!ffmpeg.isLoaded()) {
            await ffmpeg.load();
        }
        ffmpegReady = true;
        return true;
    } catch (e) {
        console.warn('FFmpeg init failed', e);
        return false;
    }
}

async function convertWebmToMp4(webmBlob, filename) {
    try {
        if (!await initFFmpeg()) return null; // fallback to webm if FFmpeg unavailable
        const { FFmpeg, fetchFile } = FFmpeg;
        const ffmpeg = new FFmpeg.FFmpeg();
        if (!ffmpeg.isLoaded()) await ffmpeg.load();
        const inputName = 'input.webm';
        const outputName = filename.replace('.webm', '.mp4');
        await ffmpeg.writeFile(inputName, await fetchFile(webmBlob));
        await ffmpeg.exec(['-i', inputName, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', outputName]);
        const mp4Data = await ffmpeg.readFile(outputName);
        const mp4Blob = new Blob([mp4Data.buffer], { type: 'video/mp4' });
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);
        return { blob: mp4Blob, filename: outputName };
    } catch (e) {
        console.warn('convertWebmToMp4 failed', e);
        return null;
    }
}

// IndexedDB helpers for storing video blobs persistently
function openVideoDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('vscore_videos', 1);
        req.onupgradeneeded = function (e) {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos');
        };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror = function (e) { reject(e.target.error); };
    });
}

function saveVideoToDB(filename, blob) {
    return openVideoDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('videos', 'readwrite');
        const store = tx.objectStore('videos');
        const putReq = store.put(blob, filename);
        putReq.onsuccess = () => { resolve(true); };
        putReq.onerror = (e) => { console.warn('saveVideoToDB error', e); reject(e); };
    })).catch(e => { console.warn('saveVideoToDB fail', e); });
}

function getVideoFromDB(filename) {
    return openVideoDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('videos', 'readonly');
        const store = tx.objectStore('videos');
        const getReq = store.get(filename);
        getReq.onsuccess = () => { resolve(getReq.result || null); };
        getReq.onerror = (e) => { reject(e); };
    })).catch(e => { console.warn('getVideoFromDB fail', e); return null; });
}

function getVideoURL(filename) {
    return new Promise(async (resolve) => {
        if (!filename) return resolve(null);
        if (gameState.recordings && gameState.recordings[filename]) return resolve(gameState.recordings[filename]);
        // try load from IndexedDB
        const blob = await getVideoFromDB(filename);
        if (blob) {
            const url = URL.createObjectURL(blob);
            gameState.recordings[filename] = url;
            return resolve(url);
        }
        resolve(null);
    });
}

function _qualityToBits(q) {
    switch ((q || '').toLowerCase()) {
        case 'low': return 400000; // ~400kbps
        case 'high': return 3000000; // ~3mbps
        default: return 1200000; // medium ~1.2mbps
    }
}

function startRecording() {
    try {
        const enabled = document.getElementById('enableRecording') ? document.getElementById('enableRecording').checked : false;
        if (!enabled) return Promise.resolve(null);
        // camera capture via getUserMedia
        const quality = document.getElementById('recordQuality') ? document.getElementById('recordQuality').value : 'medium';
        const bits = _qualityToBits(quality);
        const facing = document.getElementById('cameraFacing') ? document.getElementById('cameraFacing').value : 'user';
        const deviceSelect = document.getElementById('cameraDevice');
        let constraints = { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: facing } };
        if (deviceSelect && deviceSelect.value) {
            // prefer a specific deviceId if chosen
            constraints.video = { deviceId: { exact: deviceSelect.value } };
        }
        return navigator.mediaDevices.getUserMedia(constraints).then(stream => {
            recordingStream = stream;
            recordedChunks = [];
            let options = { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: bits };
            try { mediaRecorder = new MediaRecorder(stream, options); }
            catch (e) {
                try { mediaRecorder = new MediaRecorder(stream); } catch (err) { console.warn('MediaRecorder unsupported', err); return null; }
            }
            mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
            mediaRecorder.onstop = async function () {
                const webmBlob = new Blob(recordedChunks, { type: 'video/webm' });
                const now = new Date();
                const stamp = now.toISOString().replace(/[:-]/g, '').replace(/\.\d+Z$/, '');
                const gameName = getGameDisplayName(gameState.selectedGame) || 'game';
                let filename = `${stamp}_${gameName}.webm`;
                let saveBlob = webmBlob;
                let saveMimeType = 'video/webm';

                // on iOS, convert webm to mp4 for native Photos app compatibility
                const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
                if (isIOS) {
                    try {
                        const converted = await convertWebmToMp4(webmBlob, filename);
                        if (converted) {
                            filename = converted.filename;
                            saveBlob = converted.blob;
                            saveMimeType = 'video/mp4';
                        }
                    } catch (e) { console.warn('MP4 conversion failed, using webm fallback', e); }
                }

                currentRecordingFilename = filename;
                // save to IndexedDB for later playback
                try { await saveVideoToDB(filename, saveBlob); } catch (e) { console.warn('saveVideoToDB failed', e); }
                // keep in-session objectURL
                try { const url = URL.createObjectURL(saveBlob); gameState.recordings[filename] = url; } catch (e) { console.warn(e); }
                // on mobile, try to save to gallery using Web Share API or download
                try {
                    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
                    if (isMobile && navigator.share) {
                        // Use Web Share API to offer save/share options
                        try {
                            await navigator.share({ files: [new File([saveBlob], filename, { type: saveMimeType })] });
                        } catch (e) {
                            // User cancelled or share failed, fallback to download
                            const a = document.createElement('a');
                            const url = URL.createObjectURL(saveBlob);
                            a.href = url;
                            a.download = filename;
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                            setTimeout(() => URL.revokeObjectURL(url), 5000);
                        }
                    } else {
                        // Desktop or fallback: trigger standard download
                        const a = document.createElement('a');
                        const url = URL.createObjectURL(saveBlob);
                        a.href = url;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(() => URL.revokeObjectURL(url), 5000);
                    }
                } catch (e) { console.warn('save/download video failed', e); }
            };
            mediaRecorder.start();
            return true;
        }).catch(e => { console.warn('getUserMedia failed', e); return null; });
    } catch (err) { console.warn('startRecording error', err); return Promise.resolve(null); }
}

function stopRecording() {
    return new Promise((resolve) => {
        if (!mediaRecorder) return resolve(null);
        try {
            mediaRecorder.onstop = mediaRecorder.onstop || mediaRecorder.onstop;
            mediaRecorder.addEventListener('stop', function handler() {
                // after onstop handler above runs, currentRecordingFilename should be set
                const fn = currentRecordingFilename;
                // stop tracks
                try { if (recordingStream) recordingStream.getTracks().forEach(t => t.stop()); } catch (e) {}
                mediaRecorder = null; recordingStream = null; recordedChunks = [];
                resolve(fn || null);
            }, { once: true });
            // stop recorder (triggers onstop)
            if (mediaRecorder.state !== 'inactive') mediaRecorder.stop(); else resolve(currentRecordingFilename || null);
        } catch (e) { console.warn('stopRecording failed', e); resolve(null); }
    });
}

function loadVoices() {
    voicesList = speechSynthesis.getVoices() || [];
    // 일부 브라우저는 voices가 비동기 로드되므로 이벤트로 재시도
    if (voicesList.length === 0) {
        speechSynthesis.addEventListener('voiceschanged', function () {
            voicesList = speechSynthesis.getVoices() || [];
            console.log('Voices loaded:', voicesList.map(v => v.lang + ' - ' + v.name));
        });
    } else {
        console.log('Voices available:', voicesList.map(v => v.lang + ' - ' + v.name));
    }
}

// 초기 로드 시 음성 목록 불러오기
if (speechSynthesis) {
    loadVoices();
}

// Narration templates (multi-language)
const narrations = {
    gameStart: { ko: '게임 시작!', en: 'Game start!' },
    score: { ko: '{p1} 대 {p2}', en: '{p1} to {p2}' },
    Nextserve: { ko: '다음 서브!', en: 'Next Serve!' },
    right: { ko: '오른쪽!', en: 'Right' },
    left: { ko: '왼쪽!', en: 'Left !' },
    serveChange: { ko: '서브 교체!', en: 'Serve change!' },
    servePosition: { ko: '서브: 플레이어 {player}, {side}에서 서브하세요', en: 'Server {player}: serve from the {side}' },
    setWin: { ko: '플레이어 {player} 세트 승리!', en: 'Player {player} wins the set!' },
    setStart: { ko: '{set}세트 시작! 0 대 0', en: '{set} set start! 0 to 0' },
    gameEnd: { ko: '게임 종료! {winnerText}', en: 'Game over! {winnerText}' },
    reset: { ko: '0 대 0, 세트 리셋', en: '0 to 0, set reset' },
    undo: { ko: '실수 수정 완료', en: 'Undo complete' },
    courtSwap: { ko: '코트가 교체되었습니다.', en: 'Court switched.' }
};

function getLangCode() {
    const langSelect = document.getElementById('voiceLangSelect');
    const selected = (langSelect && langSelect.value) ? langSelect.value : 'ko-KR';
    return selected.split('-')[0] === 'ko' ? 'ko' : 'en';
}

function formatTemplate(template, vars) {
    return template.replace(/\{([^}]+)\}/g, (_, key) => (vars && vars[key] !== undefined) ? vars[key] : '');
}

function getNarrationText(key, vars) {
    const lang = getLangCode();
    console.log('getNarrationText key:', key, 'lang:', lang, 'vars:', vars);
    if (!narrations[key]) return '';

    // Special case for score in Korean to speak '십 대 ...' style when a player has 10
    if (key === 'score' && lang === 'ko') {
        const p1 = vars.p1, p2 = vars.p2;
        if (p1 === 10 || p2 === 10) {
            if (p1 === 10 && p2 !== 10) return `십 대 ${p2}`;
            if (p2 === 10 && p1 !== 10) return `${p1} 대 십`;
            return `십 대 십`;
        }
    }

    const template = narrations[key][lang] || narrations[key]['en'];
    console.log('getNarrationText template:', template, 'lang:', lang, 'vars:', vars);
    return formatTemplate(template, vars || {});
}

function speakNarration(key, vars) {
    const text = getNarrationText(key, vars);
    console.log('speakNarration text:', text);
    if (text) speakScore(text);
}

// Determine serve side (right/left) based on game rules (simplified)
function determineServeSide(serverPlayer) {
    const game = gameState.selectedGame;
    const serverScore = serverPlayer === 1 ? gameState.player1Score : gameState.player2Score;
    // Simplified rule: if server's score is even -> right, odd -> left
    // This matches badminton/pickleball singles conventions; applied to pingpong here for guidance.
    const sideKey = (serverScore % 2 === 0) ? 'right' : 'left';
    return sideKey;
}

function getSideLocalized(sideKey) {
    const lang = getLangCode();
    if (lang === 'ko') return sideKey === 'right' ? '오른쪽' : '왼쪽';
    return sideKey === 'right' ? 'right' : 'left';
}

function speakServePosition(serverPlayer) {
    const sideKey = determineServeSide(serverPlayer);
    const sideLocalized = getSideLocalized(sideKey);
    speakNarration('servePosition', { player: serverPlayer, side: sideLocalized });
}

// --- Player names & History utilities ---
function savePlayerNamesToStorage() {
    try {
        localStorage.setItem('vscore_players', JSON.stringify({ p1: gameState.player1Name, p2: gameState.player2Name }));
    } catch (e) { console.warn('savePlayerNamesToStorage failed', e); }
}

function loadPlayerNamesFromStorage() {
    try {
        const s = localStorage.getItem('vscore_players');
        if (s) {
            const obj = JSON.parse(s);
            gameState.player1Name = obj.p1 || gameState.player1Name;
            gameState.player2Name = obj.p2 || gameState.player2Name;
            const el1 = document.getElementById('playerReg1');
            const el2 = document.getElementById('playerReg2');
            if (el1) el1.value = gameState.player1Name;
            if (el2) el2.value = gameState.player2Name;
            updateScoreboard();
        }
    } catch (e) { console.warn('loadPlayerNamesFromStorage failed', e); }
}

// --- Saved names (pre-registered players) ---
function loadSavedNames() {
    try {
        const s = localStorage.getItem('vscore_saved_names');
        return s ? JSON.parse(s) : [];
    } catch (e) { console.warn('loadSavedNames failed', e); return []; }
}

function saveSavedNames(list) {
    try {
        localStorage.setItem('vscore_saved_names', JSON.stringify(list || []));
    } catch (e) { console.warn('saveSavedNames failed', e); }
}

function addSavedName(name) {
    if (!name) return;
    const list = loadSavedNames();
    if (!list.includes(name)) {
        list.push(name);
        saveSavedNames(list);
    }
}

function openPlayerNamesPicker(inputId) {
    const names = loadSavedNames();
    if (!names || names.length === 0) {
        alert('저장된 선수 이름이 없습니다. 선수 등록 후 사용하세요.');
        return;
    }
    document.getElementById('playerNamesPickerModal').dataset.inputId = inputId;
    renderPlayerNamesList();
    const modal = document.getElementById('playerNamesPickerModal');
    if (modal) modal.classList.add('active');
}

function closePlayerNamesPicker() {
    const modal = document.getElementById('playerNamesPickerModal');
    if (modal) modal.classList.remove('active');
}

function renderPlayerNamesList() {
    const container = document.getElementById('playerNamesList');
    if (!container) return;
    container.innerHTML = '';
    const names = loadSavedNames();
    if (!names || names.length === 0) { container.innerHTML = '<div style="color:#666;padding:0.5rem;">저장된 이름이 없습니다.</div>'; return; }
    names.forEach(n => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = n;
        btn.style.display = 'block';
        btn.style.width = '100%';
        btn.style.textAlign = 'left';
        btn.style.padding = '0.6rem';
        btn.style.border = 'none';
        btn.style.background = 'none';
        btn.style.cursor = 'pointer';
        btn.style.borderBottom = '1px solid #e6e6e6';
        btn.style.transition = 'background 0.2s';
        btn.addEventListener('mouseenter', () => btn.style.background = '#e8f0ff');
        btn.addEventListener('mouseleave', () => btn.style.background = 'none');
        btn.addEventListener('click', () => {
            const inputId = document.getElementById('playerNamesPickerModal').dataset.inputId;
            const input = document.getElementById(inputId);
            if (input) input.value = n;
            closePlayerNamesPicker();
        });
        container.appendChild(btn);
    });
}

function addNewSavedName() {
    const val = document.getElementById('newSavedName') ? document.getElementById('newSavedName').value.trim() : '';
    if (!val) return alert('이름을 입력하세요.');
    addSavedName(val);
    document.getElementById('newSavedName').value = '';
    renderSavedNamesList();
}

function openSavedNamesManager() {
    renderSavedNamesList();
    const modal = document.getElementById('savedNamesModal');
    if (modal) modal.classList.add('active');
}

function closeSavedNamesManager() {
    const modal = document.getElementById('savedNamesModal');
    if (modal) modal.classList.remove('active');
}

function renderSavedNamesList() {
    const container = document.getElementById('savedNamesList');
    if (!container) return;
    container.innerHTML = '';
    const list = loadSavedNames();
    if (!list || list.length === 0) { container.innerHTML = '<div style="color:#666;padding:0.5rem;">저장된 이름이 없습니다.</div>'; return; }
    list.forEach((n, idx) => {
        const row = document.createElement('div');
        row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.justifyContent = 'space-between'; row.style.padding = '0.35rem 0';
        const label = document.createElement('div'); label.textContent = n; label.style.flex = '1';
        const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='6px';
        const editBtn = document.createElement('button'); editBtn.textContent = '편집'; editBtn.className='modal-action'; editBtn.onclick = () => editSavedName(idx);
        const delBtn = document.createElement('button'); delBtn.textContent = '삭제'; delBtn.className='modal-action'; delBtn.onclick = () => { if(confirm('삭제하시겠습니까?')) { deleteSavedName(idx); } };
        actions.appendChild(editBtn); actions.appendChild(delBtn);
        row.appendChild(label); row.appendChild(actions);
        container.appendChild(row);
    });
}

function editSavedName(idx) {
    const list = loadSavedNames();
    const name = list[idx];
    const newName = prompt('이름을 편집하세요:', name);
    if (newName === null) return; // cancel
    const trimmed = (newName || '').trim();
    if (!trimmed) return alert('이름은 비어 있을 수 없습니다.');
    list[idx] = trimmed;
    saveSavedNames(list);
    renderSavedNamesList();
}

function deleteSavedName(idx) {
    const list = loadSavedNames();
    list.splice(idx,1);
    saveSavedNames(list);
    renderSavedNamesList();
}

function applyPlayerNames() {
    try {
        const n1 = document.getElementById('playerReg1') ? document.getElementById('playerReg1').value.trim() : '';
        const n2 = document.getElementById('playerReg2') ? document.getElementById('playerReg2').value.trim() : '';
        gameState.player1Name = n1 || 'Player 1';
        gameState.player2Name = n2 || 'Player 2';
        savePlayerNamesToStorage();
        // save into pre-registered names pool
        if (n1) addSavedName(n1);
        if (n2) addSavedName(n2);
        updateScoreboard();
    } catch (e) { console.warn('applyPlayerNames failed', e); }
}

function saveHistoryToStorage() {
    try {
        localStorage.setItem('vscore_history', JSON.stringify(gameState.matchHistory || []));
    } catch (e) { console.warn('saveHistoryToStorage failed', e); }
}

function loadHistoryFromStorage() {
    try {
        gameState.matchHistory = JSON.parse(localStorage.getItem('vscore_history') || '[]');
    } catch (e) { gameState.matchHistory = []; }
}

function addHistoryEntry(entry) {
    gameState.matchHistory = gameState.matchHistory || [];
    gameState.matchHistory.push(entry);
    saveHistoryToStorage();
}

function showHistory() {
    loadHistoryFromStorage();
    renderHistoryList();
    const modal = document.getElementById('historyModal');
    if (modal) modal.classList.add('active');
}

function renderVoiceLanguage() {
    const container = document.getElementById('voiceLanguage');
    if (!container) return;
    container.innerHTML = '';
}

function voiceLanguage() {
//    renderVoiceLanguage();
    const modal = document.getElementById('voiceLanguage');
    if (modal) modal.classList.add('active');
}
// About 모달 닫기
function closevoiceLanguage() {
    const modal = document.getElementById('voiceLanguage');
    if (modal) {
        modal.classList.remove('active');
    }
}

function toggleGameMenu() {
    const menu = document.getElementById('gameMenu');
    if (!menu) return;
    if (menu.style.display === 'none' || menu.style.display === '') menu.style.display = 'block';
    else menu.style.display = 'none';
}

function openPlayerRegistrationFromMenu() {
    toggleGameMenu();
    showScreen('gameSettings');
    setTimeout(() => {
        const el = document.getElementById('playerReg1');
        if (el) el.focus();
    }, 200);
}

function closeHistoryModal() {
    const modal = document.getElementById('historyModal');
    if (modal) modal.classList.remove('active');
}

function renderHistoryList() {
    const container = document.getElementById('historyList');
    if (!container) return;
    container.innerHTML = '';
    const entries = gameState._historyToRender || (gameState.matchHistory || []).slice().reverse();
    if (!entries || entries.length === 0) {
        container.innerHTML = '<div style="padding:0.5rem;color:#666">기록이 없습니다.</div>';
        return;
    }
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    const full = gameState.matchHistory || [];
    entries.forEach((e, i) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #eee';
        tr.style.cursor = 'pointer';
        tr.style.padding = '0';
        const td = document.createElement('td');
        td.style.padding = '0.45rem';
        td.innerHTML = `<strong>${e.date} ${e.time}</strong><br/>${e.game}<br/>${e.player1} ${e.score1} - ${e.player2} ${e.score2} (Set ${e.set})${e.memo ? '<br/><em>' + e.memo + '</em>' : ''}${e.video ? '<br/><small>Video: ' + e.video + '</small>' : ''}`;
        // compute original index in matchHistory
        const origIndex = full.length - 1 - i;
        tr.dataset.idx = String(origIndex);
        tr.appendChild(td);
        tr.addEventListener('click', () => openHistoryDetail(origIndex));
        table.appendChild(tr);
    });
    container.appendChild(table);
}

function applyHistoryFilters() {
    const dateVal = document.getElementById('historyFilterDate') ? document.getElementById('historyFilterDate').value : '';
    const playerVal = document.getElementById('historyFilterPlayer') ? (document.getElementById('historyFilterPlayer').value || '').trim().toLowerCase() : '';
    const gameVal = document.getElementById('historyFilterGame') ? (document.getElementById('historyFilterGame').value || '').trim() : '';
    const list = (gameState.matchHistory || []).filter(e => {
        let ok = true;
        if (dateVal) ok = ok && (e.date === new Date(dateVal).toLocaleDateString('ko-KR'));
        if (playerVal) ok = ok && ( (e.player1 && e.player1.toLowerCase().includes(playerVal)) || (e.player2 && e.player2.toLowerCase().includes(playerVal)) );
        if (gameVal) ok = ok && (e.game === gameVal);
        return ok;
    });
    // store reversed list to render with consistent indexing
    gameState._historyToRender = list.slice().reverse();
    renderHistoryList();
}

function clearHistoryFilters() {
    if (document.getElementById('historyFilterDate')) document.getElementById('historyFilterDate').value = '';
    if (document.getElementById('historyFilterPlayer')) document.getElementById('historyFilterPlayer').value = '';
    if (document.getElementById('historyFilterGame')) document.getElementById('historyFilterGame').value = '';
    gameState._historyToRender = null;
    renderHistoryList();
}

function openHistoryDetail(origIndex) {
    const rec = (gameState.matchHistory || [])[origIndex];
    if (!rec) return alert('레코드를 찾을 수 없습니다');
    document.getElementById('detailDate').value = rec.date || '';
    document.getElementById('detailTime').value = rec.time || '';
    document.getElementById('detailGame').value = rec.game || '';
    document.getElementById('detailP1').value = rec.player1 || '';
    document.getElementById('detailS1').value = rec.score1 || '';
    document.getElementById('detailP2').value = rec.player2 || '';
    document.getElementById('detailS2').value = rec.score2 || '';
    document.getElementById('detailSet').value = rec.set || '';
    document.getElementById('detailMemo').value = rec.memo || '';
    document.getElementById('historyDetailModal').dataset.idx = String(origIndex);
    // show video if present
    const videoEl = document.getElementById('detailVideo');
    const videoNameEl = document.getElementById('detailVideoName');
    const downloadBtn = document.getElementById('detailVideoDownloadBtn');
    if (rec.video) {
        videoNameEl.textContent = rec.video || '';
        // try to get URL from IndexedDB or in-memory
        getVideoURL(rec.video).then(url => {
            if (url) {
                videoEl.src = url; videoEl.style.display = '';
                if (downloadBtn) downloadBtn.style.display = '';
                // store the current video filename for download
                document.getElementById('historyDetailModal').dataset.videoFile = rec.video;
            } else {
                videoEl.src = '';
                videoEl.style.display = 'none';
                if (downloadBtn) downloadBtn.style.display = 'none';
            }
        });
    } else {
        if (videoEl) { videoEl.src = ''; videoEl.style.display = 'none'; }
        if (videoNameEl) videoNameEl.textContent = '';
        if (downloadBtn) downloadBtn.style.display = 'none';
    }
    const modal = document.getElementById('historyDetailModal'); if (modal) modal.classList.add('active');
}

function downloadDetailVideo() {
    const modal = document.getElementById('historyDetailModal');
    const filename = modal.dataset.videoFile;
    if (!filename) return alert('비디오 파일이 없습니다.');
    getVideoURL(filename).then(url => {
        if (url) {
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
        } else {
            alert('비디오를 로드할 수 없습니다. 나중에 다시 시도해주세요.');
        }
    });
}

function closeHistoryDetail() {
    const modal = document.getElementById('historyDetailModal'); if (modal) modal.classList.remove('active');
}

function saveHistoryDetail() {
    const idx = parseInt(document.getElementById('historyDetailModal').dataset.idx,10);
    if (isNaN(idx)) return;
    const rec = (gameState.matchHistory || [])[idx]; if (!rec) return;
    rec.time = document.getElementById('detailTime').value;
    rec.game = document.getElementById('detailGame').value;
    rec.player1 = document.getElementById('detailP1').value;
    rec.score1 = parseInt(document.getElementById('detailS1').value,10) || 0;
    rec.player2 = document.getElementById('detailP2').value;
    rec.score2 = parseInt(document.getElementById('detailS2').value,10) || 0;
    rec.set = parseInt(document.getElementById('detailSet').value,10) || rec.set;
    rec.memo = document.getElementById('detailMemo').value;
    saveHistoryToStorage();
    closeHistoryDetail();
    clearHistoryFilters();
}

function deleteHistoryDetail() {
    if (!confirm('이 기록을 삭제하시겠습니까?')) return;
    const idx = parseInt(document.getElementById('historyDetailModal').dataset.idx,10);
    if (isNaN(idx)) return;
    (gameState.matchHistory || []).splice(idx,1);
    saveHistoryToStorage();
    closeHistoryDetail();
    renderHistoryList();
}

function clearHistory() {
    if (!confirm('모든 기록을 삭제하시겠습니까?')) return;
    gameState.matchHistory = [];
    saveHistoryToStorage();
    renderHistoryList();
}

function exportHistory() {
    try {
        const rows = [['일자','시간','경기명','선수이름','점수','선수이름','점수','세트 번호','메모']];
        (gameState.matchHistory || []).forEach(e => rows.push([e.date, e.time, e.game, e.player1, e.score1, e.player2, e.score2, e.set, e.memo || '']));
        const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
        // Add UTF-8 BOM (\uFEFF) at the beginning so Excel recognizes Korean text properly
        const bom = '\uFEFF';
        const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'vscore_history.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (e) { console.warn('exportHistory failed', e); }
}

function getGameDisplayName(code) {
    const m = { 'pickleball': '피클볼', 'pingpong': '탁구', 'badminton': '배드민턴', 'Jokgu': '족구' };
    return m[code] || code || '';
}

// 서브 체인지 알림 (탁구/배드민턴/피클볼)
let serveChangeRule = 2; // 예: 2점마다 서브 교체 (게임 설정에서 받아옴)
let totalPoints = 0;     // 두 선수 점수 합
let currentServer = 1;  // 1번 또는 2번 플레이어가 서브권
let ServerCount = 1;    // 배드민턴 서브 규칙 (처음만 1인 서브 교체)
let ServerChange = 0;   // 서브 교체
let lastAction = 'endSet';  // default last action

// 게임 선택
function selectGame(game) {
    console.log('selectGame called with:', game);
    gameState.selectedGame = game;
    const gameNames = {
        'pickleball': '피클볼',
        'pingpong': '탁구',
        'badminton': '배드민턴',
        'Jokgu': '족구'

    };
    document.getElementById('selectedGameTitle').textContent = `${gameNames[game]} 게임 설정(Setting)`;
    showScreen('gameSettings');

    updateMatchTypeVisibility(game);
}

// 게임 시작
function startGame() {
    console.log('startGame called');

    const winScoreRange = document.getElementById('winScoreRange');
    gameState.winScore = winScoreRange ? parseInt(winScoreRange.value, 10) : 11;

    const totalSetsRange = document.getElementById('totalSetsRange');
    const matchTypeInput = document.querySelector('input[name="matchType"]:checked');

    if (!winScoreRange || !totalSetsRange) {
        alert('게임 설정을 선택해주세요. (Please select game settings.)');
        return;
    }

    gameState.totalSets = parseInt(totalSetsRange.value);
    gameState.currentSet = 1;
    gameState.player1Score = 0;
    gameState.player2Score = 0;
    gameState.player1Sets = 0;
    gameState.player2Sets = 0;
    gameState.scoreHistory = [];

    serveChangeRule = 2; // 예: 2점마다 서브 교체 (게임 설정에서 받아옴)
    totalPoints = 0;     // 두 선수 점수 합
    currentServer = 1;  // 1번 또는 2번 플레이어가 서브권
    ServerCount = 1;    // 배드민턴 서브 규칙 (처음만 1인 서브 교체)
    ServerChange = 0;   // 서브 교체
    lastAction = 'endSet';  // default last action

    gameState.matchType = matchTypeInput ? matchTypeInput.value : 'single';

    // 경기 방식에 따라 서브 교체 룰 결정
    let isSingle = gameState.matchType === 'single';
    if (gameState.selectedGame == 'pingpong') {
        // serveChangeRule = isSingle ? 2 : 5; // 단식 2점, 복식 5점마다 서브 교체
        serveChangeRule = 2; // 단식, 복식 2점마다 서브 교체
    } else if (gameState.selectedGame == 'badminton' || gameState.selectedGame == 'pickleball') {
        serveChangeRule = isSingle ? 1 : 2; // 단식 1점, 복식 2점마다 서브 교체
    }

    const langSelect = document.getElementById('voiceLangSelect');
    gameState.selectedLang = (langSelect && langSelect.value) ? langSelect.value : 'ko-KR';

    updateScoreboard();
    showScreen('scoreboard');

    gameState.state = 'inGame';
    // 게임 시작 안내
    speakNarration('gameStart');
    // announce initial serve position
    setTimeout(() => speakServePosition(currentServer), 600);
    // start recording if enabled
    try {
        startRecording().then(res => {
            if (res === null) console.log('Recording not started or was declined/not supported');
            else console.log('Recording started');
        });
    } catch (e) { console.warn('startRecording call failed', e); }
}

// 화면 전환
function showScreen(screenId) {
    console.log('showScreen called with:', screenId);

    // 모든 화면 비활성화
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });

    // 지정된 화면 활성화
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.add('active');
        console.log('Screen activated:', screenId);
    } else {
        console.error('Screen not found:', screenId);
    }

    // 모바일에서 전체화면 설정
    if (screenId === 'scoreboard' || screenId === 'gameSettings') {
        document.body.classList.add('fullscreen');
        // 모바일에서 화면 방향 고정
        if (targetScreen && targetScreen.orientation && targetScreen.orientation.lock) {
            targetScreen.orientation.lock('portrait').catch(() => {
                // 방향 잠금이 지원되지 않는 경우 무시
            });
        }
    } else {
        document.body.classList.remove('fullscreen');
    }

    // If user navigates to game settings, ensure match-type visibility reflects the selected game
    // if (screenId === 'gameSettings') {
    //     try {
    //         updateMatchTypeVisibility(gameState.selectedGame || '');
    //     } catch (e) {
    //         console.warn('updateMatchTypeVisibility not available yet', e);
    //     }
    // }
}

// 점수판 업데이트
function updateScoreboard() {
    document.getElementById('score1').textContent = gameState.player1Score;
    document.getElementById('score2').textContent = gameState.player2Score;
    document.getElementById('player1SetsInline').textContent = gameState.player1Sets;
    document.getElementById('player2SetsInline').textContent = gameState.player2Sets;
    // 선수 이름 UI 반영
    const pn1 = document.querySelector('#player1Score .player-name');
    const pn2 = document.querySelector('#player2Score .player-name');
    if (pn1) pn1.innerHTML = `${gameState.player1Name} - <span id="player1SetsInline">${gameState.player1Sets}</span>`;
    if (pn2) pn2.innerHTML = `${gameState.player2Name} - <span id="player2SetsInline">${gameState.player2Sets}</span>`;
    updateServeColor();
}

// 점수 증가
function increaseScore(player) {
    if (gameState.state != 'inGame') return;
    const currentTime = new Date().getTime();
    const timeDiff = currentTime - gameState.lastTapTime;

    gameState.lastTapTime = currentTime;

    // 점수 기록
    gameState.scoreHistory.push({
        player: player,
        action: 'increase',
        score: player === 1 ? gameState.player1Score : gameState.player2Score,
        set: gameState.currentSet
    });

    // 점수 증가
    updateScore(player, 1);
}


function updateScore(player, delta) {
    if (lastAction != 'endSet') return;

    // console.log('updateScore lastAction : ', lastAction);

    lastAction = 'updateScore'; // Keep formatting consistent

    totalPoints = gameState.player1Score + gameState.player2Score;

    let player1ScoreBefore = gameState.player1Score;
    let player2ScoreBefore = gameState.player2Score;

    if (player === 1) {
        player1ScoreBefore += delta;
    } else {
        player2ScoreBefore += delta;
    }

    // 듀스 상황 체크
    let isDeuce = (player1ScoreBefore >= gameState.winScore - 1 &&
        player2ScoreBefore >= gameState.winScore - 1);

    let serveChanged = 0; // 서브 교체 여부, 0 - 없음, 1 - 1번 플레이어 서브, 2 - 2번 플레이어 서브

    // 서브권 계산
    if (totalPoints === 0) {
        if (gameState.selectedGame == 'badminton' || gameState.selectedGame == 'pickleball') {
            currentServer = 1; // 첫 서브는 1번 플레이어
            serveChanged = currentServer == player ? 0 : 2;
            currentServer = player; // 서브권을 점수 올린 플레이어로 변경
            ServerCount = 2;
        }
    } else {
        if (gameState.selectedGame == 'badminton' || gameState.selectedGame == 'pickleball') {
            if (gameState.matchType === 'single') {
                // 단식인 경우 바로 서브 교체
                serveChanged = currentServer == player ? 0 : 2;
                currentServer = player; // 서브권을 점수 올린 플레이어로 변경
            }
            else {
                if (currentServer != player) {
                    if (ServerCount == 1) {
                        serveChanged = 1;
                        ServerCount = 2;
                    }
                    else if (ServerCount == 2) {
                        ServerCount = 1;        // 서브권이 바뀌었으므로 1로 변경
                        serveChanged = 2;
                        currentServer = player; // 서브권을 점수 올린 플레이어로 변경
                    }
                }
            }
        }
        else if (gameState.selectedGame == 'pingpong') {
            if (currentServer != player) {
                if (ServerCount == 1) {
                    serveChanged = 1;
                    ServerCount = 2;
                }
                else if (ServerCount == 2) {
                    ServerCount = 1;        // 서브권이 바뀌었으므로 1로 변경
                    serveChanged = 2;
                    currentServer = player; // 서브권을 점수 올린 플레이어로 변경
                }
            }
        }
        else if (gameState.selectedGame == 'Jokgu') {
            if (currentServer != player) {
                currentServer = player;
                serveChanged = 2;
            }
        }
    }

    // speak score using narration templates
    speakNarration('score', { p1: player1ScoreBefore, p2: player2ScoreBefore });

    gameState.player1Score = player1ScoreBefore;
    gameState.player2Score = player2ScoreBefore;
    updateScoreboard();

    const player1Wins = player1ScoreBefore >= gameState.winScore &&
        (player1ScoreBefore - player2ScoreBefore) >= 2;
    const player2Wins = player2ScoreBefore >= gameState.winScore &&
        (player2ScoreBefore - player1ScoreBefore) >= 2;

    if (player1Wins || player2Wins) {
        const winner = player1Wins ? 1 : 2;
        endSet(winner);
    }
    else {
        // serveChanged가 1: 다음서브, 2면 서브 교체 알림
        if (serveChanged == 1) {
            showNextServeAlert(player);
            // also announce which side to serve from
            setTimeout(() => speakServePosition(currentServer), 300);
        }
        else if (serveChanged == 2) {
            showServeChangeAlert();
            // also announce which side to serve from
            setTimeout(() => speakServePosition(currentServer), 300);
        }
    }
    lastAction = 'endSet';
    // console.log('updateScore exit lastAction : ', lastAction);
}

function updateServeColor() {
    document.getElementById('score1').classList.toggle('serve', currentServer === 1);
    document.getElementById('score2').classList.toggle('serve', currentServer === 2);
}

function showServeChangeAlert() {
    // 화면에 서브 교체 알림 표시
    const alert = document.createElement('div');
    alert.className = 'serve-change-alert';
    alert.textContent = '서브 교체\nServe change !';
    speakNarration('serveChange');
    document.body.appendChild(alert);
    setTimeout(() => alert.remove(), 1500); // 1.5초 후 자동 제거
}

function showNextServeAlert(serverPlayer) {
    // 화면에 다음 서브 알림 표시
    const alert = document.createElement('div');
    const sideKey = determineServeSide(serverPlayer);

    alert.className = 'serve-change-alert';
    const textContent = sideKey === '오른쪽' ? 'right' : 'left';
    alert.textContent = '다음 서브' + getSideLocalized(sideKey) + '\nNext Serve \n' + textContent;

    speakNarration('Nextserve', { sideKey });
    document.body.appendChild(alert);
    setTimeout(() => alert.remove(), 1500); // 1.5초 후 자동 제거
}

// 세트 종료 확인
function checkSetEnd() {
    const player1Wins = gameState.player1Score >= gameState.winScore &&
        (gameState.player1Score - gameState.player2Score) >= 2;
    const player2Wins = gameState.player2Score >= gameState.winScore &&
        (gameState.player2Score - gameState.player1Score) >= 2;

    if (player1Wins || player2Wins) {
        const winner = player1Wins ? 1 : 2;
        endSet(winner);
    }
}

// 세트 종료
function endSet(winner) {
    gameState.state = 'setEnd';
    if (winner === 1) {
        gameState.player1Sets++;
        speakNarration('setWin', { player: 1 });
    } else {
        gameState.player2Sets++;
        speakNarration('setWin', { player: 2 });
    }

    updateScoreboard();

    // --- 기록 저장 ---
    try {
        const now = new Date();
        const date = now.toLocaleDateString('ko-KR');
        const time = now.toLocaleTimeString('ko-KR');
        const memo = document.getElementById('setMemoInput') ? document.getElementById('setMemoInput').value : '';
        addHistoryEntry({
            date,
            time,
            game: getGameDisplayName(gameState.selectedGame),
            player1: gameState.player1Name,
            score1: gameState.player1Score,
            player2: gameState.player2Name,
            score2: gameState.player2Score,
            set: gameState.currentSet,
            memo,
            video: null
        });
    } catch (e) { console.warn('set history save failed', e); }

    // 게임 종료 확인
    const neededSets = Math.ceil(gameState.totalSets / 2);
    if (gameState.player1Sets >= neededSets || gameState.player2Sets >= neededSets) {
        // stop recording if active, then attach filename to the latest history entry and end game
        stopRecording().then(filename => {
            try {
                if (filename) {
                    const idx = (gameState.matchHistory || []).length - 1;
                    if (idx >= 0) {
                        const rec = gameState.matchHistory[idx];
                        rec.video = filename;
                        saveHistoryToStorage();
                    }
                }
            } catch (e) { console.warn('attach recording filename failed', e); }
            endGame();
        }).catch(e => { console.warn('stopRecording failed', e); endGame(); });
    } else {
        // 다음 세트 시작
        setTimeout(() => {
            gameState.currentSet++;
            gameState.player1Score = 0;
            gameState.player2Score = 0;
            gameState.state = 'inGame';

            updateScoreboard();
            speakNarration('setStart', { set: gameState.currentSet });
        }, 2000);
    }
}

// 게임 종료
function endGame() {
    const winner = gameState.player1Sets > gameState.player2Sets ? 1 : 2;
    const winnerName = winner === 1 ? gameState.player1Name : gameState.player2Name;
    const winnerText = `${winnerName} 승리(Winner)!`;
    const finalScore = `${gameState.player1Sets} - ${gameState.player2Sets}`;

    document.getElementById('winnerText').textContent = winnerText;
    document.getElementById('finalScore').textContent = gameState.player1Sets;
    document.getElementById('finalScore2').textContent = gameState.player2Sets;
    document.getElementById('finalScoreSets').textContent = finalScore + ' 세트(Sets)';
    document.getElementById('player1DisplayName').textContent = gameState.player1Name;
    document.getElementById('player2DisplayName').textContent = gameState.player2Name;

    speakNarration('gameEnd', { winnerText });

    // also announce via narration object
    // show game end screen after a short delay
    setTimeout(() => {
        showScreen('gameEnd');
    }, 3000);
}

// 세트 리셋
function resetSet() {
    gameState.player1Score = 0;
    gameState.player2Score = 0;
    updateScoreboard();
    speakNarration('reset');
}

// 마지막 점수 취소
function undoLastScore() {
    if (gameState.scoreHistory.length > 0) {
        const lastAction = gameState.scoreHistory.pop();
        if (lastAction.action === 'increase') {
            if (lastAction.player === 1) {
                gameState.player1Score--;
            } else {
                gameState.player2Score--;
            }
        }
        updateScoreboard();
        speakNarration('undo');
    }
}

// 음성 안내
function speakScore(text) {
    if (speechSynthesis) {
        // 이전 음성 중지
        if (speechUtterance) {
            speechSynthesis.cancel();
        }

        console.log('speakScore text:', text, 'selectedLang:', gameState.selectedLang);

        speechUtterance = new SpeechSynthesisUtterance(text);
        speechUtterance.lang = gameState.selectedLang;
        speechUtterance.rate = 0.85;
        speechUtterance.pitch = 1.0;

        // 가능한 음성 중에서 선택된 언어와 매칭되는 음성 찾기
        try {
            const voices = voicesList.length ? voicesList : speechSynthesis.getVoices();
            if (voices && voices.length) {
                // 우선 정확한 locale 매칭
                let matched = voices.find(v => v.lang === gameState.selectedLang);
                if (!matched) {
                    // lang 코드의 앞부분으로 매칭 (eg. 'en' matches 'en-US')
                    const langPrefix = gameState.selectedLang.split('-')[0];
                    matched = voices.find(v => v.lang && v.lang.indexOf(langPrefix) === 0);
                }
                if (matched) {
                    speechUtterance.voice = matched;
                }
            }
        } catch (err) {
            // 안전한 실패: 아무 것도 하지 않음
            console.warn('voice selection failed', err);
        }

        speechSynthesis.speak(speechUtterance);
    }
}

// 게임 선택 화면으로 이동
function showGameSelection() {
    console.log('showGameSelection called');
    showScreen('gameSelection');
}

// 게임 설정 화면으로 이동
function showGameSettings() {
    console.log('showGameSettings called');
    showScreen('gameSettings');
}

// 모바일 터치 이벤트 처리
function handlePlayerScore(player) {
    const currentTime = new Date().getTime();
    const timeDiff = currentTime - gameState.lastTapTime;

    // 단일 탭 - 점수 증가
    increaseScore(player);

    gameState.lastTapTime = currentTime;
}

// 코트 전환
function switchCourt() {
    // 플레이어 점수, 세트, 이름 등 좌우 교체
    [gameState.player1Score, gameState.player2Score] = [gameState.player2Score, gameState.player1Score];
    [gameState.player1Sets, gameState.player2Sets] = [gameState.player2Sets, gameState.player1Sets];
    [gameState.player1Name, gameState.player2Name] = [gameState.player2Name, gameState.player1Name];
    updateScoreboard();
    currentServer = currentServer == 1 ? 2 : 1;
    updateServeColor();

    speakNarration('courtSwap');
    setTimeout(() => speakServePosition(currentServer), 300);
}

// 정보 보기
function showAbout() {
    const aboutModal = document.getElementById('aboutModal');
    if (aboutModal) {
        aboutModal.classList.add('active');
    }
}

// About 모달 닫기
function closeAboutModal() {
    const aboutModal = document.getElementById('aboutModal');
    if (aboutModal) {
        aboutModal.classList.remove('active');
    }
}

// 초기화 함수
function initializeApp() {
    console.log('Initializing app...');

    // 모든 화면을 먼저 비활성화
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
        console.log('Deactivated screen:', screen.id);
    });

    // 초기 화면을 게임 선택 화면으로 설정
    const gameSelectionScreen = document.getElementById('gameSelection');
    if (gameSelectionScreen) {
        gameSelectionScreen.classList.add('active');
        console.log('Activated gameSelection screen');
    } else {
        console.error('gameSelection screen not found!');
    }

    // ...existing code...
    const winScoreRange = document.getElementById('winScoreRange');
    const winScoreValue = document.getElementById('winScoreValue');
    if (winScoreRange && winScoreValue) {
        winScoreRange.value = gameState.winScore || 11;
        winScoreValue.textContent = winScoreRange.value;
    }
    // ...existing code...

    // 게임 상태 초기화
    gameState.selectedGame = '';
    gameState.winScore = 11;
    gameState.totalSets = 3;
    gameState.currentSet = 1;
    gameState.player1Score = 0;
    gameState.player2Score = 0;
    gameState.player1Sets = 0;
    gameState.player2Sets = 0;
    gameState.scoreHistory = [];

    // 현재 활성화된 화면 확인
    const activeScreen = document.querySelector('.screen.active');
    console.log('Currently active screen:', activeScreen ? activeScreen.id : 'none');

    console.log('App initialized successfully');
}

// 이벤트 리스너 설정
document.addEventListener('DOMContentLoaded', function () {
    console.log('DOM Content Loaded');

    // 앱 초기화
    initializeApp();

    // load stored player names and history and saved names
    loadPlayerNamesFromStorage();
    loadHistoryFromStorage();
    // ensure saved names exists (no-op if absent)
    loadSavedNames();

    // 플레이어 1 점수 터치
    const player1Score = document.getElementById('player1Score');
    const player2Score = document.getElementById('player2Score');

    if (player1Score && player2Score) {
        // 클릭 이벤트
        player1Score.addEventListener('click', function (e) {
            e.preventDefault();
            handlePlayerScore(1);
        });

        player2Score.addEventListener('click', function (e) {
            e.preventDefault();
            handlePlayerScore(2);
        });

        // 키보드 이벤트 (접근성)
        player1Score.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handlePlayerScore(1);
            }
        });

        player2Score.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handlePlayerScore(2);
            }
        });
    }

    // 모바일 터치 이벤트 최적화
    let touchStartTime = 0;
    let touchEndTime = 0;
    let touchStartX = 0;
    let touchStartY = 0;

    // 터치 시작
    document.addEventListener('touchstart', function (e) {
        touchStartTime = new Date().getTime();
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });

    // 터치 종료
    document.addEventListener('touchend', function (e) {
        touchEndTime = new Date().getTime();
        const touchDuration = touchEndTime - touchStartTime;
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        const touchDistance = Math.sqrt(
            Math.pow(touchEndX - touchStartX, 2) +
            Math.pow(touchEndY - touchStartY, 2)
        );

        // 짧은 터치만 처리 (길게 누르기 방지) 및 이동 거리가 짧은 경우만
        if (touchDuration < 500 && touchDistance < 50) {
            const target = e.target.closest('.player-score');
            if (target) {
                e.preventDefault();
                const player = target.id === 'player1Score' ? 1 : 2;
                handlePlayerScore(player);
            }
        }
    }, { passive: false });

    // 키보드 단축키
    document.addEventListener('keydown', function (e) {
        if (document.getElementById('scoreboard').classList.contains('active')) {
            switch (e.key) {
                case '1':
                    handlePlayerScore(1);
                    break;
                case '2':
                    handlePlayerScore(2);
                    break;
                case 'r':
                case 'R':
                    resetSet();
                    break;
                case 'z':
                case 'Z':
                    undoLastScore();
                    break;
            }
        }
    });

    // 모바일 볼륨 버튼으로 점수 올리기
    window.addEventListener('keydown', function (e) {
        // 볼륨 업: 'VolumeUp', 볼륨 다운: 'VolumeDown'
        if (document.getElementById('scoreboard').classList.contains('active')) {
            if (e.code === 'AudioVolumeUp' || e.key === 'VolumeUp') {
                // Play1 점수 증가
                increaseScore(1);
                e.preventDefault();
            } else if (e.code === 'AudioVolumeDown' || e.key === 'VolumeDown') {
                // Play2 점수 증가
                increaseScore(2);
                e.preventDefault();
            }
        }
    }, { passive: false });

    // 화면 방향 변경 감지
    window.addEventListener('orientationchange', function () {
        setTimeout(function () {
            // 화면 크기 재조정
            document.body.style.height = window.innerHeight + 'px';
            document.body.style.width = window.innerWidth + 'px';
        }, 100);
    });

    // 리사이즈 이벤트
    window.addEventListener('resize', function () {
        document.body.style.height = window.innerHeight + 'px';
        document.body.style.width = window.innerWidth + 'px';
    });

    // 초기 화면 크기 설정
    document.body.style.height = window.innerHeight + 'px';
    document.body.style.width = window.innerWidth + 'px';

    // 모바일 전체화면 설정
    if (window.innerWidth <= 768) {
        document.body.classList.add('mobile');
    }

    // iOS Safari 최적화
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
        document.body.classList.add('ios');
    }

    // Android Chrome 최적화
    if (/Android/.test(navigator.userAgent)) {
        document.body.classList.add('android');
    }

    console.log('Event listeners set up successfully');

    // Keep selected voice language in sync
    const langSelect = document.getElementById('voiceLangSelect');
    if (langSelect) {
        // initialize
        gameState.selectedLang = langSelect.value || gameState.selectedLang;
        langSelect.addEventListener('change', function () {
            gameState.selectedLang = this.value;
            // reload voices to pick best match
            loadVoices();
        });
    }

    // populate camera devices and wire camera-facing UI
    async function populateCameras() {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoInputs = devices.filter(d => d.kind === 'videoinput');
            const deviceSelect = document.getElementById('cameraDevice');
            const deviceLabel = document.getElementById('deviceLabel');
            const facingSelect = document.getElementById('cameraFacing');
            if (videoInputs && videoInputs.length > 0) {
                // if multiple devices, show device list for desktops
                if (deviceSelect) {
                    deviceSelect.innerHTML = '';
                    videoInputs.forEach(d => {
                        const opt = document.createElement('option');
                        opt.value = d.deviceId;
                        opt.textContent = d.label || ('Camera ' + (deviceSelect.length + 1));
                        deviceSelect.appendChild(opt);
                    });
                }
                // show device label only if multiple devices
                if (deviceLabel) deviceLabel.style.display = videoInputs.length > 1 ? '' : 'none';
                // if there's at least one camera, allow facing control for mobile
                if (facingSelect) facingSelect.style.display = '';
            }
        } catch (e) { console.warn('populateCameras failed', e); }
    }

    // run once to populate
    populateCameras();

    // allow manual refresh (in case user plugs in camera)
    try { window.addEventListener('focus', populateCameras); } catch (e) {}
});

// PWA 지원을 위한 서비스 워커 등록 (일시적으로 비활성화)

if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js')
            .then(function (registration) {
                console.log('ServiceWorker registration successful');
            })
            .catch(function (err) {
                console.log('ServiceWorker registration failed');
            });
    });
}

// 앱 설치 프롬프트 (일시적으로 비활성화)
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

// 오프라인 지원을 위한 캐시 (일시적으로 비활성화)
if ('caches' in window) {
    caches.open('scoreboard').then(function (cache) {
        return cache.addAll([
            './',
            './index.html',
            './style.css',
            './script.js',
            './manifest.json'
        ]);
    });
}

function updateMatchTypeVisibility(game) {
    const matchTypeGroup = document.getElementById('matchTypeGroup');
    if (game === 'pingpong' || game === 'badminton' || game === 'pickleball') {
        matchTypeGroup.style.display = '';
    } else {
        matchTypeGroup.style.display = 'none';
    }
}



