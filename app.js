import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

// === CORE ===
let scene, camera, renderer;
let panoMesh, panoMaterial;
let currentImageFile = null;
let currentAudio = null;
let isViewing = false;
let immersiveVrSupported = null;
let snapTurnLatch = false;
const SNAP_TURN_ANGLE = THREE.MathUtils.degToRad(30);
const SNAP_TURN_THRESHOLD = 0.65;

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

const fileInput = document.getElementById('fileInput');
const uiCard = document.getElementById('ui');
const enterVrButton = document.getElementById('enterVrButton');

// === UI STATE ===
let currentPanel = null;
let interactiveObjects = [];

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

  setupControllers();
  setupHands();
  setupFileInput();
  setupEnterVrButton();
  detectVrSupport();

  window.addEventListener('resize', onWindowResize);
}

// === PANORAMA CYLINDER (Full 360° Immersion) ===
function createPanoMesh() {
  // Tall + wide cylinder so user feels INSIDE it
  const geo = new THREE.CylinderGeometry(9, 9, 9, 128, 64, true, -Math.PI/2, Math.PI*2);
  panoMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { map: { value: null }, eyeIndex: { value: 0 }, stereoMode: { value: -1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform sampler2D map; uniform float eyeIndex; uniform float stereoMode;
    void main(){
      vec2 uv = vUv;
      if (stereoMode < -0.5) { uv.y = (uv.y * 0.5) + (eyeIndex > 0.5 ? 0.0 : 0.5); }
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
    showConversionPanel(file.name);
    try {
      await convertImage(file);
    } catch (err) {
      showErrorPanel('Conversion failed: ' + err.message);
    }
    e.target.value = '';
  });
}

// === CONVERSION ===
async function convertImage(file) {
  updateLog('Loading image...');
  updateProgress(15);

  const img = await loadImageAsync(file);
  updateLog('Image loaded (' + img.width + 'x' + img.height + ')');
  updateProgress(35);

  updateLog('Extracting 3D data...');
  let rightEye = null;
  try { rightEye = await extractRightEye(file); } catch {}
  const has3D = !!rightEye;
  if (has3D) updateLog('3D data found ✓');
  else updateLog('No 3D data - viewing as 360');
  updateProgress(55);

  updateLog('Checking for audio...');
  let audioUrl = null;
  try { audioUrl = await extractAudio(file); } catch {}
  if (audioUrl) {
    updateLog('Audio found ✓');
    currentAudio = new Audio(audioUrl);
    currentAudio.loop = true;
    currentAudio.volume = 0.85;
  } else {
    updateLog('No audio found');
  }
  updateProgress(75);

  const tex = new THREE.Texture(img);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;

  if (has3D) {
    updateLog('Creating top/bottom 3D view...');
    const stereoCanvas = createTopBottomStereo(img, rightEye);
    const stereoTex = new THREE.Texture(stereoCanvas);
    stereoTex.needsUpdate = true;
    stereoTex.colorSpace = THREE.SRGBColorSpace;
    panoMaterial.uniforms.map.value = stereoTex;
    panoMaterial.uniforms.stereoMode.value = -1;
  } else {
    updateLog('Viewing as 360 panorama');
    panoMaterial.uniforms.map.value = tex;
    panoMaterial.uniforms.stereoMode.value = 0;
  }

  updateProgress(100);
  updateLog('Ready!');

  currentImageFile = file;

  setTimeout(() => {
    hideCurrentPanel();
    showReadyPanel();
    enterVrButton.disabled = false;
    enterVrButton.textContent = 'Enter VR';
  }, 600);

  if (currentAudio) currentAudio.play().catch(() => {});
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

// === UI PANELS (Premium Oculus-style) ===
function createGlassPanel(width, height, title, contentHTML) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 768;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = 'rgba(10, 12, 24, 0.92)';
  roundRect(ctx, 0, 0, 1024, 768, 40);
  ctx.fill();

  // Border glow
  ctx.strokeStyle = 'rgba(79, 140, 255, 0.3)';
  ctx.lineWidth = 4;
  roundRect(ctx, 8, 8, 1008, 752, 36);
  ctx.stroke();

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, 512, 80);

  // Content
  ctx.fillStyle = '#9aa4c2';
  ctx.font = '28px Inter, sans-serif';
  ctx.textAlign = 'center';
  const lines = contentHTML.split('\n');
  lines.forEach((line, i) => {
    ctx.fillText(line, 512, 160 + i * 42);
  });

  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true })
  );
  mesh.userData.canvas = canvas;
  mesh.userData.ctx = ctx;
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

function showMainMenu() {
  hideCurrentPanel();
  const panel = createGlassPanel(3.2, 2.4, '3D Panorama', 
    'Cardboard Camera + 360 Photos\n\n' +
    'Browse Files\n\n' +
    'Exit VR');
  panel.position.set(0, 1.6, -2.5);
  scene.add(panel);
  currentPanel = panel;

  // Add interactive buttons
  addButton(panel, 0, -0.3, 'Browse Files', () => fileInput.click());
  addButton(panel, 0, -1.0, 'Exit VR', () => {
    const session = renderer.xr.getSession();
    if (session) session.end();
  });
}

function showConversionPanel(filename) {
  hideCurrentPanel();
  const panel = createGlassPanel(3.2, 2.4, 'Converting to 3D', 
    filename + '\n\n' +
    '████████████████████  0%\n\n' +
    'Loading image...');
  panel.position.set(0, 1.6, -2.5);
  scene.add(panel);
  currentPanel = panel;
}

function updateProgress(pct) {
  if (!currentPanel || !currentPanel.userData.ctx) return;
  const ctx = currentPanel.userData.ctx;
  ctx.fillStyle = 'rgba(10, 12, 24, 0.92)';
  roundRect(ctx, 0, 0, 1024, 768, 40);
  ctx.fill();
  ctx.strokeStyle = 'rgba(79, 140, 255, 0.3)';
  ctx.lineWidth = 4;
  roundRect(ctx, 8, 8, 1008, 752, 36);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Converting to 3D', 512, 80);
  ctx.fillStyle = '#9aa4c2';
  ctx.font = '28px Inter, sans-serif';
  ctx.fillText(currentImageFile?.name || '', 512, 140);
  const barWidth = Math.floor(pct / 100 * 600);
  ctx.fillStyle = '#4f8cff';
  ctx.fillRect(212, 200, barWidth, 20);
  ctx.strokeStyle = '#ffffff';
  ctx.strokeRect(212, 200, 600, 20);
  ctx.fillStyle = '#9aa4c2';
  ctx.fillText(pct + '%', 512, 260);
  currentPanel.material.map.needsUpdate = true;
}

function updateLog(msg) {
  if (!currentPanel || !currentPanel.userData.ctx) return;
  const ctx = currentPanel.userData.ctx;
  ctx.fillStyle = 'rgba(10, 12, 24, 0.92)';
  roundRect(ctx, 0, 0, 1024, 768, 40);
  ctx.fill();
  ctx.strokeStyle = 'rgba(79, 140, 255, 0.3)';
  ctx.lineWidth = 4;
  roundRect(ctx, 8, 8, 1008, 752, 36);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Converting to 3D', 512, 80);
  ctx.fillStyle = '#9aa4c2';
  ctx.font = '28px Inter, sans-serif';
  ctx.fillText(currentImageFile?.name || '', 512, 140);
  const barWidth = Math.floor(75 / 100 * 600);
  ctx.fillStyle = '#4f8cff';
  ctx.fillRect(212, 200, barWidth, 20);
  ctx.strokeStyle = '#ffffff';
  ctx.strokeRect(212, 200, 600, 20);
  ctx.fillStyle = '#9aa4c2';
  ctx.fillText('75%', 512, 260);
  ctx.fillText(msg, 512, 340);
  currentPanel.material.map.needsUpdate = true;
}

function showReadyPanel() {
  hideCurrentPanel();
  const panel = createGlassPanel(3.2, 2.4, 'Ready to View', 
    currentImageFile?.name + '\n\n' +
    '✓ 3D Stereo    ✓ Audio\n\n' +
    'View in VR\n\n' +
    'Convert Another');
  panel.position.set(0, 1.6, -2.5);
  scene.add(panel);
  currentPanel = panel;

  addButton(panel, 0, -0.4, 'View in VR', () => {
    hideCurrentPanel();
    enterViewingMode();
  });
  addButton(panel, 0, -1.1, 'Convert Another', () => {
    hideCurrentPanel();
    showMainMenu();
  });
}

function showErrorPanel(msg) {
  hideCurrentPanel();
  const panel = createGlassPanel(3.2, 2.4, 'Error', msg + '\n\nReload');
  panel.position.set(0, 1.6, -2.5);
  scene.add(panel);
  currentPanel = panel;
  addButton(panel, 0, -0.8, 'Reload', () => location.reload());
}

function hideCurrentPanel() {
  if (currentPanel) {
    scene.remove(currentPanel);
    currentPanel = null;
  }
  interactiveObjects = [];
}

function addButton(panel, x, y, label, onClick) {
  const btn = createTextButton(label, x, y, -0.1);
  btn.userData.onClick = onClick;
  panel.add(btn);
  interactiveObjects.push(btn);
}

function createTextButton(label, x, y, z) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4f8cff';
  roundRect(ctx, 0, 0, 512, 96, 20);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 256, 48);
  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.34), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  mesh.position.set(x, y, z);
  return mesh;
}

// === VIEWING MODE ===
function enterViewingMode() {
  isViewing = true;
  panoMesh.visible = true;
  if (currentAudio) currentAudio.play().catch(() => {});
}

function returnToMenu() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  panoMesh.visible = false;
  isViewing = false;
  showMainMenu();
}

// === INPUT ===
function handleXrInput() {
  if (!renderer.xr.isPresenting) return;
  const session = renderer.xr.getSession();
  const sources = Array.from(session?.inputSources || []);
  const right = sources.find(s => s.handedness === 'right');
  const x = right?.gamepad?.axes?.[2] ?? 0;

  if (!snapTurnLatch && Math.abs(x) > SNAP_TURN_THRESHOLD) {
    const d = x > 0 ? SNAP_TURN_ANGLE : -SNAP_TURN_ANGLE;
    if (panoMesh.visible) panoMesh.rotation.y += d;
    snapTurnLatch = true;
  } else if (snapTurnLatch && Math.abs(x) < 0.25) {
    snapTurnLatch = false;
  }

  // Menu button (left controller button 4 or 5)
  const left = sources.find(s => s.handedness === 'left');
  const menuPressed = left?.gamepad?.buttons?.[4]?.pressed || left?.gamepad?.buttons?.[5]?.pressed;
  if (menuPressed && !menuButtonLatch) {
    if (isViewing) {
      returnToMenu();
    } else {
      const session = renderer.xr.getSession();
      if (session) session.end();
    }
  }
  menuButtonLatch = menuPressed;
}

let menuButtonLatch = false;

function handleController(controller) {
  if (!currentPanel) return;
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  const hits = raycaster.intersectObjects(interactiveObjects, false);
  interactiveObjects.forEach(o => o.scale.set(1, 1, 1));
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
    controllerPointers.forEach(c => c.visible = !!currentPanel);
    renderer.render(scene, camera);
  });
}

// === VR SESSION ===
function setupEnterVrButton() {
  enterVrButton.addEventListener('click', () => {
    startVrSession();
  });

  renderer.xr.addEventListener('sessionstart', () => {
    uiCard.style.display = 'none';
    showMainMenu();
  });

  renderer.xr.addEventListener('sessionend', () => {
    uiCard.style.display = 'flex';
    hideCurrentPanel();
    panoMesh.visible = false;
    isViewing = false;
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
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
  } else {
    enterVrButton.disabled = false;
  }
  return immersiveVrSupported;
}

async function startVrSession() {
  if (!navigator.xr) {
    alert('WebXR not available');
    return;
  }
  try {
    const session = await navigator.xr.requestSession('immersive-vr');
    renderer.xr.setSession(session);
  } catch (error) {
    console.error('Failed to start VR:', error);
    alert('Could not enter VR: ' + (error?.message || 'unknown'));
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}