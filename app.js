import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

// === CORE VARIABLES ===
let scene, camera, renderer;
let panoMesh, sphereMesh, panoMaterial, stereoSphereMaterial;
let backButton, menuButton, controllerPointers = [];
let interactiveObjects = [];
let currentImageFile = null;
let currentAudio = null;
let isViewingImage = false;
let immersiveVrSupported = null;
let menuButtonLatch = false;
let snapTurnLatch = false;
const SNAP_TURN_ANGLE = THREE.MathUtils.degToRad(30);
const SNAP_TURN_THRESHOLD = 0.65;

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

const fileInput = document.getElementById('fileInput');
const uiCard = document.getElementById('ui');
const enterVrButton = document.getElementById('enterVrButton');
const loadingText = document.getElementById('loading');
const fileCount = document.getElementById('fileCount');

// === INIT ===
init();
animate();

function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.6, 0);

  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('xr-canvas'), antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  createPanoMesh();
  createSphereMesh();
  createVrButtons();

  setupControllers();
  setupHands();
  setupFileInput();
  setupEnterVrButton();
  detectVrSupport();

  window.addEventListener('resize', onWindowResize);
}

// === VR BUTTONS (Back + Menu) ===
function createVrButtons() {
  backButton = createTextButton('Back', -0.5, 1.15, -1);
  backButton.visible = false;
  backButton.userData.onClick = returnToUpload;

  menuButton = createTextButton('Menu', 0, 1.15, -1);
  menuButton.visible = false;
  menuButton.userData.onClick = showMenu;

  [backButton, menuButton].forEach(b => {
    scene.add(b);
    interactiveObjects.push(b);
  });
}

function createTextButton(label, x, y, z) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#4f75ff');
  grad.addColorStop(1, '#24366b');
  ctx.fillStyle = grad;
  roundRect(ctx, 6, 6, canvas.width - 12, canvas.height - 12, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(188, 207, 255, 0.95)';
  ctx.lineWidth = 10;
  roundRect(ctx, 10, 10, canvas.width - 20, canvas.height - 20, 24);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.24)';
  roundRect(ctx, 22, 20, canvas.width - 44, 62, 18);
  ctx.fill();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 6);
  ctx.shadowBlur = 0;
  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.13), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  mesh.position.set(x, y, z);
  return mesh;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// === CONTROLLERS ===
function setupControllers() {
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    controller.addEventListener('connected', e => controller.userData.handedness = e.data?.handedness);
    controller.addEventListener('selectstart', () => controller.userData.selectPressed = true);
    controller.addEventListener('selectend', () => controller.userData.selectPressed = false);
    const pointer = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-3)]), new THREE.LineBasicMaterial({ color: 0x8fb0ff }));
    controller.add(pointer);
    controllerPointers.push(pointer);
    scene.add(controller);
  }
}

function setupHands() {
  const factory = new XRHandModelFactory();
  for (let i = 0; i < 2; i++) {
    const hand = renderer.xr.getHand(i);
    hand.add(factory.createHandModel(hand, 'mesh'));
    scene.add(hand);
  }
}

// === FILE INPUT ===
function setupFileInput() {
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    showConversionScreen(file.name);

    try {
      await convertImage(file);
    } catch (err) {
      showError('Conversion failed: ' + err.message);
    }

    e.target.value = '';
  });
}

// === CONVERSION (works on 2D page) ===
async function convertImage(file) {
  updateLog('Loading image...');
  updateProgress(15);

  const img = await loadImageAsync(file);
  updateLog('Image loaded (' + img.width + 'x' + img.height + ')');
  updateProgress(35);

  // Extract 3D right eye
  updateLog('Looking for 3D data...');
  let rightEye = null;
  try {
    rightEye = await extractRightEye(file);
  } catch (e) {
    updateLog('3D extraction failed (continuing as 2D)');
  }

  const has3D = !!rightEye;
  if (has3D) updateLog('3D data found ✓');
  else updateLog('No 3D data - viewing as 360');
  updateProgress(55);

  // Extract audio
  updateLog('Checking for audio...');
  let audioUrl = null;
  try {
    audioUrl = await extractAudio(file);
  } catch (e) {
    updateLog('No audio found');
  }

  if (audioUrl) {
    updateLog('Audio found ✓');
    currentAudio = new Audio(audioUrl);
    currentAudio.loop = true;
    currentAudio.volume = 0.85;
  }
  updateProgress(75);

  // Prepare texture
  const tex = new THREE.Texture(img);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;

  const ratio = img.width / img.height;
  const isEquirect = ratio > 1.85 && ratio < 2.15;

  if (has3D) {
    updateLog('Creating top/bottom 3D view...');
    const stereoCanvas = createTopBottomStereo(img, rightEye);
    const stereoTex = new THREE.Texture(stereoCanvas);
    stereoTex.needsUpdate = true;
    stereoTex.colorSpace = THREE.SRGBColorSpace;

    panoMesh.visible = true;
    sphereMesh.visible = false;
    panoMaterial.uniforms.map.value = stereoTex;
    panoMaterial.uniforms.stereoMode.value = -1;
    panoMesh.scale.y = 1;

  } else if (isEquirect) {
    updateLog('Viewing as 360 sphere');
    sphereMesh.visible = true;
    panoMesh.visible = false;
    stereoSphereMaterial.uniforms.map.value = tex;
    stereoSphereMaterial.uniforms.stereoMode.value = 0;

  } else {
    updateLog('Viewing as panorama');
    panoMesh.visible = true;
    sphereMesh.visible = false;
    panoMaterial.uniforms.map.value = tex;
    panoMaterial.uniforms.stereoMode.value = 0;
    panoMesh.scale.y = 1;
  }

  updateProgress(100);
  updateLog('Ready!');

  currentImageFile = file;

  setTimeout(() => {
    hideConversionScreen();
    showViewButton();
  }, 600);

  if (currentAudio) {
    currentAudio.play().catch(() => {});
  }
}

function loadImageAsync(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

async function extractRightEye(file) {
  const buf = await file.arrayBuffer();
  const txt = new TextDecoder('latin1').decode(buf);

  const patterns = [
    /GImage:Data\s*=\s*["']([A-Za-z0-9+/=_-\s&#10;]+)["']/,
    /<GImage:Data>([A-Za-z0-9+/=_-\s&#10;]+)<\/GImage:Data>/,
    /xmpGImg:Data\s*=\s*["']([A-Za-z0-9+/=_-\s&#10;]+)["']/,
    /<xmpGImg:Data>([A-Za-z0-9+/=_-\s&#10;]+)<\/xmpGImg:Data>/
  ];

  let match = null;
  for (const p of patterns) { match = txt.match(p); if (match) break; }
  if (!match) return null;

  let b64 = match[1].replace(/&#10;/g, '').replace(/\s/g, '');
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  b64 = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');

  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);

  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  URL.revokeObjectURL(url);
  return img;
}

async function extractAudio(file) {
  const buf = await file.arrayBuffer();
  const txt = new TextDecoder('latin1').decode(buf);

  const match = txt.match(/GAudio:Data\s*=\s*["']([A-Za-z0-9+/=_-\s&#10;]+)["']/) ||
                txt.match(/<GAudio:Data>([A-Za-z0-9+/=_-\s&#10;]+)<\/GAudio:Data>/);
  if (!match) return null;

  let b64 = match[1].replace(/&#10;/g, '').replace(/\s/g, '');
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  b64 = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');

  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'audio/mp4' });
  return URL.createObjectURL(blob);
}

function createTopBottomStereo(topImg, bottomImg) {
  const c = document.createElement('canvas');
  c.width = topImg.width;
  c.height = topImg.height * 2;
  const ctx = c.getContext('2d');
  ctx.drawImage(topImg, 0, 0, topImg.width, topImg.height);
  ctx.drawImage(bottomImg, 0, topImg.height, bottomImg.width, bottomImg.height);
  return c;
}

// === UI SCREENS ===
let conversionScreen = null;
let progressBar = null;
let logBox = null;

function showConversionScreen(filename) {
  hideAllScreens();
  conversionScreen = document.createElement('div');
  conversionScreen.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(5,7,15,0.98);color:#fff;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;';
  conversionScreen.innerHTML = `
    <div style="width:90%;max-width:420px;text-align:center;">
      <div style="font-size:1.3rem;margin-bottom:24px;">Converting to 3D</div>
      <div style="color:#9aa4c2;margin-bottom:8px;font-size:0.9rem;">${filename}</div>
      <div style="background:#1a2338;border-radius:9999px;height:10px;margin:20px 0;overflow:hidden;">
        <div id="prog-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#4f8cff,#7ba3ff);transition:width .25s ease;"></div>
      </div>
      <div id="log-box" style="background:#0f1629;border:1px solid #334155;border-radius:10px;padding:12px;height:150px;overflow-y:auto;font-family:monospace;font-size:12px;text-align:left;color:#9aa4c2;"></div>
    </div>
  `;
  document.body.appendChild(conversionScreen);
  progressBar = document.getElementById('prog-bar');
  logBox = document.getElementById('log-box');
}

function updateProgress(pct) { if (progressBar) progressBar.style.width = pct + '%'; }
function updateLog(msg) {
  if (!logBox) return;
  const line = document.createElement('div');
  line.style.margin = '2px 0';
  line.textContent = msg;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}
function hideConversionScreen() { if (conversionScreen) { conversionScreen.remove(); conversionScreen = null; } }

function showViewButton() {
  hideAllScreens();
  const screen = document.createElement('div');
  screen.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(5,7,15,0.95);display:flex;align-items:center;justify-content:center;';
  screen.innerHTML = `
    <div style="text-align:center;">
      <div style="margin-bottom:20px;">
        <div style="font-size:1.2rem;">Ready to View</div>
        <div style="color:#9aa4c2;margin-top:6px;">${currentImageFile?.name || ''}</div>
      </div>
      <button id="view-btn" style="background:#4f8cff;color:white;border:none;padding:18px 50px;border-radius:14px;font-size:1.15rem;font-weight:700;box-shadow:0 10px 30px rgba(79,140,255,0.4);">
        View 3D Panorama
      </button>
    </div>
  `;
  document.body.appendChild(screen);
  document.getElementById('view-btn').onclick = () => { screen.remove(); enterViewingMode(); };
}

function enterViewingMode() {
  isViewingImage = true;
  panoMesh.visible = true;
  sphereMesh.visible = false;
  backButton.visible = true;
  menuButton.visible = true;
  if (currentAudio) currentAudio.play().catch(() => {});
}

function returnToUpload() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  panoMesh.visible = false;
  sphereMesh.visible = false;
  isViewingImage = false;
  backButton.visible = false;
  menuButton.visible = false;
  uiCard.classList.remove('hidden');
}

function showMenu() {
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;';
  m.innerHTML = `
    <div style="background:#1a2338;border-radius:16px;padding:24px 28px;border:1px solid #334155;min-width:260px;text-align:center;">
      <div style="font-size:1.1rem;margin-bottom:18px;">Menu</div>
      <button id="m-return" style="display:block;width:100%;margin-bottom:10px;padding:13px;border-radius:10px;border:1px solid #4f8cff;background:transparent;color:#4f8cff;font-weight:600;">Return to Upload</button>
      <button id="m-exit" style="display:block;width:100%;padding:13px;border-radius:10px;border:1px solid #ff6b6b;background:transparent;color:#ff6b6b;font-weight:600;">Exit VR</button>
    </div>
  `;
  document.body.appendChild(m);
  document.getElementById('m-return').onclick = () => { m.remove(); returnToUpload(); };
  document.getElementById('m-exit').onclick = () => { const s = renderer.xr.getSession(); if (s) s.end(); m.remove(); };
}

function showError(msg) {
  hideAllScreens();
  const e = document.createElement('div');
  e.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(5,7,15,0.98);display:flex;align-items:center;justify-content:center;';
  e.innerHTML = `
    <div style="text-align:center;padding:20px;">
      <div style="color:#ff6b6b;margin-bottom:12px;">Error</div>
      <div style="color:#fff;margin-bottom:20px;">${msg}</div>
      <button onclick="location.reload()" style="padding:10px 24px;border-radius:8px;border:1px solid #fff;background:transparent;color:#fff;">Reload</button>
    </div>
  `;
  document.body.appendChild(e);
}

function hideAllScreens() {
  document.querySelectorAll('div[style*="position:fixed"]').forEach(el => el.remove());
}

// === RENDERING ===
function createPanoMesh() {
  const geo = new THREE.CylinderGeometry(5, 5, 3, 128, 64, true, -Math.PI/2, Math.PI*2);
  panoMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { map: { value: null }, eyeIndex: { value: 0 }, stereoMode: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform sampler2D map; uniform float eyeIndex; uniform float stereoMode;
    void main(){
      vec2 uv = vUv;
      if (stereoMode > 0.5) { uv.x = (uv.x * 0.5) + (eyeIndex > 0.5 ? 0.5 : 0.0); }
      else if (stereoMode < -0.5) { uv.y = (uv.y * 0.5) + (eyeIndex > 0.5 ? 0.0 : 0.5); }
      gl_FragColor = texture2D(map, uv);
    }`
  });
  panoMesh = new THREE.Mesh(geo, panoMaterial);
  panoMesh.scale.x = -1;
  panoMesh.position.y = 1.6;
  panoMesh.onBeforeRender = (r, s, cam) => {
    if (renderer.xr.isPresenting && cam?.viewport) panoMaterial.uniforms.eyeIndex.value = cam.viewport.x === 0 ? 0 : 1;
  };
  panoMesh.visible = false;
  scene.add(panoMesh);
}

function createSphereMesh() {
  const geo = new THREE.SphereGeometry(50, 64, 64);
  geo.scale(-1, 1, 1);
  stereoSphereMaterial = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, eyeIndex: { value: 0 }, stereoMode: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform sampler2D map; uniform float eyeIndex; uniform float stereoMode;
    void main(){
      vec2 uv = vUv;
      if (stereoMode > 0.5) { uv.x = (uv.x * 0.5) + (eyeIndex > 0.5 ? 0.5 : 0.0); }
      else if (stereoMode < -0.5) { uv.y = (uv.y * 0.5) + (eyeIndex > 0.5 ? 0.0 : 0.5); }
      gl_FragColor = texture2D(map, uv);
    }`
  });
  sphereMesh = new THREE.Mesh(geo, stereoSphereMaterial);
  sphereMesh.onBeforeRender = (r, s, cam) => {
    if (renderer.xr.isPresenting && cam?.viewport) stereoSphereMaterial.uniforms.eyeIndex.value = cam.viewport.x === 0 ? 0 : 1;
  };
  sphereMesh.visible = false;
  scene.add(sphereMesh);
}

// === INPUT HANDLING ===
function handleXrInput() {
  if (!renderer.xr.isPresenting) return;
  const session = renderer.xr.getSession();
  const sources = Array.from(session?.inputSources || []);
  const right = sources.find(s => s.handedness === 'right');
  const x = right?.gamepad?.axes?.[2] ?? 0;

  if (!snapTurnLatch && Math.abs(x) > SNAP_TURN_THRESHOLD) {
    const d = x > 0 ? SNAP_TURN_ANGLE : -SNAP_TURN_ANGLE;
    if (panoMesh.visible) panoMesh.rotation.y += d;
    if (sphereMesh.visible) sphereMesh.rotation.y += d;
    snapTurnLatch = true;
  } else if (snapTurnLatch && Math.abs(x) < 0.25) snapTurnLatch = false;
}

function handleController(controller) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  const hits = raycaster.intersectObjects(interactiveObjects, false);
  interactiveObjects.forEach(o => o.scale.set(1,1,1));
  if (!hits.length) return;
  const sel = hits[0].object;
  sel.scale.set(1.08, 1.08, 1.08);
  if (controller.userData.selectPressed) {
    controller.userData.selectPressed = false;
    sel.userData.onClick?.();
  }
}

// === ANIMATION ===
function animate() {
  renderer.setAnimationLoop(() => {
    handleXrInput();
    controllerPointers.forEach(c => c.visible = isViewingImage);
    renderer.render(scene, camera);
  });
}

// === VR SESSION (RESTORED FROM ORIGINAL WORKING VERSION) ===
function setupEnterVrButton() {
  enterVrButton.addEventListener('click', () => {
    startVrSession();
  });

  renderer.xr.addEventListener('sessionstart', () => {
    uiCard.classList.add('hidden');
  });

  renderer.xr.addEventListener('sessionend', () => {
    uiCard.classList.remove('hidden');
  });
}

async function detectVrSupport() {
  if (!navigator.xr) {
    immersiveVrSupported = false;
    enterVrButton.disabled = true;
    enterVrButton.textContent = 'WebXR Not Available';
    return false;
  }

  try {
    immersiveVrSupported = await navigator.xr.isSessionSupported('immersive-vr');
  } catch {
    immersiveVrSupported = false;
  }

  if (!immersiveVrSupported) {
    enterVrButton.disabled = true;
    enterVrButton.textContent = 'VR Not Supported Here';
  }

  return immersiveVrSupported;
}

async function startVrSession() {
  const supported = immersiveVrSupported === null ? await detectVrSupport() : immersiveVrSupported;
  if (!navigator.xr || !supported) return;

  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['hand-tracking', 'local-floor', 'bounded-floor']
    });
    renderer.xr.setSession(session);
  } catch (error) {
    console.error('Failed to start VR session:', error);
    alert('Could not start VR: ' + (error?.message || 'unknown error'));
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}