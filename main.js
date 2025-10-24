(() => {
  'use strict';

  // =========================
  // World & DOM
  // =========================
  const WORLD = { w: 1920, h: 1080 }; // 16:9 고정 월드

  const canvas     = document.getElementById('game');
  const ctx        = canvas.getContext('2d');
  const scoreEl    = document.getElementById('score');
  const timerEl    = document.getElementById('timer');
  const toastEl    = document.getElementById('toast');
  const overlay    = document.getElementById('overlay');
  const startBtn   = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restart');

  // =========================
  // Config
  // =========================
  const Config = {
    roundSeconds: 10,

    // [MOD:INPUT_THRESHOLDS] — 클릭만으론 발사 금지(강한 제스처 필요)
    input: {
      startZoneRatio: 0.5,   // 하단 1/2에서만 시작
      minSwipeSpeed: 520,    // 최소 스와이프 속도(px/s)
      minTotalTravel: 28,    // 총 이동거리 최소(px)
      minUpTravel: 22,       // '위로' 이동 최소(px)
      rimNoCloseGapRatio: 0.18 // 림 가까이 끌어올려 조준 금지 (림 너비 * 비율 + 공 r)
    },

    // [MOD:ASSETS] — 씬 합본 + 림 + 공
    assets: {
      scene: (window.GAME_ASSETS && window.GAME_ASSETS.scene) || null,
      rim:   (window.GAME_ASSETS && window.GAME_ASSETS.rim)   || null,
      ball:  (window.GAME_ASSETS && window.GAME_ASSETS.ball)  || null,
    },

    // [MOD:RIM_POSITION] — 림 위치/크기 (scene 원본 좌표의 %)
    // rimCyPct는 "빨간바 중심"의 세로 위치 — ↓로 갈수록 값이 커짐.
    // ▶ 더 위로: 값을 줄이세요 (예: 0.446 → 0.444)
    sceneLayout: {
      rimCxPct: 0.500,
      rimCyPct: 0.446,          // 0.458에서 위로 0.012 올림
      rimWidthPctOfWorld: 0.205 // 림 가로폭(월드 너비 비율)
    },

    // rim.png 내부 상대 위치
    rimImage: {
      barCenterRelY: 0.12,  // 이미지 top 기준 빨간바 중심 (살짝 어긋나면 0.115~0.125 조정)
      openLeftRel:   0.20,
      openRightRel:  0.80
    },

    // 공 크기(+5%)
    ball: { scale: 1.05 },

    // 물리
    physics: {
      gravity: 2800, air: 0.999,
      wallRest: 0.70, floorRest: 0.55, rimRest: 0.76,
      powerSwipe: 1400, powerDrag: 7.0, maxShotPower: 2600
    },

    // 슛 느낌: 림 위까지 올라갈 힘 보장 + 약한 에임 어시스트
    shooting: {
      aimAssist: 0.18,          // 플릭에 림 방향 18% 혼합
      clearMarginR: 0.65,       // 림을 넘길 최소 여유(공 r 배수)
      minVyBoost: 1.06          // vy_min 여유
    },

    // 득점 판정
    scoring: { lineOffset: 6, expandX: 18 },

    // 즉시 리셋 관련
    reset: {
      oobMargin: 120            // [MOD:INSTANT_RESET_OUT_OF_BOUNDS] 장외 여유(px)
    },

    respawnDelayMs: 220,        // Goal만 약간의 연출 딜레이

    // [MOD:SFX] 배경음/BGM + Goal 효과음
    sfx: {
      bgmUrl:  'assets/bgm.mp3',
      goalUrl: 'assets/Goal.mp3',
      bgmVolume: 0.28,   // 0.0 ~ 1.0
      goalVolume: 0.9
    }
  };

  // =========================
  // State & Assets
  // =========================
  const State = {
    dpr: 1, scale: 1,
    running: false,
    timeLeft: Config.roundSeconds,
    score: 0,
    lastRAF: 0, acc: 0, fixedDt: 1/120,
    msgTimeout: 0,
    sceneMap: { scale:1, dx:0, dy:0, iw:0, ih:0 }
  };

  const Assets = {
    scene: null, rim: null, ball: null,
    ready: { scene:false, rim:false, ball:false },
    rimRatio: 0.45
  };

  // [MOD:SFX] 오디오 핸들 (JS에서 직접 로드)
  const SFX = {
    bgm: null,
    goal: null,
    unlocked: false
  };
  (function initAudio(){
    try {
      if (Config.sfx.bgmUrl) {
        SFX.bgm = new Audio(Config.sfx.bgmUrl);
        SFX.bgm.loop = true;
        SFX.bgm.volume = Config.sfx.bgmVolume;
        SFX.bgm.preload = 'auto';
      }
      if (Config.sfx.goalUrl) {
        SFX.goal = new Audio(Config.sfx.goalUrl);
        SFX.goal.volume = Config.sfx.goalVolume;
        SFX.goal.preload = 'auto';
      }
    } catch(_) {}
  })();

  function loadImage(path, on){
    if(!path) return null;
    const img = new Image();
    img.src = path;
    img.onload = () => on(true, img);
    img.onerror = () => on(false, img);
    return img;
  }

  Assets.scene = loadImage(Config.assets.scene, (ok,img)=>{
    Assets.ready.scene = ok;
    if (ok){ State.sceneMap.iw = img.naturalWidth; State.sceneMap.ih = img.naturalHeight; }
    resize();
  });
  Assets.rim = loadImage(Config.assets.rim, (ok,img)=>{
    Assets.ready.rim = ok;
    if (ok && img.naturalWidth) Assets.rimRatio = img.naturalHeight / img.naturalWidth;
    buildHoop(); render();
  });
  Assets.ball = loadImage(Config.assets.ball, ok=>{ Assets.ready.ball = ok; });

  const Game = { hoop:null, ball:null, input:null };

  // =========================
  // Utils
  // =========================
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const now = ()=>performance.now();

  function computeSceneMap(){
    const iw = State.sceneMap.iw || 1920, ih = State.sceneMap.ih || 1080;
    const s  = Math.max(WORLD.w/iw, WORLD.h/ih);
    const dw = iw*s, dh = ih*s;
    State.sceneMap.scale = s;
    State.sceneMap.dx = (WORLD.w - dw)/2;
    State.sceneMap.dy = (WORLD.h - dh)/2;
  }
  function sceneUVtoWorld(u,v){
    const M = State.sceneMap;
    return { x: M.dx + u*M.scale, y: M.dy + v*M.scale };
  }

  // =========================
  // Layout / Resize
  // =========================
  function resize(){
    State.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssH = window.innerHeight;
    const scale = cssH / WORLD.h;
    const cssW = Math.round(WORLD.w * scale);

    canvas.width  = Math.round(WORLD.w * State.dpr);
    canvas.height = Math.round(WORLD.h * State.dpr);
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';
    State.scale = scale;

    computeSceneMap();
    buildHoop();
    if (!Game.ball) spawnBall(); else placeBallOnFloor();
    render();
  }

  function buildHoop(){
    const u = (State.sceneMap.iw || 1920) * Config.sceneLayout.rimCxPct;
    const v = (State.sceneMap.ih || 1080) * Config.sceneLayout.rimCyPct;
    const rimCenter = sceneUVtoWorld(u, v);

    const rimW = WORLD.w * Config.sceneLayout.rimWidthPctOfWorld;
    const rimH = rimW * (Assets.rimRatio || 0.45);
    const rimX = rimCenter.x - rimW/2;
    const rimY = rimCenter.y - rimH * Config.rimImage.barCenterRelY;

    const openLeft  = rimX + rimW * Config.rimImage.openLeftRel;
    const openRight = rimX + rimW * Config.rimImage.openRightRel;
    const barY      = rimY + rimH * Config.rimImage.barCenterRelY;
    const nodeR     = (openRight - openLeft) * 0.04;

    Game.hoop = {
      rim: { x: rimX, y: rimY, w: rimW, h: rimH, barY, openLeft, openRight, nodeR },
      scoreY: barY + Config.scoring.lineOffset,
      scoreLeft:  openLeft  - Config.scoring.expandX,
      scoreRight: openRight + Config.scoring.expandX
    };
  }

  // =========================
  // Ball
  // =========================
  class Ball{
    constructor(x,y,r){
      this.x=x; this.y=y; this.r=r;
      this.vx=0; this.vy=0;
      this.held=false; this.shot=false; this.resting=false;
      this.lastY=y; this.timeSinceShot=0; this.scored=false;

      // 2.5D 레이어
      this.layer='front';     // 'front' | 'back'
      this.clearedTop=false;  // 림 위(빨간바 위)까지 올라간 적

      // 바닥 접촉 감지(즉시 리셋용)
      this.hitFloor=false;
    }
    apply(dt){
      if(this.held) return;
      this.vy += Config.physics.gravity * dt;
      this.vx *= Math.pow(Config.physics.air, dt*120);
      this.vy *= Math.pow(Config.physics.air, dt*120);
      this.x  += this.vx * dt;
      this.y  += this.vy * dt;

      if (this.x - this.r < 0){ this.x=this.r; this.vx=Math.abs(this.vx)*Config.physics.wallRest; }
      if (this.x + this.r > WORLD.w){ this.x=WORLD.w-this.r; this.vx=-Math.abs(this.vx)*Config.physics.wallRest; }

      // 바닥
      if (this.y + this.r > WORLD.h){
        this.y = WORLD.h - this.r;
        if (this.shot) this.hitFloor = true; // [MOD:INSTANT_RESET_ON_FLOOR]
        if (this.vy > 0) this.vy = -this.vy * Config.physics.floorRest;
        this.vx *= 0.985;
        if (Math.abs(this.vx)<6 && Math.abs(this.vy)<25){ this.resting=true; this.vx=0; this.vy=0; }
      }
      if (this.shot) this.timeSinceShot += dt;
    }
    draw(g){
      g.save(); g.shadowColor='rgba(0,0,0,.35)'; g.shadowBlur=12; g.shadowOffsetY=4;
      if (Assets.ready.ball && Assets.ball){
        const d=this.r*2; g.drawImage(Assets.ball, this.x-this.r, this.y-this.r, d, d);
      } else {
        g.beginPath(); g.arc(this.x,this.y,this.r,0,Math.PI*2);
        g.fillStyle='#f2a23a'; g.fill(); g.lineWidth=2; g.strokeStyle='#cc7d11'; g.stroke();
      }
      g.restore();
    }
  }

  function spawnBall(){
    const baseR = Math.max(28, WORLD.h/22);
    const r     = Math.round(baseR * Config.ball.scale); // +5%
    Game.ball   = new Ball(WORLD.w*0.5, WORLD.h*0.86, r);
  }
  function placeBallOnFloor(){
    const b=Game.ball; if(!b) return;
    b.x=WORLD.w*0.5; b.y=WORLD.h*0.86; b.vx=b.vy=0; b.held=false; b.shot=false; b.resting=false; b.scored=false; b.timeSinceShot=0;
    b.layer='front'; b.clearedTop=false; b.hitFloor=false;
  }

  // =========================
  // 2.5D Layering (앞/뒤 전환)
  // =========================
  function updateDepthLayer(ball){
    const rim = Game.hoop.rim;
    const topLine = rim.barY - ball.r*0.35; // 빨간바 조금 위
    if (!ball.clearedTop && ball.y < topLine) ball.clearedTop = true;
    // 위로 넘겼고, 내려오면서 내부 x 범위에 들어오면 림 뒤 레이어로
    if (ball.clearedTop && ball.vy > 0 &&
        ball.x > Game.hoop.scoreLeft && ball.x < Game.hoop.scoreRight) {
      ball.layer = 'back';
    }
  }

  // =========================
  // Rim Collision(원웨이) & Scoring
  // =========================
  function collideHoop(ball){
    const rim = Game.hoop.rim;
    const inGoalX = (ball.x > Game.hoop.scoreLeft && ball.x < Game.hoop.scoreRight);
    // 올라갈 땐 절대 바와 충돌 X, 내려올 때도 내부 x면 충돌 X
    const shouldCollideBar = (ball.vy >= 0) && !inGoalX;

    if (shouldCollideBar){
      const ax=rim.openLeft, ay=rim.barY, bx=rim.openRight, by=rim.barY;
      const r = rim.nodeR*0.55;
      const vx=bx-ax, vy=by-ay, wx=ball.x-ax, wy=ball.y-ay;
      const vv=vx*vx+vy*vy || 1e-6; let t=(wx*vx+wy*vy)/vv; t=clamp(t,0,1);
      const cx=ax+t*vx, cy=ay+t*vy;
      const dx=ball.x-cx, dy=ball.y-cy; const dist=Math.hypot(dx,dy), min=ball.r+r;
      if(dist<min){
        const nx=dx/(dist||1e-6), ny=dy/(dist||1e-6), pen=min-dist;
        ball.x+=nx*pen; ball.y+=ny*pen;
        const vDot=ball.vx*nx+ball.vy*ny;
        ball.vx = ball.vx - (1+Config.physics.rimRest)*vDot*nx;
        ball.vy = ball.vy - (1+Config.physics.rimRest)*vDot*ny;
        ball.vx*=0.985; ball.vy*=0.985;
      }
    }

    // 양쪽 노드(원) 충돌
    const hitNode=(cx,cy,rn)=>{
      const dx=ball.x-cx, dy=ball.y-cy; const dist=Math.hypot(dx,dy), min=ball.r+rn;
      if(dist<min){
        const nx=dx/(dist||1e-6), ny=dy/(dist||1e-6), pen=min-dist;
        ball.x+=nx*pen; ball.y+=ny*pen;
        const vDot=ball.vx*nx+ball.vy*ny;
        ball.vx = ball.vx - (1+Config.physics.rimRest)*vDot*nx;
        ball.vy = ball.vy - (1+Config.physics.rimRest)*vDot*ny;
        ball.vx*=0.985; ball.vy*=0.985;
      }
    };
    hitNode(rim.openLeft,  rim.barY, rim.nodeR);
    hitNode(rim.openRight, rim.barY, rim.nodeR);
  }

  function checkGoal(ball){
    if(ball.scored || !ball.shot) return false;
    const {scoreLeft, scoreRight, scoreY} = Game.hoop;
    const crossedDown = (ball.lastY < scoreY && ball.y >= scoreY);
    const inX         = (ball.x > scoreLeft && ball.x < scoreRight);
    const goingDown   = (ball.vy > 0);
    if (crossedDown && inX && goingDown){ ball.scored=true; return true; }
    return false;
  }

  // =========================
  // Input (하단 1/2 시작, 림 근접 드래그 금지, 발사 물리)
  // =========================
  class Input{
    constructor(){
      this.active=false; this.sx=0; this.sy=0; this.x=0; this.y=0; this.samples=[];
      canvas.addEventListener('pointerdown', this.onDown, {passive:false});
      window.addEventListener('pointermove', this.onMove, {passive:false});
      window.addEventListener('pointerup',   this.onUp,   {passive:false});

      // 보조: 일부 WebView에서 pointerdown이 안 들어올 때 탭으로 시작
      canvas.addEventListener('touchstart', (e)=>{
        if (!State.running && overlay.classList.contains('visible')) {
          e.preventDefault();
          startGame();
        }
      }, { passive:false });
    }
    toWorld(e){
      const r=canvas.getBoundingClientRect();
      const x=clamp((e.clientX-r.left)/State.scale,0,WORLD.w);
      const y=clamp((e.clientY-r.top )/State.scale,0,WORLD.h);
      return {x,y};
    }
    withinBall(x,y){
      const b=Game.ball; if(!b) return false;
      return Math.hypot(x-b.x,y-b.y) <= b.r*1.15;
    }

    onDown = (e) => {
      e.preventDefault();
      if(!State.running) return;
      const p=this.toWorld(e);
      if (p.y < WORLD.h * (1 - Config.input.startZoneRatio)) return; // 하단 1/2에서만
      if (this.withinBall(p.x,p.y)){
        this.active=true; this.sx=this.x=p.x; this.sy=this.y=p.y;
        this.samples.length=0; this.push(p.x,p.y);
        const b=Game.ball; b.held=true; b.resting=false;
      }
    }

    onMove = (e) => {
      if(!this.active) return;
      const p=this.toWorld(e); this.x=p.x; this.y=p.y; this.push(p.x,p.y);
      const b=Game.ball; if(b && b.held){
        b.x=this.x;
        // 림에 너무 가까운 곳까지 끌어올려 조준 금지
        const gap  = Game.hoop.rim.w * Config.input.rimNoCloseGapRatio + b.r;
        const minY = Math.max(WORLD.h*0.5, Game.hoop.rim.barY + gap);
        b.y = clamp(this.y, minY, WORLD.h - b.r);
      }
    }

    onUp = (e) => {
      if(!this.active) return;
      this.active=false;

      const b=Game.ball; if(!(b && b.held)) return;

      // 최근 120ms 스와이프 구간
      let i=this.samples.length-1; const tLast=this.samples[i].t;
      while(i>0 && (tLast-this.samples[i-1].t)<120) i--;
      const vdx=this.samples[this.samples.length-1].x - this.samples[i].x;
      const vdy=this.samples[this.samples.length-1].y - this.samples[i].y;
      const dt =(this.samples[this.samples.length-1].t - this.samples[i].t)/1000 || 1/60;
      const speed = Math.hypot(vdx,vdy)/(dt||1e-6);

      // 제스처 기반 발사 벡터(위로 양수) — 슬링샷 느낌
      const dragVX  = (this.sx - this.x) * Config.physics.powerDrag;
      const dragVY  = (this.sy - this.y) * Config.physics.powerDrag;
      const swipeVX = -(vdx/dt) * (Config.physics.powerSwipe / 1000);
      const swipeVY = -(vdy/dt) * (Config.physics.powerSwipe / 1000);
      const launchVX = dragVX*0.2 + swipeVX*0.8;
      const launchVY = dragVY*0.2 + swipeVY*0.8; // ↑로 드래그 시 양수

      // 유효 제스처 체크
      const totalTravel = Math.hypot(this.x - this.sx, this.y - this.sy);
      const upTravel    = this.sy - this.y; // ↑ 방향 이동량(+)
      const swipedUp    = (upTravel >= Config.input.minUpTravel) && (launchVY > 0);
      const fastEnough  = speed >= Config.input.minSwipeSpeed;
      const movedEnough = totalTravel >= Config.input.minTotalTravel;
      const validSwipe  = swipedUp && fastEnough && movedEnough;

      b.held=false;
      if (!validSwipe){ b.shot=false; return; }

      // 물리계 속도(위로 음수)
      let vx = launchVX;
      let vy = -launchVY;

      // 약한 에임 어시스트
      if (Config.shooting.aimAssist > 0){
        const rimCx=(Game.hoop.rim.openLeft + Game.hoop.rim.openRight)*0.5;
        const rimTopY=Game.hoop.rim.barY - b.r*0.25;
        const dx=rimCx-b.x, dy=rimTopY-b.y, len=Math.hypot(dx,dy)||1;
        const ax=(dx/len)*Math.hypot(vx,vy), ay=(dy/len)*Math.hypot(vx,vy);
        const a=Config.shooting.aimAssist; vx=vx*(1-a)+ax*a; vy=vy*(1-a)+ay*a;
      }

      // 최소 포물선 보장 (림 위로 올라가도록)
      const clearance = b.r * Config.shooting.clearMarginR + 10;
      const targetY   = Game.hoop.rim.barY - clearance;
      const needH     = Math.max(0, b.y - targetY);
      const vyMin     = Math.sqrt(2 * Config.physics.gravity * needH) * (Config.shooting.minVyBoost || 1);
      if (-vy < vyMin) vy = -vyMin;

      // 속도 상한(유지) — vy_min 보존
      let spd=Math.hypot(vx,vy);
      if (spd > Config.physics.maxShotPower){
        const s=Config.physics.maxShotPower/spd; vx*=s; vy*=s;
        if (-vy < vyMin){
          vy = -vyMin;
          const vxAllowed = Math.sqrt(Math.max(0, Config.physics.maxShotPower**2 - vyMin**2));
          vx = clamp(vx, -vxAllowed, vxAllowed);
        }
      }

      b.shot=true; b.vx=vx; b.vy=vy;
    }

    push(x,y){
      this.samples.push({x,y,t:now()});
      const cut=now()-180;
      while(this.samples.length && this.samples[0].t<cut) this.samples.shift();
    }
    drawAim(g){
      if(!this.active) return;
      g.save();
      g.strokeStyle='rgba(255,255,255,.8)'; g.lineWidth=2; g.setLineDash([6,6]);
      g.beginPath(); g.moveTo(this.sx,this.sy); g.lineTo(this.x,this.y); g.stroke();
      g.restore();
    }
  }

  // =========================
  // Toast
  // =========================
  function showToast(text,color='white'){
    if(!toastEl) return;
    toastEl.textContent=text; toastEl.style.color=color;
    toastEl.classList.add('show');
    clearTimeout(State.msgTimeout);
    State.msgTimeout=setTimeout(()=>toastEl.classList.remove('show'),500);
  }

  // [MOD:SFX] 오디오 재생 유틸
  function playBGM(){
    if (!SFX.bgm) return;
    try {
      const p = SFX.bgm.play();
      if (p && typeof p.catch === 'function') p.catch(()=>{ /* autoplay 거부 시 무시 */ });
    } catch(_) {}
  }
  function stopBGM(){
    if (!SFX.bgm) return;
    try { SFX.bgm.pause(); } catch(_) {}
    try { SFX.bgm.currentTime = 0; } catch(_) {}
  }
  function playGoal(){
    if (!SFX.goal) return;
    try {
      SFX.goal.currentTime = 0;
      const p = SFX.goal.play();
      if (p && typeof p.catch === 'function') p.catch(()=>{});
    } catch(_) {}
  }

  // =========================
  // Loop
  // =========================
  function update(dt){
    if(State.running){
      State.timeLeft -= dt;
      if(State.timeLeft<=0){ State.timeLeft=0; endGame(); }
    }
    timerEl.textContent = String(Math.ceil(State.timeLeft));

    const b=Game.ball; if(!b) return;
    b.lastY=b.y; b.apply(dt);

    // 레이어 전환
    updateDepthLayer(b);

    // 득점 먼저 (원웨이 충돌로 막히지 않도록)
    if (b.shot && checkGoal(b)){
      State.score += 1; scoreEl.textContent=String(State.score);

      // [MOD:SFX] Goal 효과음
      playGoal();

      showToast('GOAL!', '#38ff9b');
      setTimeout(()=>placeBallOnFloor(), Config.respawnDelayMs);
      return;
    }

    // 장외 즉시 리셋
    if (b.shot && !b.scored){
      const m = Config.reset.oobMargin;
      const oob = (b.x + b.r < -m) || (b.x - b.r > WORLD.w + m) ||
                  (b.y + b.r < -m) || (b.y - b.r > WORLD.h + m);
      if (oob){
        showToast('FAIL', '#ffd166');
        placeBallOnFloor(); // 즉시 새 공
        return;
      }
    }

    // 바닥 접촉 즉시 리셋
    if (b.shot && !b.scored && b.hitFloor){
      showToast('FAIL', '#ffd166');
      placeBallOnFloor();
      return;
    }

    // 림 충돌
    if (b.shot) collideHoop(b);
  }

  // scene cover draw (비율 유지)
  function drawSceneCover(){
    if (!(Assets.ready.scene && Assets.scene)){
      const g=ctx.createLinearGradient(0,0,0,WORLD.h);
      g.addColorStop(0,'#163d6b'); g.addColorStop(1,'#0c1220');
      ctx.fillStyle=g; ctx.fillRect(0,0,WORLD.w,WORLD.h);
      return;
    }
    const img=Assets.scene;
    const iw=img.naturalWidth||1920, ih=img.naturalHeight||1080;
    const s=Math.max(WORLD.w/iw, WORLD.h/ih);
    const dw=iw*s, dh=ih*s;
    const dx=(WORLD.w-dw)/2, dy=(WORLD.h-dh)/2;
    State.sceneMap.scale=s; State.sceneMap.dx=dx; State.sceneMap.dy=dy; State.sceneMap.iw=iw; State.sceneMap.ih=ih;

    ctx.save(); ctx.beginPath(); ctx.rect(0,0,WORLD.w,WORLD.h); ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  function render(){
    ctx.setTransform(State.dpr,0,0,State.dpr,0,0);
    ctx.clearRect(0,0,WORLD.w,WORLD.h);

    drawSceneCover();

    const b=Game.ball, rim=Game.hoop && Game.hoop.rim;

    // 동적 레이어링: front(림 앞) / back(림 뒤)
    if (b && rim && Assets.ready.rim && Assets.rim){
      if (b.layer === 'back'){
        b.draw(ctx);
        ctx.drawImage(Assets.rim, rim.x, rim.y, rim.w, rim.h);
      } else {
        ctx.drawImage(Assets.rim, rim.x, rim.y, rim.w, rim.h);
        b.draw(ctx);
      }
    } else {
      if (rim && Assets.ready.rim && Assets.rim) ctx.drawImage(Assets.rim, rim.x, rim.y, rim.w, rim.h);
      if (b) b.draw(ctx);
    }

    Game.input && Game.input.drawAim(ctx);
  }

  function frame(t){
    if(!State.running) return;
    if(!State.lastRAF) State.lastRAF=t;
    let dt=(t-State.lastRAF)/1000; dt=Math.max(0,Math.min(dt,0.033));
    State.lastRAF=t;

    State.acc += dt;
    while(State.acc >= State.fixedDt){ update(State.fixedDt); State.acc -= State.fixedDt; }
    render();
    requestAnimationFrame(frame);
  }

  // =========================
  // Start / End
  // =========================
  function unlockAudioOnce(){
    if (SFX.unlocked) return;
    // 사용자 제스처 컨텍스트 안에서 시도
    try {
      if (SFX.bgm) {
        const p1 = SFX.bgm.play();
        if (p1 && typeof p1.then === 'function') {
          p1.then(()=>{ SFX.bgm.pause(); SFX.bgm.currentTime = 0; }).catch(()=>{});
        } else { SFX.bgm.pause(); SFX.bgm.currentTime = 0; }
      }
      if (SFX.goal) {
        const p2 = SFX.goal.play();
        if (p2 && typeof p2.then === 'function') {
          p2.then(()=>{ SFX.goal.pause(); SFX.goal.currentTime = 0; }).catch(()=>{});
        } else { SFX.goal.pause(); SFX.goal.currentTime = 0; }
      }
    } catch(_) {}
    SFX.unlocked = true;
  }

  function startGame(){
    overlay.classList.remove('visible');
    restartBtn.classList.remove('hidden');
    State.running=true;
    State.timeLeft=Config.roundSeconds; timerEl.textContent=String(Config.roundSeconds);
    State.score=0; scoreEl.textContent='0';
    State.lastRAF=0; State.acc=0;
    if(!Game.input) Game.input=new Input();
    placeBallOnFloor();

    // [MOD:SFX] 오디오 언락 + BGM 재생
    unlockAudioOnce();
    playBGM();

    requestAnimationFrame(frame);
  }

  function endGame(){
    State.running=false;
    restartBtn.classList.add('hidden');
    overlay.classList.add('visible');
    overlay.querySelector('h1').textContent='TIME UP!';
    overlay.querySelector('p').innerHTML=`득점: <strong>${State.score}</strong>개<br/>다시 도전해 보세요.`;

    // [MOD:SFX] 라운드 종료 시 BGM 잠시 멈춤(취향에 따라 유지해도 됨)
    stopBGM();
  }

  // =========================
  // Events / Init
  // =========================
  window.addEventListener('resize', resize);
  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);

  // 모바일/일부 브라우저: 오버레이가 보이면 캔버스 탭만으로도 시작 가능
  canvas.addEventListener('click', () => {
    if (!State.running && overlay.classList.contains('visible')) {
      startGame();
    }
  }, { passive:true });

  resize();
  overlay.classList.add('visi
