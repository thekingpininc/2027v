(() => {
  'use strict';

  /* ============================
     월드 좌표(고정), 상·하단 고정
     화면은 높이(100vh)에 맞추고 좌우는 잘리거나 여백 허용
  ============================ */
  const WORLD = { w: 1920, h: 1080 }; // 16:9 기준 고정 월드

  // ---------- DOM ----------
  const canvas   = document.getElementById('game');
  const ctx      = canvas.getContext('2d');
  const scoreEl  = document.getElementById('score');
  const timerEl  = document.getElementById('timer');
  const overlay  = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restart');
  const toastEl  = document.getElementById('toast');

  // ---------- 설정 ----------
  const Config = {
    roundSeconds: 10,

    // 입력 시작 가능한 영역 (하단 1/2에서만 플릭 가능)
    input: {
      startZoneRatio: 0.5,    // 0.5 = 화면 하단 절반
      minSwipeUpVy: -90,      // 위로 발사 최소 속도 임계값(더 작게=쉽게)
      minSwipeSpeed: 550      // 최소 스와이프 평균 속도(px/s)
    },

    // 에셋 경로 (index.html의 window.GAME_ASSETS로 주입)
    assets: {
      background: (window.GAME_ASSETS && window.GAME_ASSETS.background) || null,
      backboard:  (window.GAME_ASSETS && window.GAME_ASSETS.backboard)  || null,
      rim:        (window.GAME_ASSETS && window.GAME_ASSETS.rim)        || null,
      ball:       (window.GAME_ASSETS && window.GAME_ASSETS.ball)       || null,
    },

    // 배치 기본값 (필요시 미세조정)
    layout: {
      boardWidthRatio: 0.55,  // 백보드 가로폭(화면 너비 대비)
      boardTopY: 0.12,        // 백보드 상단 Y(화면 높이 대비)
      rimWidthRatio: 0.26,    // 림 가로폭(화면 너비 대비)
      rimCenterY: 0.40,       // 림 이미지의 '빨간바 중앙'이 오는 Y(화면 높이 대비)
      rimOffsetX: 0.00,       // 백보드 중심 기준 림 X 오프셋(+우 / -좌, 보드 폭 비율)
      // 림 PNG 내부 비율(빨간바/오픈영역 위치 잡기)
      rimBarRelY: 0.12,       // 림 이미지(top 기준)에서 빨간바 중심의 상대비율(대략)
      rimOpenLeftRel: 0.15,   // 림 이미지 내에서 실제 골대 내부의 좌우 영역(0~1)
      rimOpenRightRel: 0.85
    },

    // 물리
    physics: {
      gravity: 2800, air: 0.999,
      wallRest: 0.70, floorRest: 0.55, rimRest: 0.78,
      maxShotPower: 1900, powerSwipe: 1100, powerDrag: 7.0
    },

    // 득점 판정 (빨간바 바로 아래 선)
    scoring: {
      lineOffset: 6,     // 빨간바 중심에서 아래로 몇 px 내림(월드px)
      expandX: 18        // 좌우 여유폭(px) — 관대하게
    },

    // 리스폰
    respawnDelayMs: 220
  };

  // ---------- 상태 ----------
  const State = {
    dpr: 1, scale: 1,
    running: false,
    timeLeft: Config.roundSeconds,
    score: 0,
    lastRAF: 0, acc: 0, fixedDt: 1/120,
    msgTimeout: 0
  };

  // ---------- 에셋 ----------
  const Assets = {
    background: null, backboard: null, rim: null, ball: null,
    ready: { bg:false, bb:false, rim:false, ball:false },
    // 로드된 실제 비율
    bbRatio: 0.75,    // h/w
    rimRatio: 0.45    // h/w
  };
  function loadImage(path, on) {
    if (!path) return null;
    const img = new Image();
    img.src = path;
    img.onload = () => {
      on(true, img);
    };
    img.onerror = () => on(false, img);
    return img;
  }
  Assets.background = loadImage(Config.assets.background, (ok)=>{ Assets.ready.bg = ok; });
  Assets.backboard  = loadImage(Config.assets.backboard,  (ok,img)=>{
    Assets.ready.bb = ok;
    if (ok && img && img.naturalWidth) Assets.bbRatio = img.naturalHeight / img.naturalWidth;
  });
  Assets.rim        = loadImage(Config.assets.rim, (ok,img)=>{
    Assets.ready.rim = ok;
    if (ok && img && img.naturalWidth) Assets.rimRatio = img.naturalHeight / img.naturalWidth;
  });
  Assets.ball       = loadImage(Config.assets.ball, (ok)=>{ Assets.ready.ball = ok; });

  // ---------- 게임 객체 ----------
  const Game = {
    hoop: null,     // 배치 정보(백보드/림/판정선)
    ball: null,     // 현재 공
    input: null
  };

  // ---------- 유틸 ----------
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const now   = ()=>performance.now();

  // ---------- 레이아웃/리사이즈 ----------
  function resize() {
    State.dpr   = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssH  = window.innerHeight;                 // 상·하단 맞춤
    const scale = cssH / WORLD.h;                     // 월드→CSS
    const cssW  = Math.round(WORLD.w * scale);

    // 캔버스 픽셀크기
    canvas.width  = Math.round(WORLD.w * State.dpr);
    canvas.height = Math.round(WORLD.h * State.dpr);

    // CSS 크기: 높이 고정, 좌우는 잘리거나 여백 허용
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';

    State.scale = scale;

    buildHoop();
    if (!Game.ball) spawnBall(); else placeBallOnFloor();
  }

  function buildHoop() {
    const cx = WORLD.w * 0.5;

    // 백보드
    const boardW = WORLD.w * Config.layout.boardWidthRatio;
    const boardH = boardW * (Assets.bbRatio || 0.75);
    const boardX = cx - boardW/2;
    const boardY = WORLD.h * Config.layout.boardTopY;

    // 림
    const rimW = WORLD.w * Config.layout.rimWidthRatio;
    const rimH = rimW * (Assets.rimRatio || 0.45);
    const rimCenterY = WORLD.h * Config.layout.rimCenterY;
    const rimX = cx - rimW/2 + (Config.layout.rimOffsetX * boardW);
    const rimY = rimCenterY - rimH * Config.layout.rimBarRelY; // rimBarRelY가 '빨간바 중심' 비율이므로 위쪽 여유 포함

    // 림 내부 오픈 구간(득점 가능 x범위)
    const openLeft  = rimX + rimW * Config.layout.rimOpenLeftRel;
    const openRight = rimX + rimW * Config.layout.rimOpenRightRel;

    // 림 바(빨간바) 중심 y
    const barY = rimY + rimH * Config.layout.rimBarRelY;

    // 노드 반경(충돌용)
    const nodeR = (openRight - openLeft) * 0.04;

    Game.hoop = {
      board: { x: boardX, y: boardY, w: boardW, h: boardH },
      rim:   { x: rimX, y: rimY, w: rimW, h: rimH, barY, openLeft, openRight, nodeR },
      scoreY: barY + Config.scoring.lineOffset,
      scoreLeft: openLeft - Config.scoring.expandX,
      scoreRight: openRight + Config.scoring.expandX
    };
  }

  // ---------- 공 ----------
  class Ball {
    constructor(x,y,r) {
      this.x=x; this.y=y; this.r=r;
      this.vx=0; this.vy=0;
      this.held=false; this.shot=false; this.resting=false;
      this.lastY=y; this.timeSinceShot=0; this.scored=false;
    }
    apply(dt) {
      if (this.held) return;

      // 중력/감쇠
      this.vy += Config.physics.gravity * dt;
      this.vx *= Math.pow(Config.physics.air, dt*120);
      this.vy *= Math.pow(Config.physics.air, dt*120);

      this.x += this.vx * dt;
      this.y += this.vy * dt;

      // 좌우 벽
      if (this.x - this.r < 0) { this.x = this.r; this.vx = Math.abs(this.vx) * Config.physics.wallRest; }
      if (this.x + this.r > WORLD.w) { this.x = WORLD.w - this.r; this.vx = -Math.abs(this.vx) * Config.physics.wallRest; }

      // 바닥
      if (this.y + this.r > WORLD.h) {
        this.y = WORLD.h - this.r;
        if (this.vy > 0) this.vy = -this.vy * Config.physics.floorRest;
        this.vx *= 0.985;
        if (Math.abs(this.vx) < 6 && Math.abs(this.vy) < 25) { this.resting=true; this.vx=0; this.vy=0; }
      }

      if (this.shot) this.timeSinceShot += dt;
    }
    draw(g) {
      g.save();
      g.shadowColor='rgba(0,0,0,.35)'; g.shadowBlur=12; g.shadowOffsetY=4;
      if (Assets.ready.ball && Assets.ball) {
        const d = this.r*2;
        g.drawImage(Assets.ball, this.x - this.r, this.y - this.r, d, d);
      } else {
        g.beginPath(); g.arc(this.x,this.y,this.r,0,Math.PI*2);
        g.fillStyle='#f2a23a'; g.fill(); g.lineWidth=2; g.strokeStyle='#cc7d11'; g.stroke();
      }
      g.restore();
    }
  }

  function spawnBall() {
    const r = Math.max(28, WORLD.h/22);
    const x = WORLD.w * 0.5;
    const y = WORLD.h * 0.86;
    Game.ball = new Ball(x,y,r);
  }
  function placeBallOnFloor() {
    const b=Game.ball; if(!b) return;
    b.x = WORLD.w * 0.5;
    b.y = WORLD.h * 0.86;
    b.vx=b.vy=0; b.held=false; b.shot=false; b.resting=false; b.scored=false; b.timeSinceShot=0;
  }

  // ---------- 림 충돌 (한쪽방향) & 득점 ----------
  function collideHoop(ball) {
    const { rim } = Game.hoop;
    // 림 바(수평 캡슐) — 공이 '위에서 내려올 때만' 충돌 (한쪽 방향)
    const applyBar = (ball.vy > 0) && ((ball.y - ball.r) < rim.barY); // 공의 윗부분이 바 위쪽에 있고, 내려오는 중
    if (applyBar) {
      const ax = rim.openLeft, ay = rim.barY, bx = rim.openRight, by = rim.barY;
      const r  = rim.nodeR * 0.55; // 얇게 — 득점 통과 방해 최소화

      const vx = bx - ax, vy = by - ay;
      const wx = ball.x - ax, wy = ball.y - ay;
      const vv = vx*vx + vy*vy || 1e-6;
      let t = (wx*vx + wy*vy) / vv; t = clamp(t, 0, 1);
      const cx = ax + t*vx, cy = ay + t*vy;
      const dx = ball.x - cx, dy = ball.y - cy;
      const dist = Math.hypot(dx,dy);
      const minDist = ball.r + r;
      if (dist < minDist) {
        const nx = dx / (dist || 1e-6), ny = dy / (dist || 1e-6);
        const pen = (minDist - dist);
        ball.x += nx * pen; ball.y += ny * pen;
        const vDot = ball.vx*nx + ball.vy*ny;
        ball.vx = ball.vx - (1+Config.physics.rimRest) * vDot * nx;
        ball.vy = ball.vy - (1+Config.physics.rimRest) * vDot * ny;
        ball.vx *= 0.985; ball.vy *= 0.985;
      }
    }

    // 양 끝 노드(원) 충돌 — 양방향 적용
    const hitNode = (cx,cy,rn)=>{
      const dx=ball.x-cx, dy=ball.y-cy;
      const dist=Math.hypot(dx,dy), min=ball.r+rn;
      if (dist<min) {
        const nx=dx/(dist||1e-6), ny=dy/(dist||1e-6);
        const pen=min-dist;
        ball.x+=nx*pen; ball.y+=ny*pen;
        const vDot=ball.vx*nx+ball.vy*ny;
        ball.vx = ball.vx - (1+Config.physics.rimRest)*vDot*nx;
        ball.vy = ball.vy - (1+Config.physics.rimRest)*vDot*ny;
        ball.vx*=0.985; ball.vy*=0.985;
      }
    };
    hitNode(rim.openLeft, rim.barY, rim.nodeR);
    hitNode(rim.openRight, rim.barY, rim.nodeR);
  }

  function checkGoal(ball) {
    if (ball.scored || !ball.shot) return false;
    const { scoreLeft, scoreRight, scoreY } = Game.hoop;
    const crossedDown = (ball.lastY < scoreY && ball.y >= scoreY);
    const inX         = (ball.x > scoreLeft && ball.x < scoreRight);
    const goingDown   = (ball.vy > 0);
    if (crossedDown && inX && goingDown) {
      ball.scored = true; return true;
    }
    return false;
  }

  // ---------- 입력 ----------
  class Input {
    constructor(){
      this.active=false; this.sx=0; this.sy=0; this.x=0; this.y=0; this.samples=[];
      canvas.addEventListener('pointerdown', this.onDown, {passive:false});
      window.addEventListener('pointermove', this.onMove, {passive:false});
      window.addEventListener('pointerup',   this.onUp,   {passive:false});
    }
    toWorld(e){
      const rect=canvas.getBoundingClientRect();
      const cssX=(e.clientX-rect.left), cssY=(e.clientY-rect.top);
      return { x: clamp(cssX/State.scale,0,WORLD.w), y: clamp(cssY/State.scale,0,WORLD.h) };
    }
    withinBall(x,y){
      const b=Game.ball; if(!b) return false;
      return Math.hypot(x-b.x, y-b.y) <= b.r*1.15;
    }
    onDown = (e)=>{
      e.preventDefault();
      if(!State.running) return;
      const p=this.toWorld(e);
      // 하단 1/2 영역에서만 시작 허용
      if (p.y < WORLD.h * (1 - Config.input.startZoneRatio)) return;
      if (this.withinBall(p.x,p.y)){
        this.active=true; this.sx=this.x=p.x; this.sy=this.y=p.y;
        this.samples.length=0; this.push(p.x,p.y);
        const b=Game.ball; b.held=true; b.resting=false;
      }
    }
    onMove = (e)=>{
      if(!this.active) return;
      const p=this.toWorld(e); this.x=p.x; this.y=p.y; this.push(p.x,p.y);
      const b=Game.ball; if(b && b.held){
        b.x=this.x;
        // 바닥 아래/너무 위로 끌고가지 않도록
        b.y=clamp(this.y, WORLD.h*0.25, WORLD.h - b.r);
      }
    }
    onUp = (e)=>{
      if(!this.active) return;
      this.active=false;
      const b=Game.ball; if(!(b && b.held)) return;

      // 스와이프 속도 계산(최근 120ms)
      let i=this.samples.length-1; const tLast=this.samples[i].t;
      while(i>0 && (tLast-this.samples[i-1].t)<120) i--;
      const vdx=this.samples[this.samples.length-1].x - this.samples[i].x;
      const vdy=this.samples[this.samples.length-1].y - this.samples[i].y;
      const dt=(this.samples[this.samples.length-1].t - this.samples[i].t)/1000 || 1/60;
      const speed = Math.hypot(vdx, vdy) / (dt || 1e-6);

      // 드래그+스와이프 혼합
      const dragVX=(this.sx-this.x)*Config.physics.powerDrag;
      const dragVY=(this.sy-this.y)*Config.physics.powerDrag;
      const swipeVX=-(vdx/dt)*(Config.physics.powerSwipe/1000);
      const swipeVY=-(vdy/dt)*(Config.physics.powerSwipe/1000);

      let vx = dragVX*0.2 + swipeVX*0.8;
      let vy = dragVY*0.2 + swipeVY*0.8;

      // 위로 던진 동작 & 최소 스와이프 속도 체크 (쉬움)
      if (vy >= Config.input.minSwipeUpVy || speed < Config.input.minSwipeSpeed) { vx=0; vy=0; }

      const spd=Math.hypot(vx,vy);
      if (spd > Config.physics.maxShotPower) {
        const s=Config.physics.maxShotPower/(spd||1); vx*=s; vy*=s;
      }

      b.held=false; b.shot=true; b.vx=vx; b.vy=vy;
    }
    push(x,y){ this.samples.push({x,y,t:now()}); const cut=now()-180; while(this.samples.length && this.samples[0].t<cut) this.samples.shift(); }
    drawAim(g){
      if(!this.active) return;
      g.save();
      g.strokeStyle='rgba(255,255,255,.8)'; g.lineWidth=2; g.setLineDash([6,6]);
      g.beginPath(); g.moveTo(this.sx,this.sy); g.lineTo(this.x,this.y); g.stroke();
      g.restore();
    }
  }

  // ---------- 토스트 ----------
  function showToast(text,color='white'){
    if (!toastEl) return;
    toastEl.textContent=text; toastEl.style.color=color;
    toastEl.classList.add('show');
    clearTimeout(State.msgTimeout);
    State.msgTimeout = setTimeout(()=>toastEl.classList.remove('show'), 500);
  }

  // ---------- 게임 루프 ----------
  function update(dt){
    if(State.running){
      State.timeLeft -= dt;
      if(State.timeLeft<=0){ State.timeLeft=0; endGame(); }
    }
    timerEl.textContent = String(Math.ceil(State.timeLeft));

    const b=Game.ball; if(!b) return;

    b.lastY=b.y; b.apply(dt);

    // 림 충돌(슛 상태일 때만)
    if (b.shot) collideHoop(b);

    // 득점
    if (b.shot && checkGoal(b)) {
      State.score += 1; scoreEl.textContent = String(State.score);
      showToast('GOAL!', '#38ff9b');
      setTimeout(()=>placeBallOnFloor(), Config.respawnDelayMs);
      return;
    }

    // 실패: 큰 이탈 / 충분히 멈춤
    if ((b.y - b.r > WORLD.h + 140) || (b.shot && b.resting && b.timeSinceShot>0.25)) {
      showToast('FAIL', '#ffd166');
      setTimeout(()=>placeBallOnFloor(), Config.respawnDelayMs);
    }
  }

  function render(){
    ctx.setTransform(State.dpr,0,0,State.dpr,0,0);
    ctx.clearRect(0,0,WORLD.w,WORLD.h);

    // 배경
    if (Assets.ready.bg && Assets.background) {
      ctx.drawImage(Assets.background, 0, 0, WORLD.w, WORLD.h);
    } else {
      const g=ctx.createLinearGradient(0,0,0,WORLD.h);
      g.addColorStop(0,'#163d6b'); g.addColorStop(1,'#0c1220');
      ctx.fillStyle=g; ctx.fillRect(0,0,WORLD.w,WORLD.h);
    }

    // 백보드/림
    if (Game.hoop) {
      const {board, rim} = Game.hoop;
      if (Assets.ready.bb && Assets.backboard)
        ctx.drawImage(Assets.backboard, board.x, board.y, board.w, board.h);
      if (Assets.ready.rim && Assets.rim)
        ctx.drawImage(Assets.rim, rim.x, rim.y, rim.w, rim.h);

      // 디버그 가이드(필요시 주석 해제)
      // ctx.strokeStyle='rgba(255,0,0,.35)'; ctx.beginPath();
      // ctx.moveTo(Game.hoop.scoreLeft, Game.hoop.scoreY); ctx.lineTo(Game.hoop.scoreRight, Game.hoop.scoreY); ctx.stroke();
      // ctx.strokeStyle='rgba(255,255,0,.25)'; ctx.strokeRect(board.x, board.y, board.w, board.h);
    }

    // 조준선
    Game.input && Game.input.drawAim(ctx);

    // 공
    Game.ball && Game.ball.draw(ctx);
  }

  function frame(t){
    if(!State.running) return;
    if(!State.lastRAF) State.lastRAF=t;
    let dt=(t-State.lastRAF)/1000; dt=Math.max(0,Math.min(dt,0.033));
    State.lastRAF=t;

    State.acc += dt;
    while(State.acc >= State.fixedDt){
      update(State.fixedDt);
      State.acc -= State.fixedDt;
    }
    render();
    requestAnimationFrame(frame);
  }

  // ---------- 시작/종료 ----------
  function startGame(){
    overlay.classList.remove('visible');
    restartBtn.classList.remove('hidden');
    State.running=true;
    State.timeLeft=Config.roundSeconds; timerEl.textContent=String(Config.roundSeconds);
    State.score=0; scoreEl.textContent='0';
    State.lastRAF=0; State.acc=0;
    if(!Game.input) Game.input=new Input();
    placeBallOnFloor();
    requestAnimationFrame(frame);
  }
  function endGame(){
    State.running=false;
    restartBtn.classList.add('hidden');
    overlay.classList.add('visible');
    overlay.querySelector('h1').textContent='TIME UP!';
    overlay.querySelector('p').innerHTML=`득점: <strong>${State.score}</strong>개<br/>다시 도전해 보세요.`;
  }

  // ---------- 이벤트 ----------
  window.addEventListener('resize', resize);
  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);

  // ---------- 초기화 ----------
  resize();
  overlay.classList.add('visible');
})();
