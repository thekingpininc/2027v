(() => {
  'use strict';

  const WORLD = { w: 1920, h: 1080 }; // 16:9 기준

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const timerEl = document.getElementById('timer');
  const toastEl = document.getElementById('toast');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restart');

  const Config = {
    roundSeconds: 10,
    assets: {
      background: (window.GAME_ASSETS && window.GAME_ASSETS.background) || null,
      backboard:  (window.GAME_ASSETS && window.GAME_ASSETS.backboard)  || null,
      rim:        (window.GAME_ASSETS && window.GAME_ASSETS.rim)        || null,
      ball:       (window.GAME_ASSETS && window.GAME_ASSETS.ball)       || null,
    },
    layout: {
      backboardW: 0.52,   // 백보드 화면 너비 비율(1920 기준)
      backboardTop: 0.12, // 백보드 상단 Y 비율
      // 림 PNG를 백보드 기준으로 정렬
      rimW: 0.24,         // 림 가로폭 (화면 너비 비율)
      rimOffsetX: 0.00,   // 백보드 중심에서 림 중심 X 오프셋(+우, -좌)
      rimY: 0.40          // 화면 높이 기준 림 중심 Y 비율 (빨간 바 중앙)
    },
    physics: {
      gravity: 2800,        // px/s^2
      air: 0.999,
      wallRest: 0.70,
      floorRest: 0.55,
      rimRest: 0.78,
      maxShotPower: 1850,   // 초기 속력 상한
      powerSwipe: 1100,
      powerDrag: 7.0,
      minUpVy: -60          // 위로 슛 인식 임계값(절댓값 작게 = 쉽게)
    },
    scoring: {
      lineOffset: 6,        // 빨간바 아래쪽으로 판정라인 내림(px, 월드좌표)
      expandX: 16           // 좌우로 판정폭 확장(px)
    },
    respawnDelayMs: 300
  };

  const State = {
    dpr: 1, scale: 1,
    running: false,
    timeLeft: Config.roundSeconds,
    score: 0,
    lastRAF: 0, acc: 0, fixedDt: 1/120,
    msgTimeout: 0
  };

  const Assets = {
    background: null, backboard: null, rim: null, ball: null,
    ready: { bg:false, bb:false, rim:false, ball:false }
  };
  function loadImage(path, on) {
    if (!path) return null;
    const img = new Image();
    img.src = path;
    img.onload = () => on(true);
    img.onerror = () => on(false);
    return img;
  }
  Assets.background = loadImage(Config.assets.background, ok => Assets.ready.bg   = ok);
  Assets.backboard  = loadImage(Config.assets.backboard,  ok => Assets.ready.bb   = ok);
  Assets.rim        = loadImage(Config.assets.rim,        ok => Assets.ready.rim  = ok);
  Assets.ball       = loadImage(Config.assets.ball,       ok => Assets.ready.ball = ok);

  const Game = {
    ball: null,
    hoop: null,
    input: null
  };

  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const now = ()=>performance.now();

  function resize() {
    State.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssH = window.innerHeight;              
    const scale = cssH / WORLD.h;                  
    const cssW = Math.round(WORLD.w * scale);

    canvas.width  = Math.round(WORLD.w * State.dpr);
    canvas.height = Math.round(WORLD.h * State.dpr);

    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';

    State.scale = scale;

    buildHoop();
    if (!Game.ball) spawnBall(); else placeBallOnFloor(); 
  }

  function buildHoop() {
    const cx = WORLD.w * 0.5;
    const bbW = WORLD.w * Config.layout.backboardW;
    const bbH = bbW * 0.75;
    const bbX = cx - bbW/2;
    const bbY = WORLD.h * Config.layout.backboardTop;

    const rimW = WORLD.w * Config.layout.rimW;
    const rimH = rimW * 0.45;
    const rimX = cx - rimW/2 + (bbW * Config.layout.rimOffsetX);
    const rimY = WORLD.h * Config.layout.rimY - rimH/2; // rim.png 중앙 기준

    const barY = rimY + rimH * 0.09;      
    const openLeft  = rimX + rimW * 0.09;  
    const openRight = rimX + rimW * 0.91;
    const rimNodeR  = (openRight - openLeft) * 0.03; 

    Game.hoop = {
      board: { x: bbX, y: bbY, w: bbW, h: bbH },
      rim:   { x: rimX, y: rimY, w: rimW, h: rimH, barY, openLeft, openRight, nodeR: rimNodeR },
      scoreY: barY + Config.scoring.lineOffset,
      scoreLeft: openLeft - Config.scoring.expandX,
      scoreRight: openRight + Config.scoring.expandX
    };
  }

  class Ball {
    constructor(x, y, r) {
      this.x=x; this.y=y; this.r=r;
      this.vx=0; this.vy=0;
      this.held=false; this.shot=false; this.resting=false;
      this.lastY=y; this.timeSinceShot=0; this.scored=false;
    }
    apply(dt) {
      if (this.held) return;
      this.vy += Config.physics.gravity * dt;
      this.vx *= Math.pow(Config.physics.air, dt*120);
      this.vy *= Math.pow(Config.physics.air, dt*120);

      this.x += this.vx*dt; this.y += this.vy*dt;

      if (this.x - this.r < 0) { this.x=this.r; this.vx=Math.abs(this.vx)*Config.physics.wallRest; }
      if (this.x + this.r > WORLD.w) { this.x=WORLD.w-this.r; this.vx=-Math.abs(this.vx)*Config.physics.wallRest; }

      if (this.y + this.r > WORLD.h) {
        this.y = WORLD.h - this.r;
        if (this.vy > 0) this.vy = -this.vy * Config.physics.floorRest;
        this.vx *= 0.985;
        if (Math.abs(this.vx) < 6 && Math.abs(this.vy) < 25) {
          this.resting = true; this.vx=0; this.vy=0;
        }
      }

      if (this.shot) this.timeSinceShot += dt;
    }
    draw(g) {
      g.save();
      g.shadowColor='rgba(0,0,0,.35)'; g.shadowBlur=12; g.shadowOffsetY=4;
      if (Assets.ready.ball && Assets.ball) {
        const d = this.r*2;
        g.drawImage(Assets.ball, this.x-this.r, this.y-this.r, d, d);
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
    const b = Game.ball; if (!b) return;
    b.x = WORLD.w * 0.5;
    b.y = WORLD.h * 0.86;
    b.vx = 0; b.vy = 0; b.held=false; b.shot=false; b.resting=false; b.scored=false; b.timeSinceShot=0;
  }

  function collideHoop(ball) {
    const {rim} = Game.hoop;
    const hitCapsule = (ax, ay, bx, by, r) => {
      const vx=bx-ax, vy=by-ay;
      const wx=ball.x-ax, wy=ball.y-ay;
      const vv=vx*vx+vy*vy || 1e-6;
      let t=(wx*vx+wy*vy)/vv; t=clamp(t,0,1);
      const cx=ax+t*vx, cy=ay+t*vy;
      const dx=ball.x-cx, dy=ball.y-cy;
      const dist=Math.hypot(dx,dy);
      const minDist=ball.r+r;
      if (dist<minDist){
        const nx=dx/(dist||1e-6), ny=dy/(dist||1e-6);
        const pen=minDist-dist;
        ball.x+=nx*pen; ball.y+=ny*pen;
        const vDot=ball.vx*nx+ball.vy*ny;
        ball.vx = ball.vx - (1+Config.physics.rimRest)*vDot*nx;
        ball.vy = ball.vy - (1+Config.physics.rimRest)*vDot*ny;
        ball.vx*=0.985; ball.vy*=0.985;
      }
    };
    const hitNode = (cx,cy,r)=>{
      const dx=ball.x-cx, dy=ball.y-cy, dist=Math.hypot(dx,dy), min=ball.r+r;
      if (dist<min){
        const nx=dx/(dist||1e-6), ny=dy/(dist||1e-6);
        const pen=min-dist; ball.x+=nx*pen; ball.y+=ny*pen;
        const vDot=ball.vx*nx+ball.vy*ny;
        ball.vx = ball.vx - (1+Config.physics.rimRest)*vDot*nx;
        ball.vy = ball.vy - (1+Config.physics.rimRest)*vDot*ny;
        ball.vx*=0.985; ball.vy*=0.985;
      }
    };

    hitCapsule(rim.openLeft, rim.barY, rim.openRight, rim.barY, rim.nodeR*0.7);
    hitNode(rim.openLeft, rim.barY, rim.nodeR);
    hitNode(rim.openRight, rim.barY, rim.nodeR);
  }

  function checkGoal(ball){
    if (ball.scored || !ball.shot) return false;
    const {scoreY, scoreLeft, scoreRight} = Game.hoop;
    const crossedDown = (ball.lastY < scoreY && ball.y >= scoreY);
    const inX = (ball.x > scoreLeft && ball.x < scoreRight);
    const goingDown = ball.vy > 0;
    if (crossedDown && inX && goingDown) {
      ball.scored = true;
      return true;
    }
    return false;
  }

  class Input {
    constructor(){
      this.active=false;
      this.sx=0; this.sy=0; this.x=0; this.y=0; this.samples=[];
      canvas.addEventListener('pointerdown', this.onDown, {passive:false});
      window.addEventListener('pointermove', this.onMove, {passive:false});
      window.addEventListener('pointerup',   this.onUp,   {passive:false});
    }
    toWorld(e){
      const rect=canvas.getBoundingClientRect();
      const cssX=(e.clientX-rect.left), cssY=(e.clientY-rect.top);
      const x= cssX / State.scale;
      const y= cssY / State.scale;
      return {x: clamp(x,0,WORLD.w), y: clamp(y,0,WORLD.h)};
    }
    withinBall(x,y){
      const b=Game.ball; if(!b) return false;
      return Math.hypot(x-b.x,y-b.y)<=b.r*1.15;
    }
    onDown = (e)=>{
      e.preventDefault();
      if(!State.running) return;
      const p=this.toWorld(e);
      if(this.withinBall(p.x,p.y)){
        this.active=true; this.sx=this.x=p.x; this.sy=this.y=p.y;
        this.samples.length=0; this.push(p.x,p.y);
        const b=Game.ball; b.held=true; b.resting=false;
      }
    }
    onMove = (e)=>{
      if(!this.active) return;
      const p=this.toWorld(e); this.x=p.x; this.y=p.y; this.push(p.x,p.y);
      const b=Game.ball; if(b && b.held){
        b.x=this.x; b.y=Math.min(Math.max(this.y, WORLD.h*0.2), WORLD.h - b.r);
      }
    }
    onUp = (e)=>{
      if(!this.active) return;
      this.active=false;
      const b=Game.ball; if(!(b && b.held)) return;

      const dragVX=(this.sx-this.x)*Config.physics.powerDrag;
      const dragVY=(this.sy-this.y)*Config.physics.powerDrag;
      let i=this.samples.length-1; const tLast=this.samples[i].t;
      while(i>0 && (tLast-this.samples[i-1].t)<120) i--;
      const vdx=this.samples[this.samples.length-1].x - this.samples[i].x;
      const vdy=this.samples[this.samples.length-1].y - this.samples[i].y;
      const dt=(this.samples[this.samples.length-1].t - this.samples[i].t)/1000 || 1/60;
      const swipeVX=-(vdx/dt)*(Config.physics.powerSwipe/1000);
      const swipeVY=-(vdy/dt)*(Config.physics.powerSwipe/1000);

      let vx=dragVX*0.2 + swipeVX*0.8;
      let vy=dragVY*0.2 + swipeVY*0.8;

      if (vy >= Config.physics.minUpVy) { vx=0; vy=0; }

      const spd=Math.hypot(vx,vy);
      if(spd>Config.physics.maxShotPower){
        const s=Config.physics.maxShotPower/(spd||1); vx*=s; vy*=s;
      }

      b.held=false; b.shot=true; b.vx=vx; b.vy=vy;
    }
    push(x,y){ this.samples.push({x,y,t:now()}); const cut=now()-180; while(this.samples.length&&this.samples[0].t<cut) this.samples.shift(); }
    drawAim(g){
      if(!this.active) return;
      g.save();
      g.strokeStyle='rgba(255,255,255,.8)'; g.lineWidth=2; g.setLineDash([6,6]);
      g.beginPath(); g.moveTo(this.sx,this.sy); g.lineTo(this.x,this.y); g.stroke();
      g.restore();
    }
  }

  function showToast(text, color='white'){
    toastEl.textContent=text; toastEl.style.color=color;
    toastEl.classList.add('show');
    clearTimeout(State.msgTimeout);
    State.msgTimeout = setTimeout(()=> toastEl.classList.remove('show'), 500);
  }

  function update(dt){
    if(State.running){
      State.timeLeft -= dt;
      if(State.timeLeft<=0){
        State.timeLeft=0;
        endGame();
      }
    }
    timerEl.textContent = String(Math.ceil(State.timeLeft));

    const b=Game.ball, h=Game.hoop && Game.hoop.rim;
    if(!b) return;

    b.lastY=b.y; b.apply(dt);

    if (b.shot) for(let i=0;i<2;i++) collideHoop(b);

    if (b.shot && checkGoal(b)) {
      State.score += 1; scoreEl.textContent=String(State.score);
      showToast('GOAL!', '#38ff9b');
      setTimeout(()=>{ placeBallOnFloor(); }, Config.respawnDelayMs);
      return;
    }

    if ((b.y - b.r > WORLD.h + 180) || (b.shot && b.resting && b.timeSinceShot>0.25)) {
      showToast('FAIL', '#ffd166');
      setTimeout(()=>{ placeBallOnFloor(); }, Config.respawnDelayMs);
    }
  }

  function render(){
    ctx.setTransform(State.dpr,0,0,State.dpr,0,0);
    ctx.clearRect(0,0,WORLD.w,WORLD.h);

    if (Assets.ready.bg && Assets.background) {
      ctx.drawImage(Assets.background, 0, 0, WORLD.w, WORLD.h);
    } else {
      const g=ctx.createLinearGradient(0,0,0,WORLD.h);
      g.addColorStop(0,'#143'); g.addColorStop(1,'#012');
      ctx.fillStyle=g; ctx.fillRect(0,0,WORLD.w,WORLD.h);
    }

    if (Game.hoop) {
      const {board, rim} = Game.hoop;
      if (Assets.ready.bb && Assets.backboard)
        ctx.drawImage(Assets.backboard, board.x, board.y, board.w, board.h);

      if (Assets.ready.rim && Assets.rim)
        ctx.drawImage(Assets.rim, rim.x, rim.y, rim.w, rim.h);

      // 개발가이드: 득점라인 보기 원하면 주석 해제
      // ctx.strokeStyle='rgba(255,0,0,.35)'; ctx.beginPath();
      // ctx.moveTo(Game.hoop.scoreLeft, Game.hoop.scoreY);
      // ctx.lineTo(Game.hoop.scoreRight, Game.hoop.scoreY); ctx.stroke();
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
    while(State.acc >= State.fixedDt){
      update(State.fixedDt);
      State.acc -= State.fixedDt;
    }
    render();
    requestAnimationFrame(frame);
  }

  function startGame(){
    overlay.classList.remove('visible');
    restartBtn.classList.remove('hidden');
    State.running=true;
    State.timeLeft=Config.roundSeconds;
    State.score=0; scoreEl.textContent='0'; timerEl.textContent=String(Config.roundSeconds);
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
    overlay.querySelector('p').innerHTML = `득점: <strong>${State.score}</strong>개<br/>다시 도전해 보세요.`;
  }

  window.addEventListener('resize', resize);
  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);

  resize();
  overlay.classList.add('visible');
})();
