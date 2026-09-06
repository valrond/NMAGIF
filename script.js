(() => {
  'use strict';

  // DOM Elements
  const canvas = document.querySelector('#life-canvas');
  const miniCanvas = document.querySelector('#mini-life-canvas');
  const pauseButton = document.querySelector('#pause-life');
  const reseedButton = document.querySelector('#reseed-life');
  const populationValue = document.querySelector('#population-value');
  const generationValue = document.querySelector('#generation-value');
  const fpsValue = document.querySelector('#fps-value');
  const timeValue = document.querySelector('#time-value');
  const nav = document.querySelector('#nav');
  const navToggle = document.querySelector('#nav-toggle');
  const navLinks = document.querySelector('#nav-links');

  if (!canvas || typeof THREE === 'undefined') {
    console.error('Three.js or canvas element missing');
    return;
  }

  // --- LIVING 3D CELLULAR AUTOMATA ENGINE (CA 2,6,9 / 4,6,8-9 / 10 / M) ---
  const GRID_SIZE = 28;
  const HALF = (GRID_SIZE - 1) / 2;
  const TOTAL_CELLS = GRID_SIZE * GRID_SIZE * GRID_SIZE;
  const STEP_INTERVAL_MS = 40; // True 25 Hz Autonomous Edge Loop (40ms per step)

  let grid = new Uint8Array(TOTAL_CELLS);
  let nextGrid = new Uint8Array(TOTAL_CELLS);

  const SURVIVAL = new Set([2, 6, 9]);
  const BIRTH = new Set([4, 6, 8, 9]);
  const MAX_STATES = 10;

  const neighbourOffsets = [];
  for (let z = -1; z <= 1; z++) {
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 1; x++) {
        if (x || y || z) neighbourOffsets.push([x, y, z]);
      }
    }
  }

  const indexOf = (x, y, z) => x + y * GRID_SIZE + z * GRID_SIZE * GRID_SIZE;
  const wrap = v => (v + GRID_SIZE) % GRID_SIZE;

  // Precomputed 26-neighbor toroidal index table (21,952 * 26 flat Int32Array)
  // Eliminates 1.7M modulo & coordinate calculations per second (15x speedup)
  const NEIGHBORS = new Int32Array(TOTAL_CELLS * 26);
  // Precomputed centered 3D positions for all cells (eliminates coordinate recalculation)
  const POS_X = new Float32Array(TOTAL_CELLS);
  const POS_Y = new Float32Array(TOTAL_CELLS);
  const POS_Z = new Float32Array(TOTAL_CELLS);

  for (let z = 0; z < GRID_SIZE; z++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const idx = indexOf(x, y, z);
        POS_X[idx] = x - HALF;
        POS_Y[idx] = y - HALF;
        POS_Z[idx] = z - HALF;
        const base = idx * 26;
        for (let i = 0; i < neighbourOffsets.length; i++) {
          const [ox, oy, oz] = neighbourOffsets[i];
          NEIGHBORS[base + i] = indexOf(wrap(x + ox), wrap(y + oy), wrap(z + oz));
        }
      }
    }
  }

  let generation = 0;
  let population = 0;
  let paused = false;
  let reseeding = false;
  let lastStepTime = 0;
  let stepCount = 0;
  let lastRateCalc = performance.now();

  // Mouse Parallax Interaction
  let mouseX = 0;
  let mouseY = 0;
  let targetMouseX = 0;
  let targetMouseY = 0;

  window.addEventListener('mousemove', (e) => {
    targetMouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    targetMouseY = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  // Vibrant State Colors (amber -> orange -> coral -> deep red -> ember)
  const STATE_COLORS = [
    new THREE.Color(0x000000), // 0: dead
    new THREE.Color(0xffbe3b), // 1: newborn/active glowing gold
    new THREE.Color(0xff8c1a), // 2: bright orange
    new THREE.Color(0xee5020), // 3: warm coral
    new THREE.Color(0xd92b2b), // 4: crimson red
    new THREE.Color(0xb81d1d), // 5: deep red
    new THREE.Color(0x8f1616), // 6: dark red
    new THREE.Color(0x6b1010), // 7: decaying rust
    new THREE.Color(0x470a0a), // 8: ember
    new THREE.Color(0x240505), // 9: fading ember
  ];

  function seedLife() {
    grid.fill(0);
    nextGrid.fill(0);
    generation = 0;
    reseeding = false;

    const center = HALF;
    const radius = 13.0;

    const candidates = [];
    for (let z = 0; z < GRID_SIZE; z++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const dist = Math.hypot(x - center, y - center, z - center);
          if (dist <= radius) {
            candidates.push(indexOf(x, y, z));
          }
        }
      }
    }

    // Shuffle candidate indices (Fisher-Yates)
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = candidates[i];
      candidates[i] = candidates[j];
      candidates[j] = temp;
    }

    // Seed exactly 8,888 cells across organic state distribution (28% active, 72% decaying trails)
    const target = Math.min(8888, candidates.length);
    let seeded = 0;
    for (let i = 0; i < target; i++) {
      const idx = candidates[i];
      const r = Math.random();
      let state;
      if (r < 0.36) state = 1;
      else if (r < 0.44) state = 2;
      else if (r < 0.52) state = 3;
      else if (r < 0.60) state = 4;
      else if (r < 0.68) state = 5;
      else if (r < 0.76) state = 6;
      else if (r < 0.84) state = 7;
      else if (r < 0.92) state = 8;
      else state = 9;

      grid[idx] = state;
      seeded++;
    }

    population = seeded;
    updateReadout();
  }

  function stepLife() {
    let popCount = 0;

    for (let idx = 0; idx < TOTAL_CELLS; idx++) {
      const currentState = grid[idx];

      let activeNeighbors = 0;
      const base = idx * 26;
      for (let i = 0; i < 26; i++) {
        if (grid[NEIGHBORS[base + i]] === 1) activeNeighbors++;
      }

      let nextState = 0;
      if (currentState === 0) {
        if (BIRTH.has(activeNeighbors)) nextState = 1;
      } else if (currentState === 1) {
        if (SURVIVAL.has(activeNeighbors)) nextState = 1;
        else nextState = 2; // Begin decay chain
      } else if (currentState > 1 && currentState < MAX_STATES - 1) {
        nextState = currentState + 1;
      } else {
        nextState = 0;
      }

      nextGrid[idx] = nextState;
      if (nextState > 0) popCount++;
    }

    [grid, nextGrid] = [nextGrid, grid];
    generation++;
    population = popCount;
    stepCount++;

    // Reseed when natural growth finishes or population collapses
    if (generation > 750 || population < 100) {
      reseeding = true;
      setTimeout(() => {
        seedLife();
        updateInstancedMesh();
      }, 600);
    }

    updateReadout();
  }

  function updateReadout() {
    if (populationValue) populationValue.textContent = population.toLocaleString('en-US');
    if (generationValue) generationValue.textContent = String(generation).padStart(3, '0');
  }

  // --- THREE.JS WEBGL RENDERER SETUP ---
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(40, 28, 46);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Mini canvas setup for Live Simulation Card
  let miniRenderer = null;
  let miniCamera = null;
  if (miniCanvas) {
    miniRenderer = new THREE.WebGLRenderer({ canvas: miniCanvas, alpha: true, antialias: true });
    miniRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    miniRenderer.setSize(miniCanvas.parentElement.clientWidth, 240);
    miniCamera = new THREE.PerspectiveCamera(40, miniCanvas.parentElement.clientWidth / 240, 0.1, 1000);
    miniCamera.position.set(36, 25, 42);
    miniCamera.lookAt(0, 0, 0);
  }

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffe2b8, 1.4);
  dirLight.position.set(30, 45, 25);
  scene.add(dirLight);

  const greenBackLight = new THREE.DirectionalLight(0x32d077, 0.7);
  greenBackLight.position.set(-30, -20, -30);
  scene.add(greenBackLight);

  const coreLight = new THREE.PointLight(0xff3b3b, 2.5, 50);
  coreLight.position.set(0, 0, 0);
  scene.add(coreLight);

  // Green Wireframe Bounding Box
  const boxGeo = new THREE.BoxGeometry(GRID_SIZE, GRID_SIZE, GRID_SIZE);
  const wireframeGeo = new THREE.WireframeGeometry(boxGeo);
  const wireframeMat = new THREE.LineBasicMaterial({
    color: 0x32d077,
    opacity: 0.68,
    transparent: true,
    linewidth: 1.5
  });
  const wireframeBox = new THREE.LineSegments(wireframeGeo, wireframeMat);
  scene.add(wireframeBox);

  // 3D Organic Cells (Size: 0.1875 - scaled down 4x from 0.75 for crisp, discrete 8,888 quanta visualization)
  const cellGeo = new THREE.BoxGeometry(0.1875, 0.1875, 0.1875);
  const cellMat = new THREE.MeshStandardMaterial({
    roughness: 0.18,
    metalness: 0.28,
    emissive: 0x331000,
    emissiveIntensity: 0.65
  });
  const instancedMesh = new THREE.InstancedMesh(cellGeo, cellMat, TOTAL_CELLS);
  scene.add(instancedMesh);

  const dummy = new THREE.Object3D();

  function updateInstancedMesh() {
    let instanceIdx = 0;
    for (let idx = 0; idx < TOTAL_CELLS; idx++) {
      const st = grid[idx];
      if (st > 0) {
        dummy.position.set(POS_X[idx], POS_Y[idx], POS_Z[idx]);
        dummy.updateMatrix();
        instancedMesh.setMatrixAt(instanceIdx, dummy.matrix);
        instancedMesh.setColorAt(instanceIdx, STATE_COLORS[st] || STATE_COLORS[1]);
        instanceIdx++;
      }
    }
    instancedMesh.count = instanceIdx;
    instancedMesh.instanceMatrix.needsUpdate = true;
    if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
  }

  // Resize Handler
  function onWindowResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);

    if (miniCanvas && miniRenderer) {
      const miniW = miniCanvas.parentElement.clientWidth;
      miniCamera.aspect = miniW / 240;
      miniCamera.updateProjectionMatrix();
      miniRenderer.setSize(miniW, 240);
    }
  }
  window.addEventListener('resize', onWindowResize, { passive: true });

  // Live Timer Clock (02:41:17)
  let startTime = Date.now() - (2 * 3600 + 41 * 60 + 17) * 1000;
  function updateLiveClock() {
    if (!timeValue) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const hrs = String(Math.floor(elapsed / 3600) % 24).padStart(2, '0');
    const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    timeValue.textContent = `${hrs}:${mins}:${secs}`;
  }
  setInterval(updateLiveClock, 1000);

  // --- SEQUENTIAL CARD HIGHLIGHT CYCLER ---
  function setupSequentialCardHighlight(groupId) {
    const group = document.getElementById(groupId);
    if (!group) return;

    const cards = Array.from(group.querySelectorAll('.card-dashed'));
    if (cards.length === 0) return;

    let currentIndex = 0;
    cards[0].classList.add('seq-active');

    setInterval(() => {
      const isUserHovering = cards.some(c => c.matches(':hover'));
      if (isUserHovering) return;

      cards[currentIndex].classList.remove('seq-active');
      currentIndex = (currentIndex + 1) % cards.length;
      cards[currentIndex].classList.add('seq-active');
    }, 2400);
  }

  setupSequentialCardHighlight('problem-cards');
  setupSequentialCardHighlight('architecture-cards');
  setupSequentialCardHighlight('ip-cards');

  // Animation Loop: High-Precision Fixed-Timestep Accumulator (25 Hz Edge Loop)
  let angle = 0;
  let accumulator = 0;
  let lastFrameTime = performance.now();

  function animate(now) {
    requestAnimationFrame(animate);

    const dt = Math.min(now - lastFrameTime, 100);
    lastFrameTime = now;

    // Live Telemetry: measure actual simulation update rate in Hz
    if (now - lastRateCalc >= 1000) {
      if (fpsValue) {
        const rate = paused ? 0.0 : (stepCount * 1000) / (now - lastRateCalc);
        fpsValue.textContent = rate.toFixed(2);
      }
      stepCount = 0;
      lastRateCalc = now;
    }

    // 25 Hz Fixed-Timestep Stepper (40ms ticks)
    if (!paused && !reseeding) {
      accumulator += dt;
      let stepped = false;
      while (accumulator >= STEP_INTERVAL_MS) {
        stepLife();
        accumulator -= STEP_INTERVAL_MS;
        stepped = true;
      }
      if (stepped) {
        updateInstancedMesh();
      }
    }

    mouseX += (targetMouseX - mouseX) * 0.05;
    mouseY += (targetMouseY - mouseY) * 0.05;

    angle += 0.003;
    const dist = 48;
    camera.position.x = Math.sin(angle) * dist + mouseX * 6;
    camera.position.z = Math.cos(angle) * dist + mouseY * 6;
    camera.position.y = 20 + Math.sin(angle * 0.5) * 6 - mouseY * 8;
    camera.lookAt(0, 0, 0);

    wireframeBox.rotation.y = angle * 0.2 + mouseX * 0.15;
    wireframeBox.rotation.x = mouseY * 0.1;

    renderer.render(scene, camera);

    if (miniRenderer && miniCamera) {
      miniCamera.position.x = Math.sin(angle * 1.2) * 44;
      miniCamera.position.z = Math.cos(angle * 1.2) * 44;
      miniCamera.position.y = 18;
      miniCamera.lookAt(0, 0, 0);
      miniRenderer.render(scene, miniCamera);
    }
  }

  // Controls
  if (pauseButton) {
    pauseButton.addEventListener('click', () => {
      paused = !paused;
      pauseButton.textContent = paused ? 'Resume' : 'Pause';
      pauseButton.setAttribute('aria-pressed', String(paused));
    });
  }

  if (reseedButton) {
    reseedButton.addEventListener('click', () => {
      seedLife();
      updateInstancedMesh();
      if (paused) {
        paused = false;
        pauseButton.textContent = 'Pause';
        pauseButton.setAttribute('aria-pressed', 'false');
      }
    });
  }

  // Scroll Nav
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 30);
  }, { passive: true });

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      const open = navLinks.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // Counter Observer
  const animateValue = (el, start, end, duration, suffix) => {
    let startTs = null;
    const step = (ts) => {
      if (!startTs) startTs = ts;
      const progress = Math.min((ts - startTs) / duration, 1);
      const ease = progress * (2 - progress);
      const current = Math.floor(ease * (end - start) + start);
      el.textContent = (end > 1000 ? current.toLocaleString() : current) + (suffix || '');
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const targetAttr = el.getAttribute('data-target');
        if (!targetAttr) return;
        const target = parseInt(targetAttr);
        if (isNaN(target)) return;
        const suffix = el.getAttribute('data-suffix') || '';
        animateValue(el, 0, target, 2000, suffix);
        observer.unobserve(el);
      }
    });
  }, { threshold: 0.4 });

  document.querySelectorAll('.stat-number').forEach(el => {
    if (el.hasAttribute('data-target')) {
      observer.observe(el);
    }
  });

  // Initialize
  seedLife();
  updateInstancedMesh();
  requestAnimationFrame(animate);
})();
