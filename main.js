(() => {
  'use strict';

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const timerEl = document.getElementById('timer');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restart');

  // ---------- 설정 ----------
  const Config = {
    timerSeconds: 20,          // 라운드 시간
    catchZoneTopRatio: 0.40,   // 상단에서 40% 아래 ~ 바닥: 잡기 가능(= 화면 하단 60%)

    spawnMinMs: 700,           // 다음 공 스폰 최소 지연
    spawnMaxMs: 1400,          // 다음 공 스폰 최대 지연

    // 이미지 경로( index.html 의 window.GAME_ASSETS 로부터 주입 가능 )
    assets: {
      backboard: (window.GAME_ASSETS && window.GAME_ASSETS.backboard) || null,
      ball: (window.GAME_ASSETS && window.GAME_ASSETS.ball) || null,
    },

    // 업로드한 backboard.png에 맞춘 기본 배치/림 위치
    board: {
      widthRatio: 0.92,  // 백보드 이미지 표시 너비(화면 너비 대비)
      topPadRatio: 0.06, // 화면 상단 여백 비율
      rimOffsetX: 0.30,  // 보드 중심 대비 림 중심 X 오프셋(+ 우측)  (약 80% 지점)
      rimOffsetY: 0.22,  // 보드 상단 기준 림 중심 Y 비율
      rimWidthRatio: 0.17 // 림 길이(보드 가로 대비)
    }
  };

  const World = {
    gravity: 2600,            // shot 상태 중력(px/s^2)
    air: 0.999,               // 공기 저항
    wallRestitution: 0.78,
    floorRestitution: 0.62,
    rimRestitution: 0.82,
    maxShotPower: 2000,
    powerFromSwipe: 1100,
    powerFromDrag: 7.0,

    incomingGravity: 1200,    // 위→아래로 떨어지는 incoming 공 전용 중력
  };

  // ---------- 상태 ----------
  const State = {
    width: 0, height: 0, dpr: 1,
    running: false,
    score: 0,
    timeLeft: Config.timerSeconds,
    lastRAF: 0,
    accumulator: 0,
    fixedDt: 1/120,
    nextSpawnAt: 0,           // 다음 공 스폰 시각(performance.now)
  };

  // ---------- 에셋 ----------
  const Assets = { backboard: null, ball: null, loaded: { back:false, ball:false } };
  if (Config.assets.backboard) {
    const img = new Image(); img.src = Config.assets.backboard;
    img.onload = () => (Assets.loaded.back = true);
    Assets.backboard = img;
  }
  if (Config.assets.ball) {
    const img = new Image(); img.src = Config.assets.ball;
    img.onload = () => (Assets.loaded.ball = true);
    Assets.ball = img;
  }

  // ---------- 게임 객체 컨테이너 ----------
  const Game = {
    ball: null,      // 현재 공(항상 0 또는 1개)
    hoop: null,      // 림/백보드
    input: null,     // 입력 핸들러
    catchZoneY: 0,   // 잡기 가능 영역 상단 y
    pendingNewBall: false, // 다음 공 스폰 플래그
  };

  // ---------- 클래스: Ball ----------
  class Ball {
    // mode: 'incoming' | 'held' | 'shot'
    constructor(x, y, r, mode = 'incoming') {
      this.x = x; this.y = y; this.r = r;
      this.vx = 0; this.vy = 0;
      this.mode = mode;
      this.held = false;
      this.shot = false;
      this.resting = false;
      this.scored = false;
      this.lastY = y;
      this.timeSinceShot = 0;
    }
    applyPhysics(dt) {
      if (this.held) return;

      if (this.mode === 'incoming') {
        // 위에서 아래로 떨어지는 상태: 충돌 없이 자연 낙하
        this.vy += World.incomingGravity * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        return;
      }

      // shot 상태(사용자가 튕겨 올린 후)
      this.vy += World.gravity * dt;
      this.vx *= Math.pow(World.air, (dt*120));
      this.vy *= Math.pow(World.air, (dt*120));

      this.x += this.vx * dt;
      this.y += this.vy * dt;

      // 화면 좌우 벽 충돌
      if (this.x - this.r < 0) {
        this.x = this.r;
        this.vx = Math.abs(this.vx) * World.wallRestitution;
      } else if (this.x + this.r > State.width) {
        this.x = State.width - this.r;
        this.vx = -Math.abs(this.vx) * World.wallRestitution;
      }

      // 바닥 충돌
      if (this.y + this.r > State.height) {
        this.y = State.height - this.r;
        if (this.vy > 0) this.vy = -this.vy * World.floorRestitution;
        this.vx *= 0.985;
        if (Math.abs(this.vx) < 6 && Math.abs(this.vy) < 25) {
          this.resting = true; this.vx = 0; this.vy = 0;
        }
      }

      if (this.shot) this.timeSinceShot += dt;
    }
    draw(g) {
      g.save();
      g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
      if (Assets.loaded.ball && Assets.ball) {
        const d = this.r * 2;
        g.drawImage(Assets.ball, this.x - this.r, this.y - this.r, d, d);
      } else {
        // 에셋 미로딩 시 기본 원
        g.beginPath(); g.arc(this.x, this.y, this.r, 0, Math.PI*2);
        g.fillStyle = '#f2a23a'; g.fill();
        g.lineWidth = 2; g.strokeStyle = '#cc7d11'; g.stroke();
      }
      g.restore();
    }
  }

  // ---------- 클래스: Hoop(림/백보드) ----------
  class Hoop {
    constructor(cx, y, base) {
      // 보드 렌더링 영역 계산
      const boardW = State.width * Config.board.widthRatio;
      const boardH = boardW * 0.75; // 대략적 비율(4:3 느낌)
      const boardX = Math.round(State.width * 0.5 - boardW / 2);
      const boardY = Math.max(10, Math.round(State.height * Config.board.topPadRatio));
      this.boardRect = { x: boardX, y: boardY, w: boardW, h: boardH };

      // 림 크기
      this.rimHalf = Math.max(18, base * Config.board.rimWidthRatio / 2);
      this.rimNodeR = Math.max(8, base/38);
      this.tint = '#e84d2a';

      // 보드 이미지 좌표계 → 화면 좌표계로 림 중심 변환
      const rimCX = boardX + boardW * (0.5 + Config.board.rimOffsetX);
      const rimCY = boardY + boardH * Config.board.rimOffsetY;
      this.cx = rimCX; this.y = rimCY;

      // 충돌 노드 좌/우
      this.leftNode  = { x: this.cx - this.rimHalf, y: this.y };
      this.rightNode = { x: this.cx + this.rimHalf, y: this.y };

      // 득점 센서(아래로 통과 시 카운트)
      this.scoreY = this.y + this.rimNodeR*0.6;
      this.scoreLeft = this.leftNode.x + this.rimNodeR*0.7;
      this.scoreRight = this.rightNode.x - this.rimNodeR*0.7;
    }

    collideBall(ball) {
      // 1) 노드(원) 충돌
      const hitCircle = (cx, cy, r) => {
        const dx = ball.x - cx, dy = ball.y - cy;
        const dist = Math.hypot(dx, dy);
        const minDist = ball.r + r;
        if (dist < minDist) {
          const nx = dx / (dist || 1e-6), ny = dy / (dist || 1e-6);
          const pen = (minDist - dist);
          ball.x += nx * pen; ball.y += ny * pen;
          const vDotN = ball.vx*nx + ball.vy*ny;
          ball.vx = ball.vx - (1 + World.rimRestitution) * vDotN * nx;
          ball.vy = ball.vy - (1 + World.rimRestitution) * vDotN * ny;
          ball.vx *= 0.985; ball.vy *= 0.985;
        }
      };

      // 2) 림 선분(캡슐) 충돌
      const hitCapsule = (ax, ay, bx, by, r) => {
        const vx = bx - ax, vy = by - ay;
        const wx = ball.x - ax, wy = ball.y - ay;
        const vv = vx*vx + vy*vy || 1e-6;
        let t = (wx*vx + wy*vy) / vv;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t*vx, cy = ay + t*vy;
        const dx = ball.x - cx, dy = ball.y - cy;
        const dist = Math.hypot(dx, dy);
        const minDist = ball.r + r;
        if (dist < minDist) {
          const nx = dx / (dist || 1e-6), ny = dy / (dist || 1e-6);
          const pen = (minDist - dist);
          ball.x += nx * pen; ball.y += ny * pen;
          const vDotN = ball.vx*nx + ball.vy*ny;
          ball.vx = ball.vx - (1 + World.rimRestitution) * vDotN * nx;
          ball.vy = ball.vy - (1 + World.rimRestitution) * vDotN * ny;
          ball.vx *= 0.985; ball.vy *= 0.985;
        }
      };

      hitCircle(this.leftNode.x,  this.leftNode.y,  this.rimNodeR);
      hitCircle(this.rightNode.x, this.rightNode.y, this.rimNodeR);
      hitCapsule(this.leftNode.x, this.leftNode.y, this.rightNode.x, this.rightNode.y, this.rimNodeR * 0.6);

      // 3) 백보드 판(오른쪽 얇은 세로 판) 충돌
      const boardX = this.boardRect.x + this.boardRect.w * 0.82;
      const by = this.boardRect.y + this.boardRect.h * 0.08;
      const bw = Math.max(4, State.width/240);
      const bh = this.boardRect.h * 0.60;
      if (ball.x + ball.r > boardX && ball.x - ball.r < boardX + bw &&
          ball.y + ball.r > by && ball.y - ball.r < by + bh) {
        if (ball.vx > 0 && ball.x < boardX + bw/2) {
          ball.x = boardX - ball.r; ball.vx = -Math.abs(ball.vx) * 0.75;
        } else if (ball.vx < 0 && ball.x > boardX + bw/2) {
          ball.x = boardX + bw + ball.r; ball.vx = Math.abs(ball.vx) * 0.75;
        }
      }
    }

    checkScore(ball) {
      if (ball.scored || !ball.shot) return false;
      const crossedDown = (ball.lastY < this.scoreY && ball.y >= this.scoreY);
      const inX = (ball.x > this.scoreLeft && ball.x < this.scoreRight);
      const goingDown = ball.vy > 0;
      if (crossedDown && inX && goingDown) {
        ball.scored = true; return true;
      }
      return false;
    }

    draw(g) {
      g.save();
      // 백보드 이미지(없으면 대체 사각형)
      if (Assets.loaded.back && Assets.backboard) {
        g.drawImage(Assets.backboard, this.boardRect.x, this.boardRect.y, this.boardRect.w, this.boardRect.h);
      } else {
        g.fillStyle = '#2a385d';
        g.fillRect(this.boardRect.x, this.boardRect.y, this.boardRect.w, this.boardRect.h);
      }

      // 림(선 + 노드)
      g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 8; g.shadowOffsetX = -2; g.shadowOffsetY = 2;
      g.strokeStyle = this.tint; g.lineWidth = Math.max(3, State.width/240);
      g.beginPath(); g.moveTo(this.leftNode.x, this.y); g.lineTo(this.rightNode.x, this.y); g.stroke();

      const drawNode = (p) => { g.beginPath(); g.arc(p.x, p.y, this.rimNodeR, 0, Math.PI*2); g.fillStyle = this.tint; g.fill(); };
      drawNode(this.leftNode); drawNode(this.rightNode);

      // 간단한 네트 라인
      g.shadowColor = 'transparent';
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(this.leftNode.x+4, this.y+2); g.lineTo(this.rightNode.x-4, this.y+2); g.stroke();
      g.restore();
    }
  }

  // ---------- 입력 ----------
  class Input {
    constructor() {
      this.active = false;
      this.startX = 0; this.startY = 0;
      this.curX = 0; this.curY = 0;
      this.samples = []; // 최근 좌표 샘플(속도 측정용)
      canvas.addEventListener('pointerdown', this.onDown, { passive:false });
      window.addEventListener('pointermove', this.onMove, { passive:false });
      window.addEventListener('pointerup',   this.onUp,   { passive:false });
    }
    toCanvasXY(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (State.width / rect.width),
        y: (e.clientY - rect.top)  * (State.height / rect.height),
      };
    }
    withinBall(x, y) {
      const b = Game.ball; if (!b) return false;
      return Math.hypot(x - b.x, y - b.y) <= b.r * 1.15;
    }
    onDown = (e) => {
      e.preventDefault();
      if (!State.running) return;
      const p = this.toCanvasXY(e);
      const b = Game.ball;

      // 하단 캐치존 + incoming 상태의 공만 잡기 가능
      if (b && b.mode === 'incoming' && p.y >= Game.catchZoneY && this.withinBall(p.x, p.y)) {
        this.active = true;
        this.startX = this.curX = p.x; this.startY = this.curY = p.y;
        this.samples.length = 0; this.pushSample(p.x, p.y);
        b.held = true; b.mode = 'held';
      }
    }
    onMove = (e) => {
      if (!this.active) return;
      const p = this.toCanvasXY(e);
      this.curX = p.x; this.curY = p.y;
      this.pushSample(p.x, p.y);

      const b = Game.ball;
      if (b && b.held) {
        // 잡은 상태: 손가락 위치로 이동(캐치존 위로는 끌고 올라갈 수 없음)
        b.x = this.curX;
        b.y = Math.max(Game.catchZoneY + b.r, this.curY);
      }
    }
    onUp = (e) => {
      if (!this.active) return;
      const p = this.toCanvasXY(e);
      this.curX = p.x; this.curY = p.y;
      this.pushSample(p.x, p.y);

      const b = Game.ball;
      if (b && b.held) {
        // 튕겨서 던지기
        const dragVX = (this.startX - this.curX) * World.powerFromDrag;
        const dragVY = (this.startY - this.curY) * World.powerFromDrag;

        // 최근 120ms 스와이프 속도
        let i = this.samples.length - 1;
        const tLast = this.samples[i].t;
        while (i > 0 && (tLast - this.samples[i-1].t) < 120) i--;
        const vdx = this.samples[this.samples.length-1].x - this.samples[i].x;
        const vdy = this.samples[this.samples.length-1].y - this.samples[i].y;
        const dt = (this.samples[this.samples.length-1].t - this.samples[i].t) / 1000 || 1/60;
        const swipeVX = -(vdx/dt) * (World.powerFromSwipe/1000);
        const swipeVY = -(vdy/dt) * (World.powerFromSwipe/1000);

        let vx = dragVX * 0.2 + swipeVX * 0.8;
        let vy = dragVY * 0.2 + swipeVY * 0.8;

        // 위로 던진 동작만 유효(감도 완화)
        if (vy >= -80) { vx = 0; vy = 0; }

        // 속력 상한
        const spd = Math.hypot(vx, vy);
        if (spd > World.maxShotPower) {
          const s = World.maxShotPower / (spd || 1);
          vx *= s; vy *= s;
        }

        b.held = false; b.shot = true; b.mode = 'shot';
        b.vx = vx; b.vy = vy;
      }

      this.active = false;
    }
    pushSample(x, y) {
      this.samples.push({ x, y, t: performance.now() });
      const cutoff = performance.now() - 180;
      while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    }
    drawAim(g) {
      if (!this.active || !Game.ball) return;
      g.save();
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2; g.setLineDash([6,6]);
      g.beginPath(); g.moveTo(this.startX, this.startY); g.lineTo(this.curX, this.curY); g.stroke();
      g.restore();
    }
  }

  // ---------- 리사이즈/초기화 ----------
  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    State.dpr = dpr;
    State.width  = Math.round(window.innerWidth  * dpr);
    State.height = Math.round(window.innerHeight * dpr);
    canvas.width = State.width; canvas.height = State.height;
    canvas.style.width = '100vw'; canvas.style.height = '100vh';

    Game.catchZoneY = Math.round(State.height * Config.catchZoneTopRatio);

    // 림/보드 재계산
    const base = Math.min(State.width, State.height);
    const hoopX = Math.round(State.width * 0.5);
    const hoopY = Math.round(State.height * 0.18);
    Game.hoop = new Hoop(hoopX, hoopY, base);

    // 공 반경 갱신 또는 최초 스폰
    const br = Math.max(14 * dpr, base / 22);
    if (!Game.ball) {
      spawnIncoming(br);
    } else {
      Game.ball.r = br;
      Game.ball.x = Math.min(Math.max(Game.ball.x, br), State.width - br);
      Game.ball.y = Math.min(Math.max(Game.ball.y, br), State.height - br);
    }
  }

  // ---------- 스폰 ----------
  function spawnIncoming(r) {
    const x = Math.round(State.width * (0.25 + Math.random()*0.5)); // 25%~75% 구간
    const y = Math.round(State.height * (0.02 + Math.random()*0.06));
    const b = new Ball(x, y, r, 'incoming');
    b.vx = (Math.random()*2 - 1) * 120; // 좌우 약간의 편차
    b.vy = 220 + Math.random()*140;     // 초깃값(아래 방향)
    Game.ball = b;
    Game.pendingNewBall = false;
  }

  function scheduleNextSpawn() {
    const ms = Config.spawnMinMs + Math.random()*(Config.spawnMaxMs - Config.spawnMinMs);
    State.nextSpawnAt = performance.now() + ms;
  }

  // ---------- 렌더 ----------
  function drawCourt(g) {
    // 하단 캐치존 표시(연한 음영 + 경계선)
    g.save();
    g.fillStyle = 'rgba(255,255,255,.04)';
    g.fillRect(0, Game.catchZoneY, State.width, State.height - Game.catchZoneY);
    g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, Game.catchZoneY); g.lineTo(State.width, Game.catchZoneY); g.stroke();
    g.restore();
  }

  // ---------- 게임 루프 ----------
  function update(dt) {
    if (State.running) {
      State.timeLeft -= dt;
      if (State.timeLeft <= 0) {
        State.timeLeft = 0;
        endGame();
      }
    }
    timerEl.textContent = String(Math.ceil(State.timeLeft));

    let despawn = false;

    const substeps = 2;
    const subDt = dt / substeps;

    for (let s=0; s<substeps; s++) {
      const ball = Game.ball;
      const hoop = Game.hoop;
      if (ball) {
        ball.lastY = ball.y;
        ball.applyPhysics(subDt);

        if (ball.mode === 'incoming') {
          // 화면 아래로 지나가면(못 받음) 다음 공 예약만 하고 현재 공 제거
          if (ball.y - ball.r > State.height + 80) {
            Game.pendingNewBall = true; scheduleNextSpawn();
            despawn = true; break;
          }
        } else if (ball.mode === 'shot') {
          // 림/보드 충돌 체크 (안정화를 위해 반복)
          for (let i=0; i<3; i++) hoop.collideBall(ball);

          // 득점
          if (hoop.checkScore(ball)) {
            State.score += 1;
            scoreEl.textContent = String(State.score);
            Game.pendingNewBall = true; scheduleNextSpawn();
            despawn = true; break;
          }

          // 바닥에서 충분히 멈춘 경우
          if (ball.shot && (ball.resting && ball.timeSinceShot > 0.25)) {
            Game.pendingNewBall = true; scheduleNextSpawn();
            despawn = true; break;
          }

          // 화면 아래로 떨어져 사라진 경우
          if (ball.y - ball.r > State.height + 250) {
            Game.pendingNewBall = true; scheduleNextSpawn();
            despawn = true; break;
          }
        }
      } else {
        // 공이 없고 스폰 타이밍이 되었다면 생성
        if (Game.pendingNewBall && performance.now() >= State.nextSpawnAt) {
          spawnIncoming(Math.max(14*State.dpr, Math.min(State.width, State.height)/22));
        }
      }
    }

    if (despawn) {
      Game.ball = null;
    } else {
      // 공이 있고, 다음 스폰 예정 시간이 지났지만 아직 공이 남아 있다면
      // 공이 사라지는 즉시 스폰되도록 타이밍은 유지(가드만 둠).
    }
  }

  function render() {
    ctx.clearRect(0, 0, State.width, State.height);
    drawCourt(ctx);
    Game.hoop && Game.hoop.draw(ctx);
    Game.input && Game.input.drawAim(ctx);
    Game.ball && Game.ball.draw(ctx);
  }

  function frame(t) {
    if (!State.running) return;
    if (!State.lastRAF) State.lastRAF = t;
    let dt = (t - State.lastRAF) / 1000;
    dt = Math.max(0, Math.min(dt, 0.033));
    State.lastRAF = t;

    State.accumulator += dt;
    while (State.accumulator >= State.fixedDt) {
      update(State.fixedDt);
      State.accumulator -= State.fixedDt;
    }
    render();
    requestAnimationFrame(frame);
  }

  // ---------- 시작/종료 ----------
  function startGame() {
    overlay.classList.remove('visible');
    restartBtn.classList.remove('hidden');
    State.running = true;
    if (!Game.input) Game.input = new Input();

    State.score = 0;
    State.timeLeft = Config.timerSeconds;
    scoreEl.textContent = '0';
    timerEl.textContent = String(Config.timerSeconds);
    State.lastRAF = 0; State.accumulator = 0;

    // 첫 공이 없다면 즉시 스폰, 다음 공은 랜덤 스폰 예약
    if (!Game.ball) {
      spawnIncoming(Math.max(14*State.dpr, Math.min(State.width, State.height)/22));
    }
    Game.pendingNewBall = true; // 다음 공 예약(가드: 실제 생성은 화면에 공이 없을 때만)
    scheduleNextSpawn();

    requestAnimationFrame(frame);
  }

  function endGame() {
    State.running = false;
    restartBtn.classList.add('hidden');
    overlay.classList.add('visible');
    overlay.querySelector('h1').textContent = 'TIME UP!';
    overlay.querySelector('p').innerHTML = `득점: <strong>${State.score}</strong>개<br/>다시 도전해 보세요.`;
  }

  // ---------- 이벤트 ----------
  window.addEventListener('resize', resize);
  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);

  // ---------- 초기화 ----------
  resize();
  overlay.classList.add('visible');
})();
