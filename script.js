// 게임 상태 관리
let gameState = {
    selectedGame: '',
    winScore: 11,
    totalSets: 3,
    currentSet: 1,
    player1Score: 0,
    player2Score: 0,
    player1Sets: 0,
    player2Sets: 0,
    scoreHistory: [],
    lastTapTime: 0,
    doubleTapDelay: 300,
    touchStartTime: 0,
    touchEndTime: 0
};

// 음성 합성 초기화
let speechSynthesis = window.speechSynthesis;
let speechUtterance = null;

// 게임 선택
function selectGame(game) {
    console.log('selectGame called with:', game);
    gameState.selectedGame = game;
    const gameNames = {
        'pingpong': '탁구',
        'badminton': '배드민턴'
    };
    document.getElementById('selectedGameTitle').textContent = `${gameNames[game]} 게임 설정`;
    showScreen('gameSettings');
}

// 게임 시작
function startGame() {
    console.log('startGame called');
    const winScoreInput = document.querySelector('input[name="winScore"]:checked');
    const totalSetsInput = document.querySelector('input[name="totalSets"]:checked');
    
    if (!winScoreInput || !totalSetsInput) {
        alert('게임 설정을 선택해주세요.');
        return;
    }
    
    gameState.winScore = parseInt(winScoreInput.value);
    gameState.totalSets = parseInt(totalSetsInput.value);
    gameState.currentSet = 1;
    gameState.player1Score = 0;
    gameState.player2Score = 0;
    gameState.player1Sets = 0;
    gameState.player2Sets = 0;
    gameState.scoreHistory = [];
    
    updateScoreboard();
    showScreen('scoreboard');
    
    // 게임 시작 안내
    speakScore('게임 시작!');
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
    if (screenId === 'scoreboard') {
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
}

// 점수판 업데이트
function updateScoreboard() {
    document.getElementById('score1').textContent = gameState.player1Score;
    document.getElementById('score2').textContent = gameState.player2Score;
    document.getElementById('player1Sets').textContent = gameState.player1Sets;
    document.getElementById('player2Sets').textContent = gameState.player2Sets;
    document.getElementById('currentSetNumber').textContent = gameState.currentSet;
}

// 점수 증가
function increaseScore(player) {
    const currentTime = new Date().getTime();
    const timeDiff = currentTime - gameState.lastTapTime;
    
    if (timeDiff < gameState.doubleTapDelay) {
        // 더블 탭 - 점수 감소
        decreaseScore(player);
        return;
    }
    
    gameState.lastTapTime = currentTime;
    
    // 점수 기록
    gameState.scoreHistory.push({
        player: player,
        action: 'increase',
        score: player === 1 ? gameState.player1Score : gameState.player2Score,
        set: gameState.currentSet
    });
    
    // 점수 증가
    if (player === 1) {
        gameState.player1Score++;
        speakScore(`${gameState.player1Score} 대 ${gameState.player2Score}`);
    } else {
        gameState.player2Score++;
        speakScore(`${gameState.player1Score} 대 ${gameState.player2Score}`);
    }
    
    updateScoreboard();
    checkSetEnd();
}

// 점수 감소
function decreaseScore(player) {
    if (player === 1 && gameState.player1Score > 0) {
        gameState.player1Score--;
        speakScore(`${gameState.player1Score} 대 ${gameState.player2Score}`);
    } else if (player === 2 && gameState.player2Score > 0) {
        gameState.player2Score--;
        speakScore(`${gameState.player1Score} 대 ${gameState.player2Score}`);
    }
    
    updateScoreboard();
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
    if (winner === 1) {
        gameState.player1Sets++;
        speakScore('플레이어 1 세트 승리!');
    } else {
        gameState.player2Sets++;
        speakScore('플레이어 2 세트 승리!');
    }
    
    updateScoreboard();
    
    // 게임 종료 확인
    const neededSets = Math.ceil(gameState.totalSets / 2);
    if (gameState.player1Sets >= neededSets || gameState.player2Sets >= neededSets) {
        endGame();
    } else {
        // 다음 세트 시작
        setTimeout(() => {
            gameState.currentSet++;
            gameState.player1Score = 0;
            gameState.player2Score = 0;
            updateScoreboard();
            speakScore(`${gameState.currentSet}세트 시작! 0 대 0`);
        }, 2000);
    }
}

// 게임 종료
function endGame() {
    const winner = gameState.player1Sets > gameState.player2Sets ? 1 : 2;
    const winnerText = `플레이어 ${winner} 승리!`;
    const finalScore = `${gameState.player1Sets} - ${gameState.player2Sets}`;
    
    document.getElementById('winnerText').textContent = winnerText;
    document.getElementById('finalScore').textContent = finalScore;
    
    speakScore(`게임 종료! ${winnerText}`);
    
    setTimeout(() => {
        showScreen('gameEnd');
    }, 3000);
}

// 세트 리셋
function resetSet() {
    gameState.player1Score = 0;
    gameState.player2Score = 0;
    updateScoreboard();
    speakScore('0 대 0, 세트 리셋');
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
        speakScore('실수 수정 완료');
    }
}

// 음성 안내
function speakScore(text) {
    if (speechSynthesis) {
        // 이전 음성 중지
        if (speechUtterance) {
            speechSynthesis.cancel();
        }
        
        speechUtterance = new SpeechSynthesisUtterance(text);
        speechUtterance.lang = 'ko-KR';
        speechUtterance.rate = 0.8;
        speechUtterance.pitch = 1.0;
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
    
    if (timeDiff < gameState.doubleTapDelay) {
        // 더블 탭 - 점수 감소
        decreaseScore(player);
    } else {
        // 단일 탭 - 점수 증가
        increaseScore(player);
    }
    
    gameState.lastTapTime = currentTime;
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
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM Content Loaded');
    
    // 앱 초기화
    initializeApp();
    
    // 플레이어 1 점수 터치
    const player1Score = document.getElementById('player1Score');
    const player2Score = document.getElementById('player2Score');
    
    if (player1Score && player2Score) {
        // 클릭 이벤트
        player1Score.addEventListener('click', function(e) {
            e.preventDefault();
            handlePlayerScore(1);
        });
        
        player2Score.addEventListener('click', function(e) {
            e.preventDefault();
            handlePlayerScore(2);
        });
        
        // 키보드 이벤트 (접근성)
        player1Score.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handlePlayerScore(1);
            }
        });
        
        player2Score.addEventListener('keydown', function(e) {
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
    document.addEventListener('touchstart', function(e) {
        touchStartTime = new Date().getTime();
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });
    
    // 터치 종료
    document.addEventListener('touchend', function(e) {
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
    
    // 더블 탭 줌 방지
    document.addEventListener('touchend', function(e) {
        const now = (new Date()).getTime();
        if (now - gameState.lastTapTime <= 300) {
            e.preventDefault();
        }
    }, { passive: false });
    
    // 키보드 단축키
    document.addEventListener('keydown', function(e) {
        if (document.getElementById('scoreboard').classList.contains('active')) {
            switch(e.key) {
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
    
    // 화면 방향 변경 감지
    window.addEventListener('orientationchange', function() {
        setTimeout(function() {
            // 화면 크기 재조정
            document.body.style.height = window.innerHeight + 'px';
            document.body.style.width = window.innerWidth + 'px';
        }, 100);
    });
    
    // 리사이즈 이벤트
    window.addEventListener('resize', function() {
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
});

// PWA 지원을 위한 서비스 워커 등록 (일시적으로 비활성화)
/*
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('./sw.js')
            .then(function(registration) {
                console.log('ServiceWorker registration successful');
            })
            .catch(function(err) {
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
    caches.open('scoreboard-v1').then(function(cache) {
        return cache.addAll([
            './',
            './index.html',
            './style.css',
            './script.js',
            './manifest.json'
        ]);
    });
}
*/
