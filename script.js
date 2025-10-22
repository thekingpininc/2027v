const startBtn = document.getElementById('startBtn');
const ball = document.getElementById('ball');
const playArea = document.getElementById('playArea');
const scoreDisplay = document.getElementById('score');
const timerDisplay = document.getElementById('timer');
const finalScoreDisplay = document.getElementById('finalScore');

let score = 0;
let time = 20;
let gameInterval;
let ballInterval;

startBtn.addEventListener('click', startGame);

function startGame() {
  score = 0;
  time = 20;
  scoreDisplay.textContent = `점수: ${score}`;
  timerDisplay.textContent = `시간: ${time}`;
  finalScoreDisplay.classList.add('hidden');
  startBtn.disabled = true;

  gameInterval = setInterval(() => {
    time--;
    timerDisplay.textContent = `시간: ${time}`;
    if (time <= 0) endGame();
  }, 1000);

  moveBall();
  ballInterval = setInterval(moveBall, 1000);
}

function moveBall() {
  const maxX = playArea.clientWidth - ball.offsetWidth;
  const maxY = playArea.clientHeight - ball.offsetHeight;
  const randomX = Math.floor(Math.random() * maxX);
  const randomY = Math.floor(Math.random() * maxY);

  ball.style.left = randomX + 'px';
  ball.style.top = randomY + 'px';
}

ball.addEventListener('click', () => {
  score++;
  scoreDisplay.textContent = `점수: ${score}`;
  moveBall(); // 맞히면 즉시 위치 변경
});

function endGame() {
  clearInterval(gameInterval);
  clearInterval(ballInterval);
  finalScoreDisplay.textContent = `게임 종료! 최종 점수: ${score}`;
  finalScoreDisplay.classList.remove('hidden');
  startBtn.disabled = false;
}
