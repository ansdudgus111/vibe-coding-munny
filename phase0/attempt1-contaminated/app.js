/* 천천히 — 할 일을 눈으로 보는 작은 웹앱
   저장은 localStorage만 씁니다. 서버도 계정도 없습니다. */

(function () {
  'use strict';

  var KEY = 'cheoncheonhi.v1';
  var RING_LEN = 2 * Math.PI * 66; // 414.69

  /* ---------------- 상태 ---------------- */

  var state = {
    goal: 5,
    tasks: [],          // {id, title, total, done, createdAt, finishedAt}
    history: {},        // { "YYYY-MM-DD": 완료한 단계 수 }
    notify: { on: false, every: 30 },
    lastSeen: null      // 마지막 방문 ISO
  };

  var lastTouch = Date.now();   // 마지막 조작 시각 (방해 금지 판단용)
  var timer = null;
  var lastCoach = '';

  /* ---------------- 유틸 ---------------- */

  function todayKey(d) {
    d = d || new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function pick(list) {
    if (!list.length) return '';
    var out = list[Math.floor(Math.random() * list.length)];
    if (list.length > 1 && out === lastCoach) return pick(list);
    return out;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      /* 사생활 보호 모드 등에서 저장이 막힐 수 있습니다. 앱은 계속 돕니다. */
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        state.goal = saved.goal || 5;
        state.tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
        state.history = saved.history || {};
        state.notify = saved.notify || { on: false, every: 30 };
        state.lastSeen = saved.lastSeen || null;
      }
    } catch (e) { /* 깨진 데이터면 그냥 새로 시작합니다 */ }
  }

  function doneToday() { return state.history[todayKey()] || 0; }

  function daysAway() {
    if (!state.lastSeen) return 0;
    var diff = Date.now() - new Date(state.lastSeen).getTime();
    return Math.floor(diff / 86400000);
  }

  function nextStepTask() {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].done < state.tasks[i].total) return state.tasks[i];
    }
    return null;
  }

  /* ---------------- 코칭 문구 ---------------- */
  /* LLM을 쓰지 않습니다. 상태별로 미리 적어둔 문구 중 하나를 고릅니다. */

  var LINES = {
    welcomeBack: [
      '며칠 만이네요. 와준 것만으로 충분해요.',
      '다시 와줘서 고마워요. 오늘은 한 칸만 해볼까요?',
      '그동안 쉬었군요. 쉬는 것도 할 일이었어요.'
    ],
    empty: [
      '머리에 떠다니는 일 하나만 여기 내려놓아요.',
      '가장 작은 것부터 적어도 괜찮아요.',
      '다 적을 필요 없어요. 하나면 돼요.'
    ],
    start: [
      '첫 칸이 제일 무거워요. 그거 하나만요.',
      '오늘은 {next}의 첫 칸부터요.',
      '시작만 하면 돼요. 끝은 나중 일이에요.'
    ],
    going: [
      '오늘 {today}칸 채웠어요. 잘 가고 있어요.',
      '{today}칸이나 했네요. 숨 한 번 쉬고 가요.',
      '다음은 {next}. 천천히 가도 괜찮아요.',
      '여기까지 온 것만으로 충분히 하고 있어요.'
    ],
    almost: [
      '목표가 코앞이에요. 무리하진 말고요.',
      '한 칸만 더 하면 오늘 목표예요.',
      '거의 다 왔어요. 지금 멈춰도 괜찮고요.'
    ],
    reached: [
      '오늘 목표 다 채웠어요. 이제 쉬어도 돼요.',
      '{today}칸. 오늘은 여기까지가 딱 좋아요.',
      '충분해요. 화면 끄고 좀 쉬어요.'
    ]
  };

  function fill(line) {
    var t = nextStepTask();
    return line
      .replace('{today}', doneToday())
      .replace('{next}', t ? t.title : '');
  }

  function coachLine() {
    if (daysAway() >= 3) return pick(LINES.welcomeBack);
    if (!state.tasks.length) return pick(LINES.empty);

    var d = doneToday();
    if (d === 0) return fill(pick(LINES.start));
    if (d >= state.goal) return fill(pick(LINES.reached));
    if (d >= state.goal - 1) return pick(LINES.almost);
    return fill(pick(LINES.going));
  }

  /* ---------------- 알림 문구 ---------------- */

  var NUDGES = [
    '{title} — 다음 칸 하나만 해볼까요?',
    '잠깐 {title} 생각났어요. 10분만요.',
    '{title}, 한 칸이면 돼요. 그 이상은 안 해도 괜찮아요.',
    '쉬는 중이었다면 그대로 쉬어요. 아니면 {title} 한 칸 어때요?',
    '{title} 아직 남아 있어요. 조급해하진 말고요.'
  ];

  var NUDGES_EMPTY = [
    '오늘 뭘 할지 하나만 적어둘까요?',
    '할 일 한 줄만 올려두면 나중이 편해요.'
  ];

  var NUDGES_DONE = [
    '오늘 할 일은 다 채웠어요. 푹 쉬어요.',
    '남은 칸이 없네요. 오늘은 끝!'
  ];

  /* ---------------- 그리기 ---------------- */

  var $ = function (id) { return document.getElementById(id); };

  function renderHeader() {
    var now = new Date();
    var days = ['일', '월', '화', '수', '목', '금', '토'];
    $('todayLabel').textContent =
      (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + days[now.getDay()] + '요일';

    var line = coachLine();
    lastCoach = line;
    $('coachLine').textContent = line;
  }

  function renderRing() {
    var d = doneToday();
    var ratio = state.goal > 0 ? Math.min(d / state.goal, 1) : 0;
    $('ringFg').style.strokeDashoffset = String(RING_LEN * (1 - ratio));
    $('ringDone').textContent = d;
    $('ringGoal').textContent = '/ ' + state.goal;
    $('goalValue').textContent = state.goal;
    document.querySelector('.ring-wrap').classList.toggle('full', ratio >= 1);
  }

  function renderTasks() {
    var ul = $('taskList');
    ul.innerHTML = '';
    $('emptyMsg').hidden = state.tasks.length > 0;

    state.tasks.forEach(function (task) {
      var li = document.createElement('li');
      li.className = 'task' + (task.done >= task.total ? ' done' : '');

      var head = document.createElement('div');
      head.className = 'task-head';

      var title = document.createElement('span');
      title.className = 'task-title';
      title.textContent = task.title;

      var count = document.createElement('span');
      count.className = 'task-count';
      count.textContent = task.done + ' / ' + task.total;

      var del = document.createElement('button');
      del.className = 'task-del';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', task.title + ' 지우기');
      del.addEventListener('click', function () { removeTask(task.id); });

      head.appendChild(title);
      head.appendChild(count);
      head.appendChild(del);

      var blocks = document.createElement('div');
      blocks.className = 'blocks';
      blocks.setAttribute('role', 'group');
      blocks.setAttribute('aria-label', task.title + ' 진행 칸');

      for (var i = 0; i < task.total; i++) {
        (function (index) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'block' + (index < task.done ? ' on' : '');
          b.setAttribute('aria-label', (index + 1) + '번째 칸');
          b.setAttribute('aria-pressed', index < task.done ? 'true' : 'false');
          b.addEventListener('click', function () { setProgress(task.id, index); });
          blocks.appendChild(b);
        })(i);
      }

      var foot = document.createElement('p');
      foot.className = 'task-foot';
      foot.style.margin = '0';
      foot.textContent = task.done >= task.total
        ? '다 채웠어요 ☀'
        : '남은 칸 ' + (task.total - task.done) + '개';

      li.appendChild(head);
      li.appendChild(blocks);
      li.appendChild(foot);
      ul.appendChild(li);
    });
  }

  function renderHistory() {
    var box = $('history');
    box.innerHTML = '';
    var names = ['일', '월', '화', '수', '목', '금', '토'];
    var max = Math.max(state.goal, 1);

    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var key = todayKey(d);
      var n = state.history[key] || 0;
      var pct = Math.min(n / max, 1) * 100;

      var cell = document.createElement('div');
      cell.className = 'hday' + (i === 0 ? ' today' : '');
      cell.innerHTML =
        '<div class="hbar"><div class="hfill" style="height:' + pct + '%"></div></div>' +
        '<div class="hname">' + names[d.getDay()] + '</div>' +
        '<div class="hnum">' + (n || '·') + '</div>';
      cell.title = key + ' — ' + n + '칸';
      box.appendChild(cell);
    }
  }

  function render() {
    renderHeader();
    renderRing();
    renderTasks();
    renderHistory();
  }

  /* ---------------- 동작 ---------------- */

  function touch() { lastTouch = Date.now(); }

  function addTask(title, total) {
    state.tasks.push({
      id: String(Date.now()) + Math.random().toString(16).slice(2, 6),
      title: title,
      total: total,
      done: 0,
      createdAt: new Date().toISOString(),
      finishedAt: null
    });
    save(); render(); touch();
  }

  function removeTask(id) {
    state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
    save(); render(); touch();
  }

  /* 칸을 누르면 그 칸까지 채웁니다. 이미 채워진 마지막 칸을 누르면 하나 되돌립니다. */
  function setProgress(id, index) {
    var task = null;
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) { task = state.tasks[i]; break; }
    }
    if (!task) return;

    var before = task.done;
    var after = (index + 1 === task.done) ? index : index + 1;
    task.done = after;

    var delta = after - before;
    var key = todayKey();
    state.history[key] = Math.max(0, (state.history[key] || 0) + delta);

    if (task.done >= task.total && before < task.total) {
      task.finishedAt = new Date().toISOString();
      toast('<b>' + escapeHtml(task.title) + '</b> 다 채웠어요. 잠깐 쉬어도 좋아요.');
    } else if (delta > 0 && doneToday() === state.goal) {
      toast('오늘 목표를 다 채웠어요. 여기서 멈춰도 괜찮아요.');
    }

    save(); render(); touch();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setGoal(v) {
    state.goal = Math.max(1, Math.min(20, v));
    save(); render(); touch();
  }

  /* ---------------- 토스트 + 알림 ---------------- */

  function toast(html, ms) {
    var box = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = html;
    box.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .4s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 400);
    }, ms || 6000);
  }

  function nudgeText() {
    var t = nextStepTask();
    if (!state.tasks.length) return pick(NUDGES_EMPTY);
    if (!t) return pick(NUDGES_DONE);
    return pick(NUDGES).replace('{title}', t.title);
  }

  function fireNudge(force) {
    // 지금 앱을 쓰고 있으면 방해하지 않습니다 (5분 안에 조작했으면 건너뜀).
    if (!force && Date.now() - lastTouch < 5 * 60 * 1000) return;

    var text = nudgeText();
    toast(escapeHtml(text), 9000);

    if (window.Notification && Notification.permission === 'granted') {
      try {
        new Notification('천천히', { body: text, tag: 'cheoncheonhi' });
      } catch (e) { /* 일부 브라우저는 file:// 에서 막습니다 */ }
    }
  }

  function restartTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (!state.notify.on) return;
    timer = setInterval(fireNudge, state.notify.every * 60 * 1000);
  }

  function updatePermNote() {
    var note = $('permNote');
    if (!window.Notification) {
      note.textContent = '이 브라우저는 시스템 알림을 지원하지 않아요. 대신 화면 아래 팝업으로만 알려줄게요.';
      return;
    }
    if (Notification.permission === 'granted') {
      note.textContent = '시스템 알림이 켜져 있어요.';
    } else if (Notification.permission === 'denied') {
      note.textContent = '시스템 알림이 차단돼 있어요. 화면 아래 팝업으로만 알려줄게요.';
    } else {
      note.textContent = '알림을 켜면 브라우저가 권한을 한 번 물어봐요.';
    }
  }

  /* ---------------- 숨 고르기 ---------------- */

  var breatheTimer = null;

  function startBreathe() {
    var modal = $('breatheModal');
    var circle = $('breatheCircle');
    var label = $('breatheText');
    modal.hidden = false;

    var steps = [
      { t: '들이쉬기', scale: 1, sec: 4 },
      { t: '멈추기', scale: 1, sec: 4 },
      { t: '내쉬기', scale: .55, sec: 6 }
    ];
    var i = 0;

    function step() {
      var s = steps[i % steps.length];
      label.textContent = s.t;
      circle.style.transitionDuration = s.sec + 's';
      circle.style.transform = 'scale(' + s.scale + ')';
      circle.style.opacity = s.scale > .8 ? '.95' : '.6';
      i++;
      breatheTimer = setTimeout(step, s.sec * 1000);
    }
    step();
  }

  function stopBreathe() {
    if (breatheTimer) { clearTimeout(breatheTimer); breatheTimer = null; }
    $('breatheModal').hidden = true;
    touch();
  }

  /* ---------------- 연결 ---------------- */

  function bind() {
    $('addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var title = $('addTitle').value.trim();
      var steps = parseInt($('addSteps').value, 10);
      if (!title) return;
      if (!steps || steps < 1) steps = 1;
      if (steps > 12) steps = 12;
      addTask(title, steps);
      $('addTitle').value = '';
      $('addTitle').focus();
    });

    $('goalMinus').addEventListener('click', function () { setGoal(state.goal - 1); });
    $('goalPlus').addEventListener('click', function () { setGoal(state.goal + 1); });

    $('notifyOn').addEventListener('change', function (e) {
      state.notify.on = e.target.checked;
      if (state.notify.on && window.Notification && Notification.permission === 'default') {
        Notification.requestPermission().then(updatePermNote);
      }
      save(); restartTimer(); updatePermNote();
      if (state.notify.on) toast(state.notify.every + '분마다 조용히 알려줄게요.');
    });

    $('notifyEvery').addEventListener('change', function (e) {
      state.notify.every = parseInt(e.target.value, 10) || 30;
      save(); restartTimer();
    });

    $('testNotify').addEventListener('click', function () { fireNudge(true); });

    $('breatheBtn').addEventListener('click', startBreathe);
    $('breatheClose').addEventListener('click', stopBreathe);
    $('breatheModal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) stopBreathe();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('breatheModal').hidden) stopBreathe();
    });

    ['click', 'keydown', 'pointerdown'].forEach(function (ev) {
      document.addEventListener(ev, touch, { passive: true });
    });

    // 자정을 넘기면 화면을 새로 그립니다.
    var dayMark = todayKey();
    setInterval(function () {
      if (todayKey() !== dayMark) { dayMark = todayKey(); render(); }
    }, 60000);
  }

  /* ---------------- 시작 ---------------- */

  load();
  $('notifyOn').checked = state.notify.on;
  $('notifyEvery').value = String(state.notify.every);
  bind();
  render();
  updatePermNote();
  restartTimer();

  state.lastSeen = new Date().toISOString();
  save();
})();
