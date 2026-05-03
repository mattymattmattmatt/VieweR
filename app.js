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

// === STATE ===
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
  createEnvironment();

  setupControllers();
  setupHands();
  setupFileInput();
  setupEnterVrButton();
  detectVrSupport();

  window.addEventListener('resize', onWindowResize);
}

// === ENVIRONMENT (Premium Dark VR Space) ===
function createEnvironment() {
  const starsGeometry = new THREE.BufferGeometry();
  const starCount = 800;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount * 3; i += 3) {
    positions[i] = (Math.random() - 0.5) * 200;
    positions[i + 1] = (Math.random() - 0.5) * 200 + 1.6;
    positions[i + 2] = (Math.random() - 0.5) * 200;
  }
  starsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const starsMaterial = new THREE.PointsMaterial({ color: 0x88aaff, size: 0.15, transparent: true, opacity: 0.6 });
  const stars = new THREE.Points(starsGeometry, starsMaterial);
  scene.add(stars);

  const ambient = new THREE.AmbientLight(0x112244, 0.6);
  scene.add(ambient);

  const pointLight = new THREE.PointLight(0x00f0ff, 0.8, 50);
  pointLight.position.set(0, 4, -8);
  scene.add(pointLight);
}

// === PANORAMA CYLINDER (Full 360° Immersion) ===
function createPanoMesh() {
  const geo = new THREE.CylinderGeometry(8, 8, 8, 128, 64, true, -Math.PI/2, Math.PI*2);
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
let controllerPointers = [];

function setupControllers() {
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    controller.addEventListener('connected', e => controller.userData.handedness = e.data?.handedness);
    controller.addEventListener('selectstart', () => controller.userData.selectPressed = true);
    controller.addEventListener('selectend', () => controller.userData.selectPressed = false);
    const pointer = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-3)]), new THREE.LineBasicMaterial({ color: 0x00f0ff }));
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
  updateLog('Image loaded');
  updateProgress(35);

  updateLog('Extracting 3D...');
  let rightEye = null;
  try { rightEye = await extractRightEye(file); } catch {}
  const has3D = !!rightEye;
  updateProgress(55);

  updateLog('Checking audio...');
  let audioUrl = null;
  try { audioUrl = await extractAudio(file); } catch {}
  if (audioUrl) {
    currentAudio = new Audio(audioUrl);
    currentAudio.loop = true;
    currentAudio.volume = 0.85;
  }
  updateProgress(75);

  const tex = new THREE.Texture(img);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;

  if (has3D) {
    updateLog('Creating 3D view...');
    const stereoCanvas = createTopBottomStereo(img, rightEye);
    const stereoTex = new THREE.Texture(stereoCanvas);
    stereoTex.needsUpdate = true;
    stereoTex.colorSpace = THREE.SRGBColorSpace;
    panoMaterial.uniforms.map.value = stereoTex;
    panoMaterial.uniforms.stereoMode.value = -1;
  } else {
    updateLog('360 panorama');
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
  }, 500);

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

// === PREMIUM UI (Creative Oculus-style) ===
function createPremiumPanel(title, subtitle) {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, 800);
  grad.addColorStop(0, 'rgba(8, 10, 20, 0.95)');
  grad.addColorStop(1, 'rgba(4, 6, 14, 0.98)');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, 1200, 800, 50);
  ctx.fill();

  ctx.strokeStyle = 'rgba(0, 240, 255, 0.5)';
  ctx.lineWidth = 6;
  roundRect(ctx, 12, 12, 1176, 776, 44);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 2;
  roundRect(ctx, 24, 24, 1152, 752, 38);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 56px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, 600, 100);

  if (subtitle) {
    ctx.fillStyle = '#00f0ff';
    ctx.font = '400 28px Inter, system-ui, sans-serif';
    ctx.fillText(subtitle, 600, 150);
  }

  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(3.8, 2.5),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide })
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
  const panel = createPremiumPanel('3D PANORAMA', 'Cardboard Camera • 360 Photos');
  panel.position.set(0, 1.8, -3.2);
  scene.add(panel);
  currentPanel = panel;

  const browseBtn = createNeonButton('BROWSE FILES', 0, -0.2, () => fileInput.click());
  panel.add(browseBtn);
  interactiveObjects.push(browseBtn);

  const exitBtn = createNeonButton('EXIT VR', 0, -1.1, () => {
    const s = renderer.xr.getSession();
    if (s) s.end();
  }, true);
  panel.add(exitBtn);
  interactiveObjects.push(exitBtn);
}

function createNeonButton(text, x, y, onClick, secondary = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 90;
  const ctx = canvas.getContext('2d');

  if (secondary) {
    ctx.strokeStyle = 'rgba(255, 100, 100, 0.6)';
    ctx.lineWidth = 3;
    roundRect(ctx, 4, 4, 592, 82, 18);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 80, 80, 0.15)';
    roundRect(ctx, 4, 4, 592, 82, 18);
    ctx.fill();
  } else {
    ctx.fillStyle = '#00f0ff';
    roundRect(ctx, 0, 0, 600, 90, 20);
    ctx.fill();
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 20;
  }

  ctx.fillStyle = secondary ? '#ff6666' : '#000000';
  ctx.font = '700 32px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 300, 45);

  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 0.33),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true })
  );
  mesh.position.set(x, y, -0.1);
  mesh.userData.onClick = onClick;
  return mesh;
}

function showConversionPanel(filename) {
  hideCurrentPanel();
  const panel = createPremiumPanel('CONVERTING', filename);
  panel.position.set(0, 1.8, -3.2);
  scene.add(panel);
  currentPanel = panel;
}

function updateProgress(pct) {
  if (!currentPanel || !currentPanel.userData.ctx) return;
  const ctx = currentPanel.userData.ctx;
  ctx.fillStyle = 'rgba(8, 10, 20, 0.95)';
  roundRect(ctx, 0, 0, 1200, 800, 50);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.5)';
  ctx.lineWidth = 6;
  roundRect(ctx, 12, 12, 1176, 776, 44);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 56px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('CONVERTING', 600, 100);
  ctx.fillStyle = '#00f0ff';
  ctx.font = '400 28px Inter, system-ui, sans-serif';
  ctx.fillText(currentImageFile?.name || '', 600, 150);
  const barWidth = Math.floor(pct / 100 * 700);
  ctx.fillStyle = '#00f0ff';
  ctx.fillRect(250, 280, barWidth, 18);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  roundRect(ctx, 250, 280, 700, 18, 4);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 36px Inter, system-ui, sans-serif';
  ctx.fillText(pct + '%', 600, 340);
  currentPanel.material.map.needsUpdate = true;
}

function updateLog(msg) {
  if (!currentPanel || !currentPanel.userData.ctx) return;
  const ctx = currentPanel.userData.ctx;
  ctx.fillStyle = 'rgba(8, 10, 20, 0.95)';
  roundRect(ctx, 0, 0, 1200, 800, 50);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.5)';
  ctx.lineWidth = 6;
  roundRect(ctx, 12, 12, 1176, 776, 44);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 56px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('CONVERTING', 600, 100);
  ctx.fillStyle = '#00f0ff';
  ctx.font = '400 28px Inter, system-ui, sans-serif';
  ctx.fillText(currentImageFile?.name || '', 600, 150);
  const barWidth = Math.floor(75 / 100 * 700);
  ctx.fillStyle = '#00f0ff';
  ctx.fillRect(250, 280, barWidth, 18);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  roundRect(ctx, 250, 280, 700, 18, 4);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 36px Inter, system-ui, sans-serif';
  ctx.fillText('75%', 600, 340);
  ctx.fillStyle = '#88aaff';
  ctx.font = '400 24px monospace';
  ctx.fillText(msg, 600, 420);
  currentPanel.material.map.needsUpdate = true;
}

function showReadyPanel() {
  hideCurrentPanel();
  const panel = createPremiumPanel('READY', currentImageFile?.name);
  panel.position.set(0, 1.8, -3.2);
  scene.add(panel);
  currentPanel = panel;

  const viewBtn = createNeonButton('ENTER PANORAMA', 0, -0.3, () => {
    hideCurrentPanel();
    enterViewingMode();
  });
  panel.add(viewBtn);
  interactiveObjects.push(viewBtn);

  const againBtn = createNeonButton('CONVERT ANOTHER', 0, -1.2, () => {
    hideCurrentPanel();
    showMainMenu();
  }, true);
  panel.add(againBtn);
  interactiveObjects.push(againBtn);
}

function showErrorPanel(msg) {
  hideCurrentPanel();
  const panel = createPremiumPanel('ERROR', msg);
  panel.position.set(0, 1.8, -3.2);
  scene.add(panel);
  currentPanel = panel;
  const reloadBtn = createNeonButton('RELOAD', 0, -0.8, () => location.reload());
  panel.add(reloadBtn);
  interactiveObjects.push(reloadBtn);
}

function hideCurrentPanel() {
  if (currentPanel) {
    scene.remove(currentPanel);
    currentPanel = null;
  }
  interactiveObjects = [];
}

// === VIEWING ===
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

  const left = sources.find(s => s.handedness === 'left');
  const menuPressed = left?.gamepad?.buttons?.[4]?.pressed || left?.gamepad?.buttons?.[5]?.pressed;
  if (menuPressed && !menuButtonLatch) {
    if (isViewing) returnToMenu();
    else {
      const s = renderer.xr.getSession();
      if (s) s.end();
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
  sel.scale.set(1.1, 1.1, 1.1);
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
  enterVrButton.addEventListener('click', () => startVrSession());

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
  } catch { immersiveVrSupported = false; }
  enterVrButton.disabled = !immersiveVrSupported;
  if (!immersiveVrSupported) enterVrButton.textContent = 'VR Not Supported Here';
  return immersiveVrSupported;
}

async function startVrSession() {
  if (!navigator.xr) return;
  try {
    const session = await navigator.xr.requestSession('immersive-vr');
    renderer.xr.setSession(session);
  } catch (e) {
    alert('Could not enter VR: ' + (e?.message || 'unknown'));
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}