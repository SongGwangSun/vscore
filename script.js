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
    doubleTapDelay: 300
};

// 음성 합성 초기화
let speechSynthesis = window.speechSynthesis;
let speechUtterance = null;

// 게임 선택
function selectGame(game) {
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
    gameState.winScore = parseInt(document.querySelector('input[name="winScore"]:checked').value);
    gameState.totalSets = parseInt(document.querySelector('input[name="totalSets"]:checked').value);
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
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(screenId).classList.add('active');
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
    speakScore(' 0 대 0, 세트 리셋');
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
    showScreen('gameSelection');
}

// 게임 설정 화면으로 이동
function showGameSettings() {
    showScreen('gameSettings');
}

// 터치 이벤트 설정
document.addEventListener('DOMContentLoaded', function() {
    // 플레이어 1 점수 터치
    document.getElementById('player1Score').addEventListener('click', function() {
        increaseScore(1);
    });
    
    // 플레이어 2 점수 터치
    document.getElementById('player2Score').addEventListener('click', function() {
        increaseScore(2);
    });
    
    // iOS Safari 최적화
    document.addEventListener('touchstart', function(e) {
        e.preventDefault();
    }, { passive: false });
    
    // iOS에서 더블 탭 줌 방지
    let lastTouchEnd = 0;
    document.addEventListener('touchend', function(e) {
        const now = (new Date()).getTime();
        if (now - lastTouchEnd <= 300) {
            e.preventDefault();
        }
        lastTouchEnd = now;
    }, false);
    
    // 터치 이벤트 최적화
    let touchStartTime = 0;
    let touchEndTime = 0;
    
    document.addEventListener('touchstart', function(e) {
        touchStartTime = new Date().getTime();
    }, false);
    
    document.addEventListener('touchend', function(e) {
        touchEndTime = new Date().getTime();
        const touchDuration = touchEndTime - touchStartTime;
        
        // 짧은 터치만 처리 (길게 누르기 방지)
        if (touchDuration < 500) {
            const target = e.target.closest('.player-score');
            if (target) {
                e.preventDefault();
                const player = target.id === 'player1Score' ? 1 : 2;
                increaseScore(player);
            }
        }
    }, false);
    
    // 더블 탭 방지
    document.addEventListener('touchend', function(e) {
        e.preventDefault();
    }, { passive: false });
    
    // 키보드 단축키
    document.addEventListener('keydown', function(e) {
        if (document.getElementById('scoreboard').classList.contains('active')) {
            switch(e.key) {
                case '1':
                    increaseScore(1);
                    break;
                case '2':
                    increaseScore(2);
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
        }, 100);
    });
    
    // 초기 화면 높이 설정
    document.body.style.height = window.innerHeight + 'px';
});

// PWA 지원을 위한 서비스 워커 등록 (선택사항)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('/sw.js')
            .then(function(registration) {
                console.log('ServiceWorker registration successful');
            })
            .catch(function(err) {
                console.log('ServiceWorker registration failed');
            });
    });
}

// 앱 설치 프롬프트 (선택사항)
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

// 오프라인 지원을 위한 캐시 (선택사항)
if ('caches' in window) {
    caches.open('scoreboard-v1').then(function(cache) {
        return cache.addAll([
            '/',
            '/index.html',
            '/style.css',
            '/script.js'
        ]);
    });
}

