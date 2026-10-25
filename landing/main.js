/* ============================================================
   共鸣：闻声对决 · 落地页交互与动效
   依赖：GSAP 3 + ScrollTrigger（本地 vendor 副本）、可选 Lenis 平滑滚动
   四类动效：
     1) 一镜到底 —— 首屏入场、产品片在首屏直接播放
     2) 多层视差 —— data-parallax 的装饰与卡片
     3) 定格叙事 —— 玩法段落 pin 住，滚动推进四个节拍
     4) 手动翻面 —— 结构段落里点按钮或点机身翻面，指示线与零件高亮联动
   没有 GSAP 时页面保持静态可读：初始隐藏状态全部在 JS 里设置。
   ============================================================ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGsap = typeof window.gsap !== 'undefined';
  var hasST = hasGsap && typeof window.ScrollTrigger !== 'undefined';
  if (hasST) gsap.registerPlugin(ScrollTrigger);

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ============================================================
     伙伴的脸：一份 SVG，按 data-state 切换五官
     眼形、嘴形与比例取自手机端原型（docs/product/prototypes），
     比贴图更清晰，也能做出眨眼、闪避拖影这类细微动作。
     ============================================================ */
  function faceMarkup() {
    return [
      '<svg class="face" data-state="idle" viewBox="0 0 200 140" role="img" aria-label="伙伴的表情">',
      '<g class="f-part f-eyes-open"><ellipse class="fill" cx="65" cy="55" rx="12" ry="16"/><ellipse class="fill" cx="135" cy="55" rx="12" ry="16"/></g>',
      '<g class="f-part f-eyes-happy"><path class="line" d="M53 57q12-28 24 0M123 57q12-28 24 0"/></g>',
      '<g class="f-part f-eyes-impact"><path class="line" d="m55 43 20 24m0-24-20 24m70-24 20 24m0-24-20 24"/></g>',
      '<g class="f-part f-eyes-low"><path class="line" d="M53 52q12 13 24 0M123 52q12 13 24 0"/><path class="line line--thin" d="M56 66h18M126 66h18"/></g>',
      '<g class="f-part f-brows-ready"><path class="line line--thin" d="M50 31 82 39M150 31 118 39"/></g>',
      '<g class="f-part f-brows-angry"><path class="line line--thin" d="M52 26 84 42M148 26 116 42"/></g>',
      '<g class="f-part f-cheeks"><ellipse cx="41" cy="79" rx="10" ry="5" fill="#d8a184" opacity=".8"/><ellipse cx="159" cy="79" rx="10" ry="5" fill="#d8a184" opacity=".8"/></g>',
      '<g class="f-part f-echo"><ellipse class="fill" cx="44" cy="55" rx="12" ry="16"/><ellipse class="fill" cx="114" cy="55" rx="12" ry="16"/><ellipse class="fill" cx="86" cy="55" rx="12" ry="16"/><ellipse class="fill" cx="156" cy="55" rx="12" ry="16"/></g>',
      '<g class="f-mouth" transform="translate(100 87)">',
      '<path class="f-mouth-set f-mouth-neutral line" d="M-18-5Q0 15 18-5"/>',
      '<path class="f-mouth-set f-mouth-listen line" d="M-12 0h24"/>',
      '<path class="f-mouth-set f-mouth-cheer line" d="M-18-14Q0-8 18-14Q19 16 0 16T-18-14Z"/>',
      '<g class="f-mouth-set f-mouth-shock"><ellipse class="fill" cx="0" cy="-2" rx="10" ry="15"/><ellipse cx="0" cy="2" rx="5" ry="8" fill="#183f37"/></g>',
      '<path class="f-mouth-set f-mouth-low line" d="M-18 6Q0-14 18 6"/>',
      '</g>',
      '<g class="f-part f-shield">',
      '<path d="m110 44 38 14v24q0 17-38 34-38-17-38-34V58Z" fill="#b6d4db" stroke="#254d3c" stroke-width="4" stroke-linejoin="round"/>',
      '<path d="m110 52 30 11v19q0 12-30 25Z" fill="#709ca8"/>',
      '<path d="m80 64 30-12 30 12" fill="none" stroke="#eff6df" stroke-width="3" stroke-linejoin="round"/>',
      '<ellipse cx="72" cy="84" rx="9" ry="11" fill="#d9f8b7" stroke="#254d3c" stroke-width="4"/>',
      '<ellipse cx="148" cy="84" rx="9" ry="11" fill="#d9f8b7" stroke="#254d3c" stroke-width="4"/>',
      '</g>',
      '</svg>'
    ].join('');
  }

  // 挂载：每个 [data-face] 容器注入同一份 SVG，状态写在 svg 的 data-state 上
  function mountFaces() {
    $$('[data-face]').forEach(function (el) {
      if ($('.face', el)) return;
      el.innerHTML = faceMarkup();
      setFace(el, el.getAttribute('data-face') || 'idle');
    });
  }

  function setFace(holder, name) {
    var svg = holder && $('.face', holder);
    if (!svg) return;
    if (svg.getAttribute('data-state') === name) return;
    svg.setAttribute('data-state', name);
    holder.setAttribute('data-face', name);
  }

  /* ============================================================
     平滑滚动
     ============================================================ */
  var lenis = null;
  if (!reduceMotion && typeof window.Lenis !== 'undefined' && hasST) {
    lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 1, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
  }

  function scrollToY(y) {
    if (lenis) lenis.scrollTo(y, { duration: 0.9 });
    else window.scrollTo({ top: y, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var target = $(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    var y = target.getBoundingClientRect().top + window.pageYOffset - 66;
    scrollToY(y);
  });

  /* ============================================================
     一屏一屏地走：滚动停下后吸附到最近的整屏边界
     内容超出一屏的段落只在贴近边界时吸附，允许在段内滚动
     ============================================================ */
  var snapPoints = [];
  var snapping = false;
  var playPinST = null;                       // 玩法段落的 pin，节拍点是它的吸附位

  function collectSnapPoints() {
    snapPoints = [];
    var vh = window.innerHeight;
    var maxY = document.documentElement.scrollHeight - vh;
    $$('.scene').forEach(function (sec) {
      var y = Math.round(sec.getBoundingClientRect().top + window.pageYOffset);
      // 玩法段落被 pin 撑开，用下面的节拍点接管，不再整体吸附
      if (playPinST && Math.abs(y - playPinST.start) < 120) return;
      // 一屏从上沿对齐；内容比一屏高时，下沿对齐也是一个停靠位，
      // 这样任何位置都能整屏落定，不会停在两屏之间的过渡带上
      snapPoints.push({ y: Math.min(y, maxY), threshold: vh * 0.5 });
      if (sec.offsetHeight > vh + 8) {
        var bottomY = Math.min(maxY, y + sec.offsetHeight - vh);
        if (bottomY > y + 48) snapPoints.push({ y: bottomY, threshold: vh * 0.5 });
      }
    });
    if (playPinST) {
      var span = Math.max(0, playPinST.end - playPinST.start - 64);
      for (var k = 0; k <= 3; k++) {
        snapPoints.push({
          y: Math.round(playPinST.start + 64 + span * k / 3),
          threshold: vh * 0.3
        });
      }
    }
    snapPoints.sort(function (a, b) { return a.y - b.y; });
  }

  function settleSnap() {
    if (reduceMotion || snapping || !snapPoints.length) return;
    var vh = window.innerHeight;
    if (vh < 560) return;                       // 视口太矮时放宽限制
    var y = window.pageYOffset;
    var max = document.documentElement.scrollHeight - vh;
    if (y >= max - 4) return;                   // 已经在底部
    var best = null;
    for (var i = 0; i < snapPoints.length; i++) {
      var p = snapPoints[i];
      var d = Math.abs(p.y - y);
      if (d < p.threshold && (!best || d < best.d)) best = { d: d, y: p.y };
    }
    if (!best || best.d < 14) return;
    snapping = true;
    if (lenis) {
      lenis.scrollTo(best.y, {
        duration: 0.85,
        onComplete: function () { snapping = false; }
      });
    } else {
      window.scrollTo({ top: best.y, behavior: 'smooth' });
      setTimeout(function () { snapping = false; }, 900);
    }
  }

  var settleTimer = null;
  window.addEventListener('scroll', function () {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settleSnap, 170);
  }, { passive: true });

  /* ============================================================
     导航与进度
     ============================================================ */
  var nav = $('[data-nav]');
  var progressBar = $('[data-progress]');

  if (hasST) {
    ScrollTrigger.create({
      start: 'top -40',
      end: 'max',
      onToggle: function (self) { nav.classList.toggle('is-stuck', self.isActive); }
    });

    ScrollTrigger.create({
      start: 0,
      end: 'max',
      onUpdate: function (self) { gsap.set(progressBar, { scaleX: self.progress }); }
    });

    // 单一来源的段落高亮：取中线以上最后一个段落，避免相邻段落同时点亮
    var navIds = ['problem', 'play', 'arch', 'listen', 'fair', 'grow'];
    var navLinks = navIds.map(function (id) { return $('.nav__links a[href="#' + id + '"]'); });
    var navSecs = navIds.map(function (id) { return document.getElementById(id); });
    var navTick = { v: -1 };

    function syncNav() {
      var mid = window.pageYOffset + window.innerHeight * 0.45;
      var idx = -1;
      navSecs.forEach(function (sec, i) {
        if (!sec) return;
        if (sec.getBoundingClientRect().top + window.pageYOffset <= mid) idx = i;
      });
      if (idx === navTick.v) return;
      navTick.v = idx;
      navLinks.forEach(function (a, i) { if (a) a.classList.toggle('is-active', i === idx); });
    }

    if (hasST) {
      ScrollTrigger.create({ start: 0, end: 'max', onUpdate: syncNav });
    }
    window.addEventListener('scroll', syncNav, { passive: true });
    syncNav();
  }

  /* ============================================================
     入场与视差
     ============================================================ */
  if (hasST && !reduceMotion) {
    var heroTl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    heroTl
      .from('.hero__copy .kicker', { y: 14, opacity: 0, duration: 0.7 })
      .from('.display .line', { y: 46, opacity: 0, duration: 0.95, stagger: 0.09 }, '-=0.5')
      .from('.hero__copy .lede', { y: 18, opacity: 0, duration: 0.8 }, '-=0.55')
      .from('.hero__actions > *', { y: 14, opacity: 0, duration: 0.6, stagger: 0.08 }, '-=0.4')
      .from('.film', { y: 38, opacity: 0, duration: 1.05 }, '-=0.95');

    var isWide = window.matchMedia('(min-width: 881px)').matches;
    if (isWide) {
      gsap.to('.film', {
        yPercent: 8, scale: 0.97, ease: 'none',
        scrollTrigger: { trigger: '.scene--hero', start: 'center top', end: 'bottom top', scrub: true }
      });
      gsap.to('.hero__copy', {
        yPercent: -12, opacity: 0.3, ease: 'none',
        scrollTrigger: { trigger: '.scene--hero', start: 'top top', end: 'bottom top', scrub: true }
      });
    }

    $$('[data-parallax]').forEach(function (el) {
      var k = parseFloat(el.getAttribute('data-parallax')) || -0.05;
      gsap.to(el, {
        yPercent: k * 100,
        ease: 'none',
        scrollTrigger: {
          trigger: el.closest('.scene') || el,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true
        }
      });
    });

    $$('[data-reveal]').forEach(function (el) { gsap.set(el, { y: 26, opacity: 0 }); });
    ScrollTrigger.batch('[data-reveal]', {
      start: 'top 90%',
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, { y: 0, opacity: 1, duration: 0.85, stagger: 0.08, ease: 'power2.out' });
      }
    });

    var statement = $('.statement');
    if (statement) {
      gsap.set(statement, { '--u': 0 });
      ScrollTrigger.create({
        trigger: statement,
        start: 'top 78%',
        once: true,
        onEnter: function () { gsap.to(statement, { '--u': 1, duration: 0.9, ease: 'power2.out' }); }
      });
    }
  }

  /* ============================================================
     玩法：定格叙事（四个节拍）
     数值全部来自规则：先手 14 / 后手 18，普攻 3，闪避免伤，第 3 轮起 +2
     ============================================================ */
  var arena = $('[data-arena]');
  if (arena) {
    var stageDevices = $$('.device--arena', arena);
    var youDev = stageDevices[0];
    var foeDev = stageDevices[1];
    var bubble = $('[data-arena-bubble]', arena);
    var spark = $('[data-spark]', arena);
    var hpYouBar = $('[data-hp-you]', arena);
    var hpYouNum = $('[data-hp-you-num]', arena);
    var hpFoeBar = $('[data-hp-foe]', arena);
    var hpFoeNum = $('[data-hp-foe-num]', arena);
    var roundNum = $('[data-round]', arena);
    var beats = $$('[data-beats] li', arena);

    var STEPS = [
      { round: 1, hpYou: 14, hpFoe: 18, you: 'idle', foe: 'idle', text: '轮到你出手了。普攻 1 点能量，强攻 2 点——怎么打？' },
      { round: 1, hpYou: 14, hpFoe: 15, you: 'attack', foe: 'hurt', text: '普攻命中，对手掉 3 点生命值。' },
      { round: 2, hpYou: 14, hpFoe: 15, you: 'dodge', foe: 'attack', text: '对手强攻过来，我闪避——这一下完全不疼。' },
      { round: 5, hpYou: 14, hpFoe: 0, you: 'victory', foe: 'defeat', text: '拖到第 5 轮，能量吃满一套带走——胜负由规则算出来，不是模型说了算。' }
    ];

    var currentBeat = -1;
    function setBeat(i, animate) {
      if (i === currentBeat) return;
      currentBeat = i;
      var s = STEPS[i];

      hpYouBar.style.width = (s.hpYou / 14) * 100 + '%';
      hpFoeBar.style.width = (s.hpFoe / 18) * 100 + '%';
      hpYouNum.textContent = s.hpYou;
      hpFoeNum.textContent = s.hpFoe;
      roundNum.textContent = s.round;

      setFace($('[data-face]', youDev), s.you);
      setFace($('[data-face]', foeDev), s.foe);
      beats.forEach(function (li, idx) { li.classList.toggle('is-active', idx === i); });

      if (bubble.textContent !== s.text) {
        if (animate && hasGsap) {
          gsap.fromTo(bubble, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' });
          bubble.textContent = s.text;
        } else {
          bubble.textContent = s.text;
          bubble.style.opacity = 1;
        }
      }

      if (i === 1 && animate && hasGsap) {
        gsap.fromTo(spark, { opacity: 1, scale: 0.6 }, { opacity: 0, scale: 3.4, duration: 0.8, ease: 'power2.out' });
        gsap.fromTo(youDev, { y: -14 }, { y: 0, duration: 0.6, ease: 'bounce.out' });
        gsap.fromTo(foeDev, { x: 0 }, { x: 10, duration: 0.08, repeat: 4, yoyo: true });
      }
    }
    setBeat(0, false);

    if (hasST && !reduceMotion) {
      gsap.matchMedia().add('(min-width: 881px)', function () {
        var pinEl = $('[data-play-pin]');
        playPinST = ScrollTrigger.create({
          trigger: pinEl,
          start: 'top 64px',
          end: function () { return '+=' + Math.round(window.innerHeight * 2.2); },
          pin: true,
          anticipatePin: 1,
          scrub: true,
          onUpdate: function (self) {
            var idx = Math.min(STEPS.length - 1, Math.floor(self.progress * STEPS.length * 1.02));
            setBeat(idx, true);
          }
        });
      });
      gsap.matchMedia().add('(max-width: 880px)', function () {
        ScrollTrigger.create({
          trigger: arena,
          start: 'top 60%',
          end: 'bottom 40%',
          onUpdate: function (self) {
            var idx = Math.min(STEPS.length - 1, Math.floor(self.progress * STEPS.length * 1.02));
            setBeat(idx, false);
          }
        });
      });
    }
  }

  /* ============================================================
     结构：手动翻面（点按钮或点机身），指示线与零件高亮联动
     ============================================================ */
  var hw = $('[data-hw]');
  if (hw) {
    var hwDevice = $('[data-hw-device]', hw);
    var hwAnnos = $$('[data-part]', hw);
    var hwParts = $$('[data-hwpart]', hw);
    var viewBtns = $$('[data-view]', hw);
    var hwFace = 'front';
    var annoTimer = null;

    function showAnnos(which) {
      hwAnnos.forEach(function (el, i) {
        var mine = el.getAttribute('data-side') === which;
        if (!mine) { el.classList.remove('is-on'); return; }
        // 错开一点，像排队亮起来
        setTimeout(function () { el.classList.add('is-on'); }, reduceMotion ? 0 : i * 70);
      });
    }

    function setFace(next) {
      if (next === hwFace) return;
      hwFace = next;
      hwDevice.style.setProperty('--flip', next === 'back' ? '180deg' : '0deg');
      viewBtns.forEach(function (b) {
        var on = b.getAttribute('data-view') === next;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      hwAnnos.forEach(function (el) { el.classList.remove('is-on'); });
      clearTimeout(annoTimer);
      // 等转到一半再换标注，避免两面文字叠在一起
      annoTimer = setTimeout(function () { showAnnos(next); }, reduceMotion ? 0 : 360);
    }

    viewBtns.forEach(function (b) {
      b.addEventListener('click', function () { setFace(b.getAttribute('data-view')); });
    });

    function toggleFace() { setFace(hwFace === 'front' ? 'back' : 'front'); }
    hwDevice.setAttribute('role', 'button');
    hwDevice.setAttribute('tabindex', '0');
    hwDevice.setAttribute('aria-label', '翻转设备，查看正面或背面的部件');
    hwDevice.addEventListener('click', toggleFace);
    hwDevice.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFace(); }
    });

    // 停在标注上时，对应的零件亮一下
    hwAnnos.forEach(function (el) {
      var key = el.getAttribute('data-part');
      var targets = hwParts.filter(function (p) { return p.getAttribute('data-hwpart') === key; });
      function lit(on) {
        targets.forEach(function (t) { t.classList.toggle('is-lit', on); });
      }
      el.addEventListener('mouseenter', function () { lit(true); });
      el.addEventListener('mouseleave', function () { lit(false); });
      el.addEventListener('focusin', function () { lit(true); });
      el.addEventListener('focusout', function () { lit(false); });
    });

    // 指示灯图例：悬停预览三种颜色，机身那条灯跟着换
    var hwStage = hw.querySelector('.hw__stage');
    $$('[data-led]', hw).forEach(function (item) {
      var state = item.getAttribute('data-led');
      function preview(on) {
        if (!hwStage) return;
        hwStage.classList.toggle('is-led-low', !!on && state === 'low');
        hwStage.classList.toggle('is-led-ult', !!on && state === 'ult');
      }
      item.addEventListener('mouseenter', function () { preview(true); });
      item.addEventListener('mouseleave', function () { preview(false); });
      item.addEventListener('focusin', function () { preview(true); });
      item.addEventListener('focusout', function () { preview(false); });
    });

    // 进入视野时亮当前面的标注（用 IntersectionObserver，跳锚点也能触发）
    if ('IntersectionObserver' in window) {
      var hwIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          showAnnos(hwFace);
          hwIO.disconnect();
        });
      }, { threshold: 0.3 });
      hwIO.observe(hw);
    } else {
      showAnnos('front');
    }
  }

  /* ============================================================
     听懂：一句话穿过三层
     ============================================================ */
  if (hasST && !reduceMotion && $('[data-pipe]')) {
    var pill = $('[data-pipe-pill]');
    var gates = $$('[data-gate]');
    gsap.timeline({
      scrollTrigger: { trigger: '[data-pipe]', start: 'top 72%', end: 'bottom 45%', scrub: 0.9 }
    })
      .to(pill, { x: function () { return gates[0].offsetLeft + gates[0].offsetWidth / 2 - pill.offsetWidth / 2; }, duration: 0.6 })
      .to(pill, { x: function () { return gates[1].offsetLeft + gates[1].offsetWidth / 2 - pill.offsetWidth / 2; }, duration: 0.6 })
      .to(pill, { x: function () { return gates[2].offsetLeft + gates[2].offsetWidth / 2 - pill.offsetWidth / 2; }, duration: 0.6 });
  }

  /* ============================================================
     数字与轨道
     ============================================================ */
  if (hasST) {
    $$('[data-count]').forEach(function (el) {
      var target = parseInt(el.getAttribute('data-count'), 10);
      if (reduceMotion || !hasGsap) { el.textContent = target.toLocaleString('en-US'); return; }
      var obj = { v: 0 };
      ScrollTrigger.create({
        trigger: el,
        start: 'top 88%',
        once: true,
        onEnter: function () {
          gsap.to(obj, {
            v: target, duration: 1.6, ease: 'power2.out',
            onUpdate: function () { el.textContent = Math.round(obj.v).toLocaleString('en-US'); }
          });
        }
      });
    });
  }

  /* ============================================================
     养成：经验条走过去 → 升级 → 表情跟着变
     ============================================================ */
  var growVisual = $('[data-grow]');
  if (growVisual) {
    var growScreen = $('[data-face]', growVisual);
    var growBar = $('[data-grow-bar] i', growVisual);
    var growLv = $('[data-grow-lv]', growVisual);
    var growPop = $('[data-grow-pop]', growVisual);
    var growLevel = { v: 1 };
    var growTl = null;

    if (hasGsap && growBar) {
      // 一轮：经验条走满 → 「升级！」弹一下、外圈转暖、表情变兴奋 → 回到常态
      growTl = gsap.timeline({ repeat: -1, repeatDelay: 0.8, paused: true })
        .set(growBar, { scaleX: 0 })
        .set(growPop, { opacity: 0, scale: 0.84, y: 6 })
        .to(growBar, { scaleX: 1, duration: 2.8, ease: 'power1.inOut' })
        .addLabel('lvup')
        .call(function () {
          growVisual.classList.add('is-levelup');
          setFace(growScreen, 'victory');
        })
        .to(growPop, { opacity: 1, scale: 1, y: 0, duration: 0.34, ease: 'back.out(2)' }, 'lvup')
        .to(growLevel, {
          v: function () { return growLevel.v + 1; },
          duration: 0.6,
          ease: 'power2.out',
          onUpdate: function () {
            if (growLv) growLv.textContent = String(Math.round(growLevel.v));
          }
        }, 'lvup+=0.12')
        .to(growPop, { opacity: 0, scale: 0.92, y: -8, duration: 0.32, ease: 'power1.in' }, 'lvup+=1.6')
        .call(function () {
          growVisual.classList.remove('is-levelup');
          setFace(growScreen, 'ready');
          // 等级走到 12 就从头再来，避免演示时一直涨
          if (growLevel.v >= 12) {
            growLevel.v = 1;
            if (growLv) growLv.textContent = '1';
          }
        }, null, 'lvup+=1.8');
    }

    if (growTl && !reduceMotion && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            growTl.play();
          } else {
            growTl.pause();
            growVisual.classList.remove('is-levelup');
            setFace(growScreen, 'ready');
          }
        });
      }, { threshold: 0.3 }).observe(growVisual);
    }
  }

  /* 调试：?debug 时在右下角列出每屏高度，便于核对「一屏装得下」 */
  if (/[?&]debug/.test(location.search)) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        var vh = window.innerHeight;
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99;background:#12332c;color:#daf7b3;font:11px/1.5 monospace;padding:8px 10px;border-radius:8px;max-height:80vh;overflow:auto';
        var rows = ['vh=' + vh];
        $$('.scene').forEach(function (sec) {
          var h = Math.round(sec.offsetHeight);
          rows.push((sec.id || '-') + ' ' + h + (h > vh + 8 ? ' 超' : ''));
        });
        rows.push('total=' + Math.round(document.documentElement.scrollHeight));
        box.textContent = rows.join(' | ');
        document.body.appendChild(box);
      }, 600);
    });
  }

  /* ============================================================
     启动
     ============================================================ */
  mountFaces();

  window.addEventListener('load', function () {
    if (hasST) ScrollTrigger.refresh();
    collectSnapPoints();
  });

  window.addEventListener('resize', function () {
    if (hasST) ScrollTrigger.refresh();
    collectSnapPoints();
  });
})();
