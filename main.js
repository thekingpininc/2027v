(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const timerEl = document.getElementById('timer');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restart');

  const Config = {
    timerSeconds: 20,        
    catchZoneTopRatio: 0.60,  
    spawnMinMs: 700,        
    spawnMaxMs: 1400,          
    assets: {
      backboard: (window.GAME_ASSETS && window.GAME_ASSETS.backboard) || null,
      ball: (window.GAME_ASSETS && window.GAME_ASSETS.ball) || null,
    },
    board: {
      widthRatio: 0.50, 
      topPadRatio: 0.03,
      rimOffsetX: -0.02, 
      rimOffsetY: 0.33,
      rimWidthRatio: 0.22
    }
  };

  const World = {
    gravity: 2600,
    air: 0.999,
    wallRestitution: 0.78,
    floorRestitution: 0.62,
    rimRestitution: 0.82,
    maxShotPower: 2000,
    powerFromSwipe: 1100,
    powerFromDrag: 7.0,
    incomingGravity: 1200,
  };

  const State = {
    width: 0, height: 0, dpr: 1,
    running: false,
    score: 0,
    timeLeft: Config.timerSeconds,
    lastRAF: 0, accumulator: 0, fixedDt: 1/120,
    nextSpawnAt: 0,
  };

  const Assets = { backboard: null, ball: null, loaded: {back:false, ball:false} };
  if (Config.assets.backboard) {
    const img = new Image(); img.src = Config.assets.backboard; img.onload = () => Assets.loaded.back = true;
    Assets.backboard = img;
  }
  if (Config.assets.ball) {
    const img = new Image(); img.src = Config.assets.ball; img.onload = () => Assets.loaded.ball = true;
    Assets.ball = img;
  }

  const Game = {
    ball: null, hoop: null, input: null,
    catchZoneY: 0,   // 잡기 가능 상단 경계 y
    pendingNewBall: false,
  };

  class Ball {
    constructor(x, y, r, mode = 'incoming') {
      this.x = x; this.y = y; this.r = r;
      this.vx = 0; this.vy = 0;
      this.mode = mode;        // incoming | held | shot
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
        this.vy += World.incomingGravity * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;

        if (this.y - this.r > State.height + 80) {
          Game.pendingNewBall = true;
        }
        return;
      }

      this.vy += World.gravity * dt;
      this.vx *= Math.pow(World.air, (dt*120));
      this.vy *= Math.pow(World.air, (dt*120));

      this.x += this.vx * dt;
      this.y += this.vy * dt;

      if (this.x - this.r < 0) {
        this.x = this.r; this.vx = Math.abs(this.vx) * World.wallRestitution;
      } else if (this.x + this.r > State.width) {
        this.x = State.width - this.r; this.vx = -Math.abs(this.vx) * World.wallRestitution;
      }

      if (this.y + this.r > State.height) {
        this.y = State.height - this.r;
        if (this.vy > 0) this.vy = -this.vy * World.floorRestitution;
        this.vx *= 0.985;
        if (Math.abs(this.vx) < 6 && Math.abs(this.vy) < 25) {
          this.resting = true; this.vx = 0; this.vy = 0;
        }
      }

      if (this.y - this.r > State.height + 250) {
        Game.pendingNewBall = true;
      }

      if (this.shot) this.timeSinceShot += dt;
    }
    draw(g) {
      g.save();
      g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
      if (Assets.loaded.ball && Assets.ball) {
        const d = this.r*2;
        g.drawImage(Assets.ball, this.x - this.r, this.y - this.r, d, d);
      } else {
        g.beginPath(); g.arc(this.x, this.y, this.r, 0, Math.PI*2);
        g.fillStyle = '#f2a23a'; g.fill();
        g.lineWidth = 2; g.strokeStyle = '#cc7d11'; g.stroke();
      }
      g.restore();
    }
  }

  class Hoop {
    constructor(cx, y, base) {
      this.cx = cx;
      this.y = y;
      this.rimHalf = Math.max(18, base * Config.board.rimWidthRatio / 2);
      this.rimNodeR = Math.max(8, base/38);
      this.tint = '#e84d2a';

      const boardW = State.width * Config.board.widthRatio;
      const boardH = boardW * 0.75;     // 일반 비율(가로:세로 ≈ 4:3 느낌)
      const boardX = cx - boardW/2;
      const boardY = Math.max(10, State.height * Config.board.topPadRatio);
      this.boardRect = { x: boardX, y: boardY, w: boardW, h: boardH };

      const rimCX = boardX + boardW * (0.5 + Config.board.rimOffsetX);
      const rimCY = boardY + boardH * Config.board.rimOffsetY;
      this.cx = rimCX; this.y = rimCY;

      this.leftNode  = { x: this.cx - this.rimHalf, y: this.y };
      this.rightNode = { x: this.cx + this.rimHalf, y: this.y };

      this.scoreY = this.y + this.rimNodeR*0.6;
      this.scoreLeft = this.leftNode.x + this.rimNodeR*0.7;
      this.scoreRight = this.rightNode.x - this.rimNodeR*0.7;
    }
    collideBall(ball) {
      const hitCircle = (cx, cy, r) => {
        const dx = ball.x - cx, dy = ball.y - cy;
        const dist = Math.hypot(dx, dy);
        const minDist = ball.r + r;
        if (dist < minDist) {
          const nx = dx / (dist || 1e-6), ny = dy / (dist || 1e-6);
          const pen = (minDist - dist);
          ball.x += nx * pen; ball.y += ny * pen;
          const vDotN = ball.vx*nx + ball.vy*ny;
          ball.vx = ball.vx - (1+World.rimRestitution)*vDotN*nx;
          ball.vy = ball.vy - (1+World.rimRestitution)*vDotN*ny;
          ball.vx *= 0.985; ball.vy *= 0.985;
        }
      };
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
          ball.vx = ball.vx - (1+World.rimRestitution)*vDotN*nx;
          ball.vy = ball.vy - (1+World.rimRestitution)*vDotN*ny;
          ball.vx *= 0.985; ball.vy *= 0.985;
        }
      };

      hitCircle(this.leftNode.x, this.leftNode.y, this.rimNodeR);
      hitCircle(this.rightNode.x, this.rightNode.y, this.rimNodeR);
      hitCapsule(this.leftNode.x, this.leftNode.y, this.rightNode.x, this.rightNode.y, this.rimNodeR*0.6);

      const boardX = this.boardRect.x + this.boardRect.w*0.82;
      const by = this.boardRect.y + this.boardRect.h*0.08;
      const bw = Math.max(4, State.width/240);
      const bh = this.boardRect.h*0.60;
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
      if (Assets.loaded.back && Assets.backboard) {
        g.drawImage(Assets.backboard, this.boardRect.x, this.boardRect.y, this.boardRect.w, this.boardRect.h);
      } else {
        g.fillStyle = '#2a385d';
        g.fillRect(this.boardRect.x, this.boardRect.y, this.boardRect.w, this.boardRect.h);
      }

      g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 8; g.shadowOffsetX = -2; g.shadowOffsetY = 2;
      g.strokeStyle = this.tint; g.lineWidth = Math.max(3, State.width/240);
      g.beginPath(); g.moveTo(this.leftNode.x, this.y); g.lineTo(this.rightNode.x, this.y); g.stroke();

      const drawNode = (p) => { g.beginPath(); g.arc(p.x, p.y, this.rimNodeR, 0, Math.PI*2); g.fillStyle = this.tint; g.fill(); };
      drawNode(this.leftNode); drawNode(this.rightNode);

      g.shadowColor = 'transparent';
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(this.leftNode.x+4, this.y+2); g.lineTo(this.rightNode.x-4, this.y+2); g.stroke();
      g.restore();
    }
  }

  class Input {
    constructor() {
      this.active = false;
      this.startX = 0; this.startY = 0;
      this.curX = 0; this.curY = 0;
      this.samples = [];
      canvas.addEventListener('pointerdown', this.onDown, {passive:false});
      window.addEventListener('pointermove', this.onMove, {passive:false});
      window.addEventListener('pointerup', this.onUp, {passive:false});
    }
    toCanvasXY(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (State.width / rect.width),
        y: (e.clientY - rect.top) * (State.height / rect.height),
      };
    }
    withinBall(x, y) {
      const b = Game.ball;
      if (!b) return false;
      const d = Math.hypot(x - b.x, y - b.y);
      return d <= b.r * 1.15;
    }
    onDown = (e) => {
      e.preventDefault();
      if (!State.running) return;
      const p = this.toCanvasXY(e);
      const b = Game.ball;

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
        const dragVX = (this.startX - this.curX) * World.powerFromDrag;
        const dragVY = (this.startY - this.curY) * World.powerFromDrag;

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

        if (vy >= -80) { vx = 0; vy = 0; }

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
      this.samples.push({x, y, t: performance.now()});
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

  function resize() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    State.dpr = dpr;
    State.width = Math.round(window.innerWidth * dpr);
    State.height = Math.round(window.innerHeight * dpr);
    canvas.width = State.width; canvas.height = State.height;
    canvas.style.width = '100vw'; canvas.style.height = '100vh';

    Game.catchZoneY = Math.round(State.height * Config.catchZoneTopRatio);

    const base = Math.min(State.width, State.height);
    const hoopX = Math.round(State.width * 0.5);
    const hoopY = Math.round(State.height * 0.18);
    Game.hoop = new Hoop(hoopX, hoopY, base);

    const br = Math.max(14 * dpr, base/22);
    if (!Game.ball) {
      spawnIncoming(br);
    } else {
      Game.ball.r = br;
      Game.ball.x = Math.min(Math.max(Game.ball.x, br), State.width-br);
      Game.ball.y = Math.min(Math.max(Game.ball.y, br), State.height-br);
    }
  }

  function spawnIncoming(r) {
    const x = Math.round(State.width * (0.25 + Math.random()*0.5)); // 25%~75%
    const y = Math.round(State.height * (0.02 + Math.random()*0.06));
    const b = new Ball(x, y, r, 'incoming');
    b.vx = (Math.random()*2 - 1) * 120;
    b.vy = 220 + Math.random()*140;
    Game.ball = b;
    Game.pendingNewBall = false;
  }

  function scheduleNextSpawn() {
    const ms = Config.spawnMinMs + Math.random()*(Config.spawnMaxMs - Config.spawnMinMs);
    State.nextSpawnAt = performance.now() + ms;
  }

  function drawCourt(g) {
    g.save();
    g.fillStyle = 'rgba(255,255,255,.04)';
    g.fillRect(0, Game.catchZoneY, State.width, State.height - Game.catchZoneY);
    g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, Game.catchZoneY); g.lineTo(State.width, Game.catchZoneY); g.stroke();
    g.restore();
  }

  function update(dt) {
    const ball = Game.ball, hoop = Game.hoop;

    if (State.running) {
      State.timeLeft -= dt;
      if (State.timeLeft <= 0) {
        State.timeLeft = 0;
        endGame();
      }
    }
    timerEl.textContent = Math.ceil(State.timeLeft).toString();

    const substeps = 2;
    const subDt = dt / substeps;

    for (let s=0; s<substeps; s++) {
      if (ball) {
        ball.lastY = ball.y;
        ball.applyPhysics(subDt);

        if (ball.mode === 'shot') {
          for (let i=0;i<3;i++) hoop.collideBall(ball);
          if (hoop.checkScore(ball)) {
            State.score += 1;
            scoreEl.textContent = State.score.toString();
            Game.pendingNewBall = true;
            scheduleNextSpawn();
          }
          if (ball.shot && (ball.resting && ball.timeSinceShot > 0.25)) {
            Game.pendingNewBall = true;
            scheduleNextSpawn();
          }
        }

        if (Game.pendingNewBall && performance.now() >= State.nextSpawnAt) {
          const r = ball.r;
          spawnIncoming(r);
        }
      } else {
        spawnIncoming(Math.max(14*State.dpr, Math.min(State.width, State.height)/22));
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

  function startGame() {
    overlay.classList.remove('visible');
    restartBtn.classList.remove('hidden');
    State.running = true;
    if (!Game.input) Game.input = new Input();
    State.score = 0; State.timeLeft = Config.timerSeconds;
    scoreEl.textContent = '0'; timerEl.textContent = String(Config.timerSeconds);
    State.lastRAF = 0; State.accumulator = 0;

    if (!Game.ball) spawnIncoming(Math.max(14*State.dpr, Math.min(State.width, State.height)/22));
    Game.pendingNewBall = true; scheduleNextSpawn();

    requestAnimationFrame(frame);
  }

  function endGame() {
    State.running = false;
    restartBtn.classList.add('hidden');
    overlay.classList.add('visible');
    overlay.querySelector('h1').textContent = 'TIME UP!';
    overlay.querySelector('p').innerHTML = `득점: <strong>${State.score}</strong>개<br/>다시 도전해 보세요.`;
  }

  window.addEventListener('resize', resize);
  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);

  resize();
  overlay.classList.add('visible');
})();
