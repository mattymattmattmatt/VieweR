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
let activeObjectUrl = null;
let vrUiVisible = false;
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

// === UI STATE ===
let conversionUI = null;
let viewButton = null;
let logContainer = null;
let progressFill = null;

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
  setupInputs();
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
  menuButton.userData.onClick = toggleMenu;

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
function setupInputs() {
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const file = files[0];
    if (!isImageFile(file)) {
      alert('Please select a .jpg or .vr.jpg image');
      return;
    }
    await convertAndViewImage(file);
    e.target.value = '';
  });
}

function isImageFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.vr.jpg') || name.endsWith('.vr.jpeg');
}

// === VR SESSION ===
function setupEnterVrButton() {
  enterVrButton.addEventListener('click', async () => {
    if (!immersiveVrSupported) return;
    try {
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['hand-tracking'] });
      renderer.xr.setSession(session);
      uiCard.classList.add('hidden');
    } catch (e) {
      console.error('Failed to start VR:', e);
    }
  });

  renderer.xr.addEventListener('sessionstart', () => {
    uiCard.classList.add('hidden');
    showBrowseButton();
  });

  renderer.xr.addEventListener('sessionend', () => {
    uiCard.classList.remove('hidden');
    hideVrUi();
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
    enterVrButton.textContent = 'VR Not Supported';
  }
  return immersiveVrSupported;
}

// === CONVERSION PIPELINE ===
async function convertAndViewImage(file) {
  showConversionUI();
  addLog('Loading image...');
  updateProgress(10);

  try {
    const { image, source, shouldRevoke } = await loadImageElement(file);
    addLog('Image loaded');
    updateProgress(25);

    // Extract right eye
    addLog('Extracting 3D stereo data...');
    const rightEye = await extractCardboardRightEye(file);
    const hasStereo = !!rightEye;
    updateProgress(50);

    if (hasStereo) addLog('3D data found ✓');
    else addLog('No embedded 3D data');

    // Extract audio
    addLog('Looking for spatial audio...');
    const audioUrl = await extractCardboardAudio(file);
    updateProgress(70);

    if (audioUrl) {
      addLog('Spatial audio found ✓');
      currentAudio = new Audio(audioUrl);
      currentAudio.loop = true;
      currentAudio.volume = 0.9;
    } else {
      addLog('No audio in this photo');
    }

    // Prepare rendering
    const texture = new THREE.Texture(image);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;

    const ratio = image.width / image.height;
    const isEquirect = ratio > 1.85 && ratio < 2.15;

    if (hasStereo) {
      addLog('Creating top/bottom 3D view...');
      const stereoCanvas = stackStereoTopBottom(image, rightEye);
      const stereoTex = new THREE.Texture(stereoCanvas);
      stereoTex.needsUpdate = true;
      stereoTex.colorSpace = THREE.SRGBColorSpace;

      panoMesh.visible = true;
      sphereMesh.visible = false;
      panoMaterial.uniforms.map.value = stereoTex;
      panoMaterial.uniforms.stereoMode.value = -1; // Top/Bottom
      panoMesh.scale.y = 1;

    } else if (isEquirect) {
      addLog('Viewing as 360 photosphere');
      sphereMesh.visible = true;
      panoMesh.visible = false;
      stereoSphereMaterial.uniforms.map.value = texture;
      stereoSphereMaterial.uniforms.stereoMode.value = 0;

    } else {
      addLog('Viewing as panorama');
      panoMesh.visible = true;
      sphereMesh.visible = false;
      panoMaterial.uniforms.map.value = texture;
      panoMaterial.uniforms.stereoMode.value = 0;
      panoMesh.scale.y = 1;
    }

    updateProgress(100);
    addLog('Conversion complete!');

    currentImageFile = file;

    setTimeout(() => {
      hideConversionUI();
      showViewButton();
    }, 600);

    if (currentAudio) {
      try { await currentAudio.play(); } catch {}
    }

  } catch (e) {
    addLog('ERROR: ' + e.message);
    console.error(e);
  }
}

function stackStereoTopBottom(topImg, bottomImg) {
  const c = document.createElement('canvas');
  c.width = topImg.width;
  c.height = topImg.height * 2;
  const ctx = c.getContext('2d');
  ctx.drawImage(topImg, 0, 0, topImg.width, topImg.height);
  ctx.drawImage(bottomImg, 0, topImg.height, bottomImg.width, bottomImg.height);
  return c;
}

// === UI SCREENS ===
function showConversionUI() {
  hideAllUI();

  conversionUI = document.createElement('div');
  conversionUI.style.cssText = 'position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:rgba(5,7,15,0.95);color:#fff;font-family:Inter,sans-serif;';
  conversionUI.innerHTML = `
    <div style="width:420px;text-align:center;">
      <h2 style="margin:0 0 20px;font-size:1.4rem;">Converting to 3D...</h2>
      
      <div style="background:#1a2338;border-radius:9999px;height:8px;margin-bottom:16px;overflow:hidden;">
        <div id="progress-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#4f8cff,#7ba3ff);transition:width 0.3s ease;"></div>
      </div>
      
      <div id="log-container" style="background:#0f1629;border-radius:12px;padding:14px;font-family:monospace;font-size:12.5px;height:160px;overflow-y:auto;text-align:left;color:#9aa4c2;border:1px solid #334155;"></div>
    </div>
  `;
  document.body.appendChild(conversionUI);

  progressFill = document.getElementById('progress-fill');
  logContainer = document.getElementById('log-container');
  conversionLog = [];
}

function updateProgress(percent) {
  if (progressFill) progressFill.style.width = percent + '%';
}

function addLog(msg) {
  if (!logContainer) return;
  const time = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const line = document.createElement('div');
  line.style.marginBottom = '3px';
  line.innerHTML = `<span style="color:#64748b;">[${time}]</span> ${msg}`;
  logContainer.appendChild(line);
  logContainer.scrollTop = logContainer.scrollHeight;
  conversionLog.push(msg);
}

function hideConversionUI() {
  if (conversionUI) {
    conversionUI.remove();
    conversionUI = null;
  }
}

function showViewButton() {
  hideAllUI();

  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;';
  container.innerHTML = `
    <div style="text-align:center;">
      <div style="margin-bottom:24px;">
        <div style="font-size:1.1rem;margin-bottom:6px;">Ready to view</div>
        <div style="color:#9aa4c2;font-size:0.95rem;">${currentImageFile?.name || 'Image'}</div>
      </div>
      
      <button id="view-btn" style="background:linear-gradient(135deg,#4f8cff,#3c7cff);color:white;border:none;padding:16px 48px;border-radius:14px;font-size:1.1rem;font-weight:700;cursor:pointer;box-shadow:0 10px 30px rgba(79,140,255,0.4);">
        View 3D Panorama
      </button>
      
      <div style="margin-top:16px;color:#64748b;font-size:0.85rem;">Tap to enter immersive view</div>
    </div>
  `;
  document.body.appendChild(container);
  viewButton = container;

  document.getElementById('view-btn').onclick = () => {
    container.remove();
    enterViewingMode();
  };
}

function enterViewingMode() {
  isViewingImage = true;
  panoMesh.visible = true;
  sphereMesh.visible = false; // or true depending on mode

  showVrUi();
  backButton.visible = true;
  menuButton.visible = true;

  if (currentAudio) {
    currentAudio.play().catch(() => {});
  }
}

function returnToUpload() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  panoMesh.visible = false;
  sphereMesh.visible = false;
  isViewingImage = false;
  backButton.visible = false;
  menuButton.visible = false;

  // Show upload UI again
  uiCard.classList.remove('hidden');
  showBrowseButton();
}

function toggleMenu() {
  if (!isViewingImage) {
    // In upload screen
    const session = renderer.xr.getSession();
    if (session) session.end();
    return;
  }

  // In viewing mode - show menu options
  const menu = document.createElement('div');
  menu.style.cssText = 'position:fixed;inset:0;z-index:30;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
  menu.innerHTML = `
    <div style="background:#1a2338;border-radius:18px;padding:24px 32px;text-align:center;border:1px solid #334155;">
      <div style="margin-bottom:20px;font-size:1.1rem;font-weight:600;">Menu</div>
      
      <button id="return-btn" style="display:block;width:100%;margin-bottom:10px;padding:14px;border-radius:10px;border:1px solid #4f8cff;background:transparent;color:#4f8cff;font-weight:600;cursor:pointer;">Return to Upload</button>
      <button id="exit-btn" style="display:block;width:100%;padding:14px;border-radius:10px;border:1px solid #ff6b6b;background:transparent;color:#ff6b6b;font-weight:600;cursor:pointer;">Exit VR</button>
    </div>
  `;
  document.body.appendChild(menu);

  document.getElementById('return-btn').onclick = () => {
    menu.remove();
    returnToUpload();
  };
  document.getElementById('exit-btn').onclick = () => {
    const session = renderer.xr.getSession();
    if (session) session.end();
    menu.remove();
  };
}

function showBrowseButton() {
  const btn = document.createElement('button');
  btn.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:20;padding:14px 32px;border-radius:9999px;background:#4f8cff;color:white;border:none;font-weight:700;font-size:1rem;box-shadow:0 8px 25px rgba(79,140,255,0.4);';
  btn.textContent = '📁 Browse Files';
  btn.onclick = () => fileInput.click();
  document.body.appendChild(btn);
  setTimeout(() => btn.remove(), 8000);
}

function hideAllUI() {
  document.querySelectorAll('div[style*="position:fixed"]').forEach(el => el.remove());
}

// === AUDIO EXTRACTION ===
async function extractCardboardAudio(file) {
  try {
    const buf = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await (await fetch(file.url)).arrayBuffer();
    const txt = new TextDecoder('latin1').decode(buf);
    const m = txt.match(/GAudio:Data\s*=\s*["']([A-Za-z0-9+/=_-\s&#10;]+)["']/) || txt.match(/<GAudio:Data>([A-Za-z0-9+/=_-\s&#10;]+)<\/GAudio:Data>/);
    if (!m) return null;
    let b64 = m[1].replace(/&#10;/g,'').replace(/\s/g,'').replace(/-/g,'+').replace(/_/g,'/');
    b64 = b64.padEnd(Math.ceil(b64.length/4)*4, '=');
    const blob = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], {type:'audio/mp4'});
    return URL.createObjectURL(blob);
  } catch { return null; }
}

async function extractCardboardRightEye(file) {
  try {
    const buf = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await (await fetch(file.url)).arrayBuffer();
    const txt = new TextDecoder('latin1').decode(buf);
    const patterns = [
      /GImage:Data\s*=\s*["']([A-Za-z0-9+/=_-\s&#10;]+)["']/,
      /<GImage:Data>([A-Za-z0-9+/=_-\s&#10;]+)<\/GImage:Data>/,
      /xmpGImg:Data\s*=\s*["']([A-Za-z0-9+/=_-\s&#10;]+)["']/,
      /<xmpGImg:Data>([A-Za-z0-9+/=_-\s&#10;]+)<\/xmpGImg:Data>/
    ];
    let m = null;
    for (const p of patterns) { m = txt.match(p); if (m) break; }
    if (!m) return null;
    let b64 = m[1].replace(/&#10;/g,'').replace(/\s/g,'').replace(/-/g,'+').replace(/_/g,'/');
    b64 = b64.padEnd(Math.ceil(b64.length/4)*4, '=');
    const blob = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], {type:'image/jpeg'});
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    return img;
  } catch { return null; }
}

async function loadImageElement(file) {
  const img = new Image();
  const src = file.url || URL.createObjectURL(file);
  img.src = src;
  await img.decode();
  return { image: img, source: src, shouldRevoke: !file.url };
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
  } else if (snapTurnLatch && Math.abs(x) < 0.25) {
    snapTurnLatch = false;
  }
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
    controllerPointers.forEach(c => c.visible = vrUiVisible);
    renderer.render(scene, camera);
  });
}

function showVrUi() { vrUiVisible = true; }
function hideVrUi() { vrUiVisible = false; }

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}