(() => {
  'use strict';

  /* ============================
     고정 월드(16:9) + 상/하단 고정 피팅
  ============================ */
  const WORLD = { w: 1920, h: 1080 };

  // ---- DOM
  const canvas = document.getElementById('game');
  const ctx    = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const timerEl = document.getElementById('timer');
  const toastEl = document.getElementById('toast');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restart');

  // ---- Config (이 scene.png에 맞춘 기본값 포함)
  const Config = {
    roundSeconds: 10,

    // 하단 1/2에서만 플릭 시작 + 임계값
    input: {
      startZoneRatio: 0.5,
      minSwipeUpVy: -90,     // 위로 던졌다고 볼 최소 vy(절댓값 작을수록 쉬움)
      minSwipeSpeed: 550     // 최소 스와이프 평균 속도(px/s)
    },

    // 씬 + 림 + 공
    assets: {
      scene: (window.GAME_ASSETS && window.GAME_ASSETS.scene) || null,
      rim:   (window.GAME_ASSETS && window.GAME_ASSETS.rim)   || null,
      ball:  (window.GAME_ASSETS && window.GAME_ASSETS.ball)  || null,
    },

    // 씬(원본 이미지 좌표의 %) 기준 림 위치/크기 —— 본 scene.png용 추천값
    sceneLayout: {
      rimCxPct: 0.500,          // X: 씬 가로의 50% (중앙)
      rimCyPct: 0.458,          // Y: 씬 세로의 45.8% (빨간바 중앙)
      rimWidthPctOfWorld: 0.205 // 림 가로폭(월드 가로 대비)
    },

    // rim.png 내부 상대 위치(빨간바/오픈영역)
    rimImage: {
      barCenterRelY: 0.12,  // rim.png 상단 기준 빨간바 중심
      openLeftRel:   0.20,  // 골대 내부 좌/우 경계 (관대)
      openRightRel:  0.80
    },

    // 물리
    physics: {
      gravity: 2800, air: 0.999,
      wallRest: 0.70, floorRest: 0.55, rimRest: 0.78,
      powerSwipe: 1100, powerDrag: 7.0, maxShotPower: 1900
    },

    // 득점 판정(빨간바 바로 아래 가상선)
    scoring: {
      lineOffset: 6,  // 빨간바 중심에서 아래로
      expandX: 18     // 좌우 여유(관대)
    },

    // 리스폰
    respawnDelayMs: 220
  };

  // ---- State
  const State = {
    dpr: 1, scale: 1,
    running: false,
    timeLeft: Config.roundSeconds,
    score: 0,
    lastRAF: 0, acc: 0, fixedDt: 1/120,
    msgTimeout: 0,
    // 씬 커버 매핑
    sceneMap: { scale:1, dx:0, dy:0, iw:0, ih:0 }
  };

  // ---- Assets
  const Assets = {
    scene: null, rim: null, ball: null,
    ready: { scene:false, rim:false, ball:false },
    rimRatio: 0.45 // h/w (rim.png 로드 후 갱신)
  };
  function loadImage(path, on){ if(!path) return null; const img=new Image(); img.src=path; img.onload=()=>on(true,img); img.onerror=()=>on(false,img); return img; }

  Assets.scene = loadImage(Config.assets.scene, (ok,img)=>{
    Assets.ready.scene = ok;
    if (ok){ State.sceneMap.iw = img.naturalWidth; State.sceneMap.ih = img.naturalHeight; }
    resize(); // 씬 로드 후 매핑 갱신
  });
  Assets.rim   = loadImage(Config.assets.rim, (ok,img)=>{
    Assets.ready.rim = ok;
    if (ok && img.naturalWidth) Assets.rimRatio = img.naturalHeight / img.naturalWidth;
    buildHoop(); render();
  });
  Assets.ball  = loadImage(Config.assets.ball, ok=>{ Assets.ready.ball = ok; });

  // ---- Game objects
  const Game = { hoop:null, ball:null, input:null };

  // ---- Utils
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const now = ()=>performance.now();

  // 씬 이미지를 월드에 'cover'로 매핑
  function computeSceneMap(){
    const iw = State.sceneMap.iw || 1920, ih = State.sceneMap.ih || 1080;
    const s  = Math.max(WORLD.w/iw, WORLD.h/ih);
    const dw = iw*s, dh = ih*s;
    State.sceneMap.scale = s;
    State.sceneMap.dx = (WORLD.w - dw) / 2;
    State.sceneMap.dy = (WORLD.h - dh) / 2;
  }
  // 씬 원본 픽셀(u,v) → 월드(x,y)
  function sceneUVtoWorld(u,v){
    const M = State.sceneMap; return { x: M.dx + u*M.scale, y: M.dy + v*M.scale };
  }

  // ---- Resize / Layout
  function resize(){
    State.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssH = window.innerHeight;                 // 상/하단 고정
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
    // 씬 기준 림 중심 좌표
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

  // ---- Ball
  class Ball{
    constructor(x,y,r){ this.x=x; this.y=y; this.r=r; this.vx=0; this.vy=0;
      this.held=false; this.shot=false; this.resting=false; this.lastY=y; this.timeSinceShot=0; this.scored=false; }
    apply(dt){
      if(this.held) return;
      this.vy += Config.physics.gravity * dt;
      this.vx *= Math.pow(Config.physics.air, dt*120);
      this.vy *= Math.pow(Config.physics.air, dt*120);
      this.x  += this.vx * dt;
      this.y  += this.vy * dt;

      if (this.x - this.r < 0){ this.x=this.r; this.vx=Math.abs(this.vx)*Config.physics.wallRest; }
      if (this.x + this.r > WORLD.w){ this.x=WORLD.w-this.r; this.vx=-Math.abs(this.vx)*Config.physics.wallRest; }

      if (this.y + this.r > WORLD.h){
        this.y = WORLD.h - this.r;
        if (this.vy > 0) this.vy = -this.vy * Config.physics.floorRest;
        this.vx *= 0.985;
        if (Math.abs(this.vx)<6 && Math.abs(this.vy)<25){ this.resting=true; this.vx=0; this.vy=0; }
      }
      if (this.shot) this.timeSinceShot += dt;
    }
    draw(g){
      g.save(); g.shadowColor='rgba(0,0,0,.35)'; g.shadowBlur=12; g.shadowOffsetY=4;
      if (Assets.ready.ball && Assets.ball){ const d=this.r*2; g.drawImage(Assets.ball, this.x-this.r, this.y-this.r, d, d); }
      else { g.beginPath(); g.arc(this.x,this.y,this.r,0,Math.PI*2); g.fillStyle='#f2a23a'; g.fill(); g.lineWidth=2; g.strokeStyle='#cc7d11'; g.stroke(); }
      g.restore();
    }
  }

  function spawnBall(){
    const r = Math.max(28, WORLD.h/22);
    Game.ball = new Ball(WORLD.w*0.5, WORLD.h*0.86, r);
  }
  function placeBallOnFloor(){
    const b=Game.ball; if(!b) return;
    b.x=WORLD.w*0.5; b.y=WORLD.h*0.86; b.vx=b.vy=0; b.held=false; b.shot=false; b.resting=false; b.scored=false; b.timeSinceShot=0;
  }

  // ---- Collision(원웨이) & scoring
  function collideHoop(ball){
    const rim = Game.hoop.rim;
    const inGoalX = (ball.x > Game.hoop.scoreLeft && ball.x < Game.hoop.scoreRight);
    // 득점 구간 + 아래로 통과 중일 때는 바 충돌을 비활성화(원웨이 패스)
    const shouldCollideBar = (ball.vy < 0) || !inGoalX;

    if (shouldCollideBar){
      const ax=rim.openLeft, ay=rim.barY, bx=rim.openRight, by=rim.barY;
      const r = rim.nodeR*0.55;
      const vx=bx-ax, vy=by-ay, wx=ball.x-ax, wy=ball.y-ay;
      const vv=vx*vx+vy*vy || 1e-6; let t=(wx*vx+wy*vy)/vv; t=clamp(t,0,1);
      const cx=ax+t*vx, cy=ay+t*vy;
      const dx=ball.x-cx, dy=ball.y-cy; const dist=Math.hypot(dx,dy), min=ball.r+r;
      if(dist<min){
        const nx=dx/(dist||1e-6), ny=dy/(dist||1e-6); const pen=min-dist;
        ball.x+=nx*pen; ball.y+=ny*pen;
        const vDot=ball.vx*nx+ball.vy*ny;
        ball.vx = ball.vx - (1+Config.physics.rimRest)*vDot*nx;
        ball.vy = ball.vy - (1+Config.physics.rimRest)*vDot*ny;
        ball.vx*=0.985; ball.vy*=0.985;
      }
    }
    // 양 끝 노드
    const hitNode=(cx,cy,rn)=>{
      const dx=ball.x-cx, dy=ball.y-cy; const dist=Math.hypot(dx,dy), min=ball.r+rn;
      if(dist<min){ const nx=dx/(dist||1e-6), ny=dy/(dist||1e-6), pen=min-dist;
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
    const inX = (ball.x > scoreLeft && ball.x < scoreRight);
    const goingDown = ball.vy > 0;
    if (crossedDown && inX && goingDown){ ball.scored=true; return true; }
    return false;
  }

  // ---- Input (하단 1/2 시작 + 림 위로 드래그 금지)
  class Input{
    constructor(){ this.active=false; this.sx=0; this.sy=0; this.x=0; this.y=0; this.samples=[];
      canvas.addEventListener('pointerdown', this.onDown, {passive:false});
      window.addEventListener('pointermove', this.onMove, {passive:false});
      window.addEventListener('pointerup',   this.onUp,   {passive:false});
    }
    toWorld(e){ const r=canvas.getBoundingClientRect(); const x=clamp((e.clientX-r.left)/State.scale,0,WORLD.w);
                const y=clamp((e.clientY-r.top )/State.scale,0,WORLD.h); return {x,y}; }
    withinBall(x,y){ const b=Game.ball; if(!b) return false; return Math.hypot(x-b.x,y-b.y) <= b.r*1.15; }

    onDown=(e)=>{ e.preventDefault(); if(!State.running) return;
      const p=this.toWorld(e);
      if (p.y < WORLD.h * (1 - Config.input.startZoneRatio)) return; // 하단 1/2에서만 시작
      if (this.withinBall(p.x,p.y)){
        this.active=true; this.sx=this.x=p.x; this.sy=this.y=p.y; this.samples.length=0; this.push(p.x,p.y);
        const b=Game.ball; b.held=true; b.resting=false;
      }
    }

    onMove=(e)=>{ if(!this.active) return; const p=this.toWorld(e); this.x=p.x; this.y=p.y; this.push(p.x,p.y);
      const b=Game.ball; if(b && b.held){
        b.x = this.x;
        // 림 빨간바보다 위로는 절대 올릴 수 없게 (플릭 조준 난이도 안정화)
        const minY = Math.max(WORLD.h*0.5, Game.hoop.rim.barY + b.r + 12);
        b.y = clamp(this.y, minY, WORLD.h - b.r);
      } }

    onUp=(e)=>{ if(!this.active) return; this.active=false; const b=Game.ball; if(!(b && b.held)) return;
      // 최근 120ms 스와이프
      let i=this.samples.length-1; const tLast=this.samples[i].t; while(i>0 && (tLast-this.samples[i-1].t)<120) i--;
      const vdx=this.samples[this.samples.length-1].x - this.samples[i].x;
      const vdy=this.samples[this.samples.length-1].y - this.samples[i].y;
      const dt=(this.samples[this.samples.length-1].t - this.samples[i].t)/1000 || 1/60;
      const speed=Math.hypot(vdx,vdy)/(dt||1e-6);

      const dragVX=(this.sx-this.x)*Config.physics.powerDrag;
      const dragVY=(this.sy-this.y)*Config.physics.powerDrag;
      const swipeVX=-(vdx/dt)*(Config.physics.powerSwipe/1000);
      const swipeVY=-(vdy/dt)*(Config.physics.powerSwipe/1000);

      let vx=dragVX*0.2 + swipeVX*0.8;
      let vy=dragVY*0.2 + swipeVY*0.8;

      // 위로 던진 제스처 + 최소 속도 조건
      if (vy >= Config.input.minSwipeUpVy || speed < Config.input.minSwipeSpeed){ vx=0; vy=0; }

      const spd=Math.hypot(vx,vy); if (spd > Config.physics.maxShotPower){ const s=Config.physics.maxShotPower/(spd||1); vx*=s; vy*=s; }
      b.held=false; b.shot=true; b.vx=vx; b.vy=vy;
    }

    push(x,y){ this.samples.push({x,y,t:now()}); const cut=now()-180; while(this.samples.length && this.samples[0].t<cut) this.samples.shift(); }
    drawAim(g){ if(!this.active) return; g.save(); g.strokeStyle='rgba(255,255,255,.8)'; g.lineWidth=2; g.setLineDash([6,6]);
      g.beginPath(); g.moveTo(this.sx,this.sy); g.lineTo(this.x,this.y); g.stroke(); g.restore(); }
  }

  // ---- Toast
  function showToast(text,color='white'){ if(!toastEl) return; toastEl.textContent=text; toastEl.style.color=color;
    toastEl.classList.add('show'); clearTimeout(State.msgTimeout); State.msgTimeout=setTimeout(()=>toastEl.classList.remove('show'),500); }

  // ---- Game loop
  function update(dt){
    if(State.running){ State.timeLeft -= dt; if(State.timeLeft<=0){ State.timeLeft=0; endGame(); } }
    timerEl.textContent = String(Math.ceil(State.timeLeft));

    const b=Game.ball; if(!b) return;
    b.lastY=b.y; b.apply(dt);

    // 득점 먼저 판정 → 그 다음 충돌(원웨이)
    if (b.shot && checkGoal(b)){
      State.score += 1; scoreEl.textContent=String(State.score);
      showToast('GOAL!', '#38ff9b'); setTimeout(()=>placeBallOnFloor(), Config.respawnDelayMs); return;
    }
    if (b.shot) collideHoop(b);

    // 실패(크게 이탈 or 충분히 멈춤)
    if ((b.y - b.r > WORLD.h + 140) || (b.shot && b.resting && b.timeSinceShot>0.25)){
      showToast('FAIL', '#ffd166'); setTimeout(()=>placeBallOnFloor(), Config.respawnDelayMs);
    }
  }

  // 씬을 cover로 그리기(비율 유지 + 필요시 자르기)
  function drawSceneCover(){
    if (!(Assets.ready.scene && Assets.scene)){
      const g=ctx.createLinearGradient(0,0,0,WORLD.h); g.addColorStop(0,'#163d6b'); g.addColorStop(1,'#0c1220');
      ctx.fillStyle=g; ctx.fillRect(0,0,WORLD.w,WORLD.h); return;
    }
    const img=Assets.scene;
    const iw=img.naturalWidth || 1920, ih=img.naturalHeight || 1080;
    const s=Math.max(WORLD.w/iw, WORLD.h/ih);
    const dw=iw*s, dh=ih*s;
    const dx=(WORLD.w-dw)/2, dy=(WORLD.h-dh)/2;
    // 매핑 기록(림 좌표 변환 용)
    State.sceneMap.scale=s; State.sceneMap.dx=dx; State.sceneMap.dy=dy; State.sceneMap.iw=iw; State.sceneMap.ih=ih;

    ctx.save(); ctx.beginPath(); ctx.rect(0,0,WORLD.w,WORLD.h); ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  function render(){
    ctx.setTransform(State.dpr,0,0,State.dpr,0,0);
    ctx.clearRect(0,0,WORLD.w,WORLD.h);

    drawSceneCover();

    // 림(씬 위에 그려짐)
    if (Game.hoop && Assets.ready.rim && Assets.rim){
      const r = Game.hoop.rim;
      ctx.drawImage(Assets.rim, r.x, r.y, r.w, r.h);

      // 디버그 가이드 — 필요시 주석 해제
      // ctx.strokeStyle='rgba(255,0,0,.35)';
      // ctx.beginPath(); ctx.moveTo(Game.hoop.scoreLeft, Game.hoop.scoreY); ctx.lineTo(Game.hoop.scoreRight, Game.hoop.scoreY); ctx.stroke();
    }

    Game.input && Game.input.drawAim(ctx);
    Game.ball && Game.ball.draw(ctx);
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

  // ---- Start/End
  function startGame(){
    overlay.classList.remove('visible'); restartBtn.classList.remove('hidden');
    State.running=true; State.timeLeft=Config.roundSeconds; timerEl.textContent=String(Config.roundSeconds);
    State.score=0; scoreEl.textContent='0'; State.lastRAF=0; State.acc=0;
    if(!Game.input) Game.input=new Input();
    placeBallOnFloor();
    requestAnimationFrame(frame);
  }
  function endGame(){
    State.running=false; restartBtn.classList.add('hidden'); overlay.classList.add('visible');
    overlay.querySelector('h1').textContent='TIME UP!';
    overlay.querySelector('p').innerHTML=`득점: <strong>${State.score}</strong>개<br/>다시 도전해 보세요.`;
  }

  // ---- Calib Mode(현장 미세조정): C 토글 / ←→↑↓ 위치 / A,D 크기 / [,] 오픈폭
  let CAL = { on:false };
  window.addEventListener('keydown', (e)=>{
    if (e.key.toLowerCase() === 'c') { CAL.on = !CAL.on; showToast(CAL.on?'CAL ON':'CAL OFF', '#ffd166'); render(); }
    if (!CAL.on) return;
    const step = e.shiftKey ? 0.001 : 0.002;

    if (e.key === 'ArrowLeft')  Config.sceneLayout.rimCxPct -= step;
    if (e.key === 'ArrowRight') Config.sceneLayout.rimCxPct += step;
    if (e.key === 'ArrowUp')    Config.sceneLayout.rimCyPct -= step;
    if (e.key === 'ArrowDown')  Config.sceneLayout.rimCyPct += step;

    if (e.key.toLowerCase() === 'a') Config.sceneLayout.rimWidthPctOfWorld -= step*0.8;
    if (e.key.toLowerCase() === 'd') Config.sceneLayout.rimWidthPctOfWorld += step*0.8;

    if (e.key === '[') { Config.rimImage.openLeftRel -= step;  Config.rimImage.openRightRel += step; }
    if (e.key === ']') { Config.rimImage.openLeftRel += step;  Config.rimImage.openRightRel -= step; }

    buildHoop(); render();

    if (e.key.toLowerCase() === 's'){ // S: 현재값 콘솔에 출력(복사해서 고정)
      console.log(JSON.stringify({sceneLayout:Config.sceneLayout, rimImage:Config.rimImage}, null, 2));
    }
  });

  // ---- Events / Init
  window.addEventListener('resize', resize);
  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);
  resize();
  overlay.classList.add('visible');
})();
