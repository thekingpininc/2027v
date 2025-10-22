(() => {
  'use strict';

  // ========= 기본 DOM =========
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const timerEl = document.getElementById('timer');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restart');

  // ========= 상태 =========
  const State = {
    width: 0, height: 0, dpr: 1,
    running: false,
    score: 0,
    timeLeft: 60,            // 초
    startedOnce: false,
    lastRAF: 0,
    accumulator: 0,
    fixedDt: 1/120,          // 물리 업데이트 간격(초)
  };

  // ========= 월드/물리 파라미터 =========
  const World = {
    gravity: 2600,           // px/s^2
    air: 0.998,              // 공기 저항(프레임당)
    wallRestitution: 0.7,    // 벽 반발계수
    floorRestitution: 0.55,
    rimRestitution: 0.6,
    maxShotPower: 1800,      // 초기 속력 제한(벡터 크기)
    powerFromSwipe: 1100,    // 최근 100ms 스와이프 속도 → 초기속력 계수
    powerFromDrag: 7.0,      // 누른 지점-뗀 지점 거리 → 초기속력 계수
  };

  // ========= 유틸 =========
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const length = (x, y) => Math.hypot(x, y);
  const now = () => performance.now();

  // ========= 엔티티 =========
  const Game = {
    ball: null,
    hoop: null,
    input: null,
    pendingNewBall: false,
  };

  class Ball {
    constructor(x, y, r) {
      this.x = x; this.y = y; this.r = r;
      this.vx = 0; this.vy = 0;
      this.color = '#f2a23a';
      this.outline = '#cc7d11';
      this.held = false;     // 손에 들고 있는 상태
      this.shot = false;     // 이미 던졌는지
      this.resting = false;  // 바닥에서 거의 멈춤
      this.scored = false;   // 이미 점수 처리했는지(한 번만 카운트)
      this.lastY = y;
      this.timeSinceShot = 0;
    }
    applyPhysics(dt) {
      if (this.held) return;

      // 가속/속도/위치
      this.vy += World.gravity * dt;
      this.vx *= Math.pow(World.air, (dt*120));
      this.vy *= Math.pow(World.air, (dt*120));

      this.x += this.vx * dt;
      this.y += this.vy * dt;

      // 벽 충돌
      if (this.x - this.r < 0) {
        this.x = this.r; this.vx = Math.abs(this.vx) * World.wallRestitution;
      } else if (this.x + this.r > State.width) {
        this.x = State.width - this.r; this.vx = -Math.abs(this.vx) * World.wallRestitution;
      }

      // 바닥
      if (this.y + this.r > State.height) {
        this.y = State.height - this.r;
        if (this.vy > 0) this.vy = -this.vy * World.floorRestitution;
        this.vx *= 0.985; // 마찰
        if (Math.abs(this.vx) < 6 && Math.abs(this.vy) < 25) {
          this.resting = true;
          this.vx = 0; this.vy = 0;
        }
      }

      // 화면 아래로 많이 나가면 리스폰
      if (this.y - this.r > State.height + 250) {
        Game.pendingNewBall = true;
      }

      if (this.shot) this.timeSinceShot += dt;
    }
    draw(g) {
      // 공(심플한 2D)
      g.save();
      g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
      g.beginPath(); g.arc(this.x, this.y, this.r, 0, Math.PI*2); g.fillStyle = this.color; g.fill(); g.strokeStyle = this.outline; g.lineWidth = 2; g.stroke();
      // 결 무늬
      g.beginPath(); g.lineWidth = 1.2; g.strokeStyle = 'rgba(0,0,0,.35)';
      const a = Math.PI/6;
      g.moveTo(this.x-this.r, this.y); g.quadraticCurveTo(this.x, this.y+this.r*0.6, this.x+this.r, this.y);
      g.moveTo(this.x-this.r*Math.cos(a), this.y-this.r*Math.sin(a)); g.lineTo(this.x+this.r*Math.cos(a), this.y+this.r*Math.sin(a));
      g.moveTo(this.x-this.r*Math.cos(a), this.y+this.r*Math.sin(a)); g.lineTo(this.x+this.r*Math.cos(a), this.y-this.r*Math.sin(a));
      g.stroke();
      g.restore();
    }
  }

  class Hoop {
    constructor(cx, y, base) {
      // 림/백보드 파라미터는 화면 크기에 따라 유동적
      this.cx = cx;
      this.y = y;
      this.rimHalf = base/10;            // 림 가로 절반
      this.rimNodeR = base/45;           // 양쪽 충돌 노드 원 반지름
      this.boardX = cx + this.rimHalf + this.rimNodeR + base/55;
      this.boardW = base/80;
      this.boardH = base/4.2;
      this.netDepth = base/18;           // 득점 판정선 아래쪽 센서 깊이
      this.tint = '#e84d2a';
      this.boardColor = '#d7dfef';
      this.shadow = 'rgba(0,0,0,.45)';
      // 편의 좌표
      this.leftNode = { x: cx - this.rimHalf, y };
      this.rightNode = { x: cx + this.rimHalf, y };
      // 득점 센서 라인(y)와 유효 x범위
      this.scoreY = y + this.rimNodeR*0.6;
      this.scoreLeft = this.leftNode.x + this.rimNodeR*0.7;
      this.scoreRight = this.rightNode.x - this.rimNodeR*0.7;
    }
    collideBall(ball) {
      // 1) 림 양쪽 노드(원) 충돌
      const hitCircle = (cx, cy, r) => {
        const dx = ball.x - cx, dy = ball.y - cy;
        const dist = Math.hypot(dx, dy);
        const minDist = ball.r + r;
        if (dist < minDist) {
          const nx = dx / (dist || 1e-6), ny = dy / (dist || 1e-6);
          // 침투 보정
          const pen = (minDist - dist);
          ball.x += nx * pen;
          ball.y += ny * pen;
          // 속도 반사
          const vDotN = ball.vx*nx + ball.vy*ny;
          const rvx = ball.vx - (1+World.rimRestitution)*vDotN*nx;
          const rvy = ball.vy - (1+World.rimRestitution)*vDotN*ny;
          ball.vx = rvx;
          ball.vy = rvy;
          // 마찰 조금
          ball.vx *= 0.98; ball.vy *= 0.98;
        }
      };
      hitCircle(this.leftNode.x, this.leftNode.y, this.rimNodeR);
      hitCircle(this.rightNode.x, this.rightNode.y, this.rimNodeR);

      // 2) 백보드 (세로 직사각형) 충돌: 오른쪽에 세움
      const bx = this.boardX, by = this.y - this.boardH*0.55, bw = this.boardW, bh = this.boardH;
      if (ball.x + ball.r > bx && ball.x - ball.r < bx + bw &&
          ball.y + ball.r > by && ball.y - ball.r < by + bh) {
        // 단순히 좌우 반사(백보드는 세로판)
        if (ball.vx > 0 && ball.x < bx + bw/2) {
          ball.x = bx - ball.r;
          ball.vx = -Math.abs(ball.vx) * 0.75;
        } else if (ball.vx < 0 && ball.x > bx + bw/2) {
          ball.x = bx + bw + ball.r;
          ball.vx = Math.abs(ball.vx) * 0.75;
        }
      }
    }
    checkScore(ball) {
      // 조건: 위→아래로 센서라인 통과, x범위 안, 이미 득점 처리 X, 공이 내려오는 중
      if (ball.scored || !ball.shot) return false;
      const crossedDown = (ball.lastY < this.scoreY && ball.y >= this.scoreY);
      const inX = (ball.x > this.scoreLeft && ball.x < this.scoreRight);
      const goingDown = ball.vy > 0;
      if (crossedDown && inX && goingDown) {
        ball.scored = true;
        return true;
      }
      return false;
    }
    draw(g) {
      g.save();
      // 백보드
      g.fillStyle = this.boardColor;
      g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 8; g.shadowOffsetX = -2; g.shadowOffsetY = 2;
      g.fillRect(this.boardX, this.y - this.boardH*0.55, this.boardW, this.boardH);

      // 림(선)
      g.shadowColor = 'transparent';
      g.strokeStyle = this.tint; g.lineWidth = Math.max(3, State.width/240);
      g.beginPath(); g.moveTo(this.leftNode.x, this.y); g.lineTo(this.rightNode.x, this.y); g.stroke();

      // 양쪽 노드
      const drawNode = (p) => { g.beginPath(); g.arc(p.x, p.y, this.rimNodeR, 0, Math.PI*2); g.fillStyle = this.tint; g.fill(); };
      drawNode(this.leftNode); drawNode(this.rightNode);

      // 간이 네트(밑선)
      g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(this.leftNode.x+4, this.y+2);
      g.lineTo(this.rightNode.x-4, this.y+2);
      g.stroke();

      g.restore();
    }
  }

  // ========= 입력(스와이프) =========
  class Input {
    constructor() {
      this.active = false;
      this.startX = 0; this.startY = 0;
      this.curX = 0; this.curY = 0;
      this.samples = []; // 최근 120ms 좌표 샘플
      // 이벤트
      canvas.addEventListener('pointerdown', this.onDown, {passive:false});
      window.addEventListener('pointermove', this.onMove, {passive:false});
      window.addEventListener('pointerup', this.onUp, {passive:false});
    }
    withinBall(x, y) {
      const b = Game.ball;
      if (!b) return false;
      const d = Math.hypot(x - b.x, y - b.y);
      return d <= b.r * 1.15;
    }
    toCanvasXY(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (State.width / rect.width),
        y: (e.clientY - rect.top) * (State.height / rect.height),
      };
    }
    onDown = (e) => {
      e.preventDefault();
      if (!State.running) return; // 오버레이 상태에서는 시작 버튼으로만
      const p = this.toCanvasXY(e);
      if (Game.ball && !Game.ball.shot && this.withinBall(p.x, p.y)) {
        this.active = true;
        this.startX = this.curX = p.x;
        this.startY = this.curY = p.y;
        this.samples.length = 0;
        this.pushSample(p.x, p.y);
        Game.ball.held = true;
        Game.ball.resting = false;
      }
    }
    onMove = (e) => {
      if (!this.active) return;
      const p = this.toCanvasXY(e);
      this.curX = p.x; this.curY = p.y;
      this.pushSample(p.x, p.y);
    }
    onUp = (e) => {
      if (!this.active) return;
      const p = this.toCanvasXY(e);
      this.curX = p.x; this.curY = p.y;
      this.pushSample(p.x, p.y);

      // 공 던지기
      const b = Game.ball;
      if (b && b.held && !b.shot) {
        const dragVX = (this.startX - this.curX) * World.powerFromDrag;
        const dragVY = (this.startY - this.curY) * World.powerFromDrag;

        // 최근 100~140ms 스와이프 속도
        const recent = this.samples;
        let i = recent.length - 1;
        const tLast = recent[i].t;
        while (i > 0 && (tLast - recent[i-1].t) < 120) i--;
        const vdx = recent[recent.length-1].x - recent[i].x;
        const vdy = recent[recent.length-1].y - recent[i].y;
        const dt = (recent[recent.length-1].t - recent[i].t) / 1000 || 1/60;
        const swipeVX = -(vdx/dt) * (World.powerFromSwipe/1000);
        const swipeVY = -(vdy/dt) * (World.powerFromSwipe/1000);

        // 합성 초기 속도
        let vx = dragVX * 0.2 + swipeVX * 0.8;
        let vy = dragVY * 0.2 + swipeVY * 0.8;

        // 위로 던진 경우만 허용(화면 좌표계에서 위는 음수)
        if (vy >= -120) {
          // 너무 약하면 무시
          vx = 0; vy = 0;
        }

        // 크기 제한
        const spd = Math.hypot(vx, vy);
        if (spd > World.maxShotPower) {
          const scale = World.maxShotPower / (spd || 1);
          vx *= scale; vy *= scale;
        }

        b.held = false; b.shot = true; b.vx = vx; b.vy = vy;
        State.startedOnce = true; // 첫 슛으로 타이머 스타트
      }

      this.active = false;
    }
    pushSample(x, y) {
      this.samples.push({x, y, t: now()});
      // 180ms만 유지
      const cutoff = now() - 180;
      while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    }
    drawAim(g) {
      if (!this.active || !Game.ball) return;
      g.save();
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2; g.setLineDash([6, 6]);
      g.beginPath(); g.moveTo(this.startX, this.startY); g.lineTo(this.curX, this.curY); g.stroke();
      g.restore();
    }
  }

  // ========= 초기화/리사이즈 =========
  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    State.dpr = dpr;
    State.width = Math.round(window.innerWidth * dpr);
    State.height = Math.round(window.innerHeight * dpr);
    canvas.width = State.width; canvas.height = State.height;
    canvas.style.width = '100vw'; canvas.style.height = '100vh';

    // 림 위치/크기 재계산
    const base = Math.min(State.width, State.height); // 기준 길이
    const hoopY = Math.round(State.height * 0.24);
    const hoopX = Math.round(State.width * 0.55);

    Game.hoop = new Hoop(hoopX, hoopY, base);
    // 공 리스폰(화면 하단 가운데)
    const br = Math.max(14 * dpr, base/22);
    respawnBall(br);
  }

  function respawnBall(r) {
    const x = Math.round(State.width * 0.38);
    const y = Math.round(State.height * 0.82);
    Game.ball = new Ball(x, y, r);
    Game.pendingNewBall = false;
  }

  // ========= 렌더 =========
  function drawCourt(g) {
    g.save();
    // 코트 바닥 그라데이션
    const grd = g.createLinearGradient(0, State.height*0.6, 0, State.height);
    grd.addColorStop(0, 'rgba(255,255,255,.02)');
    grd.addColorStop(1, 'rgba(0,0,0,.18)');
    g.fillStyle = grd;
    g.fillRect(0, State.height*0.55, State.width, State.height*0.45);

    // 바닥 라인
    g.strokeStyle = 'rgba(255,255,255,.1)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, State.height-1); g.lineTo(State.width, State.height-1); g.stroke();

    // 자유투 호(장식)
    const hoop = Game.hoop;
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 3;
    g.beginPath(); g.arc(hoop.cx, hoop.y + State.height*0.28, State.width*0.18, 0, Math.PI, true); g.stroke();

    g.restore();
  }

  // ========= 게임 루프 =========
  function update(dt) {
    const ball = Game.ball, hoop = Game.hoop;

    if (State.startedOnce && State.running) {
      State.timeLeft -= dt;
      if (State.timeLeft <= 0) {
        State.timeLeft = 0;
        endGame();
      }
    }
    timerEl.textContent = Math.ceil(State.timeLeft).toString();

    // 물리 여러 번(충돌 안정화)
    const substeps = 2;
    const subDt = dt / substeps;

    for (let s=0; s<substeps; s++) {
      if (ball) {
        ball.lastY = ball.y;
        ball.applyPhysics(subDt);
        // 림/백보드 충돌은 두 번 정도 반복해 침투 보정
        for (let i=0;i<2;i++) hoop.collideBall(ball);

        // 득점 체크
        if (hoop.checkScore(ball)) {
          State.score += 1;
          scoreEl.textContent = State.score.toString();
          // 득점 직후 일정 깊이까지 자연스럽게 떨어지도록 유지, 이후 새 공
          setTimeout(() => { Game.pendingNewBall = true; }, 350);
        }

        // 공이 바닥에서 멈췄거나 너무 오래됐으면 새 공
        if (ball.shot && (ball.resting && ball.timeSinceShot > 0.25)) {
          Game.pendingNewBall = true;
        }

        if (Game.pendingNewBall) {
          const r = ball.r;
          respawnBall(r);
        }
      }
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
    dt = Math.max(0, Math.min(dt, 0.033)); // 델타 클램프
    State.lastRAF = t;

    // 고정 물리 스텝
    State.accumulator += dt;
    while (State.accumulator >= State.fixedDt) {
      update(State.fixedDt);
      State.accumulator -= State.fixedDt;
    }
    render();
    requestAnimationFrame(frame);
  }

  // ========= 게임 시작/종료 =========
  function startGame() {
    overlay.classList.remove('visible');
    restartBtn.classList.remove('hidden');
    State.running = true;
    if (!Game.input) Game.input = new Input();
    State.score = 0; State.timeLeft = 60; State.startedOnce = false;
    scoreEl.textContent = '0'; timerEl.textContent = '60';
    State.lastRAF = 0; State.accumulator = 0;
    requestAnimationFrame(frame);
  }
  function endGame() {
    State.running = false;
    restartBtn.classList.add('hidden');
    overlay.classList.add('visible');
    overlay.querySelector('h1').textContent = 'TIME UP!';
    overlay.querySelector('p').innerHTML = `점수: <strong>${State.score}</strong>점<br/>다시 도전해 보세요.`;
  }

  // ========= 이벤트 =========
  window.addEventListener('resize', resize);
  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);

  // 초기 준비
  resize();
  overlay.classList.add('visible'); // 최초 진입 오버레이
})();
