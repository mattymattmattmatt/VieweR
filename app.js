import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

let scene;
let camera;
let renderer;
let panoMesh;
let sphereMesh;
let panoMaterial;
let backButton;
let menuButton;
let controllerPointers = [];
let stereoSphereMaterial;
let panoStereoMode = 0;

let controllers = [];
let hands = [];
let interactiveObjects = [];
let loadedFiles = [];
let galleryVisible = true;
let activeObjectUrl = null;
let vrUiVisible = false;
let galleryBuildId = 0;
let immersiveVrSupported = null;
let menuButtonLatch = false;
let snapTurnLatch = false;
let imagePointerVisible = true;
let vrFrontMenu;
let vrPreviewPanel;
const SNAP_TURN_ANGLE = THREE.MathUtils.degToRad(30);
const SNAP_TURN_THRESHOLD = 0.65;

const demoImages = [
  { name: 'Test 3D360PANO.vr.jpg', url: 'Demo Images/Test 3D360PANO.vr.jpg' },
  { name: 'Test 360SPHERE.jpg', url: 'Demo Images/Test 360SPHERE.jpg' }
];

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

const fileInput = document.getElementById('fileInput');
const loadingText = document.getElementById('loading');
const fileCount = document.getElementById('fileCount');
const enterVrButton = document.getElementById('enterVrButton');
const demoPicturesButton = document.getElementById('demoPicturesButton');
const clearFilesButton = document.getElementById('clearFilesButton');
const uiCard = document.getElementById('ui');

uiCard.classList.add('pre-vr');

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
  createUiButtonsInVr();
  createVrFrontUi();

  setupControllers();
  setupHands();
  setupInputs();
  setupDemoPicturesButton();
  setupClearButton();
  setupEnterVrButton();
  detectVrSupport();

  window.addEventListener('resize', onWindowResize);
}

function setupEnterVrButton() {
  enterVrButton.addEventListener('click', () => {
    if (!renderer.xr.isPresenting && loadedFiles.length) {
      createGallery(loadedFiles);
    }
    startVrSession();
  });

  renderer.xr.addEventListener('sessionstart', () => {
    uiCard.classList.remove('pre-vr');
    enterVrButton.classList.add('hidden');
    vrUiVisible = false;
    hideVrUi();
    showGallery();
    showVrFrontMenu();
  });

  renderer.xr.addEventListener('sessionend', () => {
    uiCard.classList.add('pre-vr');
    enterVrButton.classList.remove('hidden');
    hideVrUi();
  });

}

async function detectVrSupport() {
  if (!navigator.xr) {
    immersiveVrSupported = false;
    enterVrButton.disabled = true;
    hideVrFrontMenu();
    enterVrButton.textContent = 'WebXR Not Available';
    fileCount.textContent = 'Open this app in Quest Browser over HTTPS or localhost.';
    return false;
  }

  try {
    immersiveVrSupported = await navigator.xr.isSessionSupported('immersive-vr');
  } catch {
    immersiveVrSupported = false;
  }

  if (!immersiveVrSupported) {
    enterVrButton.disabled = true;
    hideVrFrontMenu();
    enterVrButton.textContent = 'VR Not Supported Here';
    fileCount.textContent = 'Immersive VR is unavailable in this browser/context.';
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
    fileCount.textContent = `Could not start VR: ${error?.message || 'unknown error'}`;
  }
}

function setupInputs() {
  const handleInputChange = async (event) => {
    loadingText.style.display = 'block';
    const allFiles = Array.from(event.target.files || []);

    if (!allFiles.length) {
      loadingText.style.display = 'none';
      return;
    }

    const filtered = allFiles.filter(isImageFile);
    const incoming = filtered.length ? filtered : allFiles;
    mergeFiles(incoming);

    updateFileCount();
    if (renderer.xr.isPresenting) {
      createGallery(loadedFiles);
      showVrFrontMenu();
    }
    loadingText.style.display = 'none';

    event.target.value = '';
  };

  fileInput.addEventListener('change', handleInputChange);

  // Some XR browsers support directory picking even if this property check fails.
}

function mergeFiles(files) {
  const byKey = new Map(loadedFiles.map((f) => [fileKey(f), f]));
  files.forEach((f) => byKey.set(fileKey(f), f));
  loadedFiles = Array.from(byKey.values());
}

function fileKey(file) {
  if (file.url) return `url:${file.url}`;
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function setupDemoPicturesButton() {
  demoPicturesButton.addEventListener('click', () => {
    loadedFiles = [...demoImages];
    updateFileCount(true);
    if (renderer.xr.isPresenting) {
      createGallery(loadedFiles);
      showVrFrontMenu();
    }
  });
}

function setupClearButton() {
  clearFilesButton.addEventListener('click', () => {
    loadedFiles = [];
    clearGallery();
    showGallery();
    showVrFrontMenu();
    fileCount.textContent = '0 image files loaded';
    enterVrButton.disabled = true;
    hideVrFrontMenu();
  });
}

function updateFileCount(isDemo = false) {
  const count = loadedFiles.length;
  fileCount.textContent = `${count} ${isDemo ? 'demo image' : 'image file'}${count === 1 ? '' : 's'} loaded`;
  enterVrButton.disabled = immersiveVrSupported === false;
}

function isImageFile(file) {
  if (file.type && file.type.startsWith('image/')) return true;
  const lowerName = file.name.toLowerCase();
  return ['.vr.jpg', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic', '.heif'].some((ext) => lowerName.endsWith(ext));
}


function isVrPanoFile(file) {
  const name = file.name?.toLowerCase?.().trim() || '';
  const url = file.url?.toLowerCase?.().trim() || '';
  return name.endsWith('.vr.jpg') || name.endsWith('.vr.jpeg')
    || url.endsWith('.vr.jpg') || url.endsWith('.vr.jpeg');
}

function createPanoMesh() {
  const geometry = new THREE.CylinderGeometry(5, 5, 3, 128, 64, true, -Math.PI / 2, Math.PI * 2);
  panoMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { map: { value: null }, eyeIndex: { value: 0 }, stereoMode: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform sampler2D map; uniform float eyeIndex; uniform float stereoMode;
    void main(){
      vec2 uv = vUv;
      if (stereoMode > 0.5) {
        uv.x = (uv.x * 0.5) + (eyeIndex > 0.5 ? 0.5 : 0.0);
      } else if (stereoMode < -0.5) {
        uv.y = (uv.y * 0.5) + (eyeIndex > 0.5 ? 0.0 : 0.5);
      }
      gl_FragColor = texture2D(map, uv);
    }`
  });
  panoMesh = new THREE.Mesh(geometry, panoMaterial);
  panoMesh.scale.x = -1;
  panoMesh.position.y = 1.6;
  panoMesh.onBeforeRender = (renderCtx, sceneCtx, activeCamera) => {
    if (renderer.xr.isPresenting && activeCamera?.viewport) {
      panoMaterial.uniforms.eyeIndex.value = activeCamera.viewport.x === 0 ? 0 : 1;
      return;
    }
    panoMaterial.uniforms.eyeIndex.value = 0;
  };
  panoMesh.visible = false;
  scene.add(panoMesh);
}

function createSphereMesh() {
  const geometry = new THREE.SphereGeometry(50, 64, 64);
  geometry.scale(-1, 1, 1);
  stereoSphereMaterial = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      eyeIndex: { value: 0 },
      stereoMode: { value: 0 }
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform sampler2D map; uniform float eyeIndex; uniform float stereoMode;
    void main(){
      vec2 uv = vUv;
      if (stereoMode > 0.5) {
        uv.x = (uv.x * 0.5) + (eyeIndex > 0.5 ? 0.5 : 0.0);
      } else if (stereoMode < -0.5) {
        uv.y = (uv.y * 0.5) + (eyeIndex > 0.5 ? 0.0 : 0.5);
      }
      gl_FragColor = texture2D(map, uv);
    }`
  });
  sphereMesh = new THREE.Mesh(geometry, stereoSphereMaterial);
  sphereMesh.onBeforeRender = (renderCtx, sceneCtx, activeCamera) => {
    if (renderer.xr.isPresenting && activeCamera?.viewport) {
      stereoSphereMaterial.uniforms.eyeIndex.value = activeCamera.viewport.x === 0 ? 0 : 1;
      return;
    }
    stereoSphereMaterial.uniforms.eyeIndex.value = 0;
  };
  sphereMesh.visible = false;
  scene.add(sphereMesh);
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

function createUiButtonsInVr() {
  backButton = createTextButton('Back', -0.5, 1.15, -1);
  backButton.visible = false;
  backButton.userData.onClick = showGallery;

  menuButton = createTextButton('Menu', 0, 1.15, -1);
  menuButton.visible = false;
  menuButton.userData.onClick = exitToUploadScreen;

  [backButton, menuButton].forEach((b) => {
    scene.add(b);
    interactiveObjects.push(b);
  });
}

function hideVrUi() {
  [backButton, menuButton].forEach((b) => { b.visible = false; });
  controllerPointers.forEach((pointer) => { pointer.visible = false; });
}
function showVrUi() {
  [backButton, menuButton].forEach((b) => { b.visible = true; });
  controllerPointers.forEach((pointer) => { pointer.visible = true; });
  if (renderer.xr.isPresenting) showVrFrontMenu();
}

function toggleGalleryVisibility() {
  galleryVisible = !galleryVisible;
  interactiveObjects.forEach((obj) => {
    if (obj.userData.isThumb) obj.visible = galleryVisible;
  });
}

function showGallery() {
  panoMesh.visible = false;
  sphereMesh.visible = false;
  galleryVisible = true;
  imagePointerVisible = true;
  interactiveObjects.forEach((obj) => {
    if (obj.userData.isThumb) obj.visible = true;
  });
  [backButton, menuButton].forEach((b) => { b.visible = false; });
  controllerPointers.forEach((pointer) => { pointer.visible = true; });
  if (renderer.xr.isPresenting) showVrFrontMenu();
}

function exitToUploadScreen() {
  const session = renderer.xr.getSession();
  if (session) {
    session.end();
    return;
  }
  uiCard.classList.remove('hidden');
}

function setupControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    controller.addEventListener('connected', (event) => {
      controller.userData.handedness = event.data?.handedness;
    });
    controller.addEventListener('selectstart', () => {
      controller.userData.selectPressed = true;
    });
    controller.addEventListener('selectend', () => { controller.userData.selectPressed = false; });
    const pointer = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -3)]),
      new THREE.LineBasicMaterial({ color: 0x8fb0ff })
    );
    controller.add(pointer);
    pointer.visible = vrUiVisible;
    controllerPointers.push(pointer);
    controller.userData.index = i;
    controller.userData.menuPressed = false;
    scene.add(controller);
    controllers.push(controller);
  }
}

function setupHands() {
  const factory = new XRHandModelFactory();
  for (let i = 0; i < 2; i += 1) {
    const hand = renderer.xr.getHand(i);
    hand.add(factory.createHandModel(hand, 'mesh'));
    scene.add(hand);
    hands.push(hand);
  }
}



function openFilePickerSafely() {
  if (renderer.xr.isPresenting) {
    // Some headset browsers crash when opening the system file picker in-session.
    fileCount.textContent = 'File browser is unstable in VR on some headsets. Load files before VR, then reopen session.';
    return;
  }
  fileInput.click();
}

function createVrFrontUi() {
  vrFrontMenu = new THREE.Group();
  const selectButton = createTextButton('Select Files', 0, 1.55, -1.3);
  selectButton.scale.set(1.2, 1.2, 1.2);
  selectButton.userData.onClick = openFilePickerSafely;
  const helper = makeLabelSprite('Select files safely from the panel\n(or load first, then enter VR)', 0.9, 0.26);
  helper.position.set(0, 1.35, -1.3);
  vrFrontMenu.add(selectButton);
  vrFrontMenu.add(helper);
  scene.add(vrFrontMenu);
  interactiveObjects.push(selectButton);

  vrPreviewPanel = new THREE.Group();
  vrPreviewPanel.visible = false;
  scene.add(vrPreviewPanel);
}

function makeLabelSprite(text, width = 1, height = 0.2) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 320;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15,18,28,0.75)';
  roundRect(ctx, 10, 10, canvas.width - 20, canvas.height - 20, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(160,190,255,0.7)';
  ctx.lineWidth = 6;
  roundRect(ctx, 10, 10, canvas.width - 20, canvas.height - 20, 28);
  ctx.stroke();
  ctx.fillStyle = '#e8efff';
  ctx.font = '48px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = text.split('\n');
  lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2, canvas.height / 2 - (lines.length - 1) * 28 + i * 56));
  const texture = new THREE.CanvasTexture(canvas);
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
}

function showVrFrontMenu() {
  if (vrFrontMenu) vrFrontMenu.visible = true;
}
function hideVrFrontMenu() {
  if (vrFrontMenu) vrFrontMenu.visible = false;
  if (vrPreviewPanel) vrPreviewPanel.visible = false;
}

function updateVrPreview(texture, isStereo, isSphere) {
  if (!vrPreviewPanel) return;
  while (vrPreviewPanel.children.length) {
    const c = vrPreviewPanel.children.pop();
    c.geometry?.dispose?.();
    c.material?.map?.dispose?.();
    c.material?.dispose?.();
  }
  const size = isSphere ? [0.5, 0.5] : [0.58, 0.32];
  const thumb = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), new THREE.MeshBasicMaterial({ map: texture }));
  thumb.position.set(-0.35, 1.0, -1.15);
  vrPreviewPanel.add(thumb);
  if (isStereo) {
    const wide = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.32), new THREE.MeshBasicMaterial({ map: texture }));
    wide.position.set(0.35, 1.0, -1.15);
    vrPreviewPanel.add(wide);
  } else {
    const card = makeLabelSprite('Photo Sphere', 0.6, 0.16);
    card.position.set(0.32, 1.0, -1.15);
    vrPreviewPanel.add(card);
  }
  vrPreviewPanel.visible = true;
}

function createGallery(files) {
  clearGallery();
  const buildId = ++galleryBuildId;
  const radius = 2.5;
  files.forEach(async (file, index) => {
    const n = Math.max(files.length, 1);
    const phi = Math.acos(1 - (2 * (index + 0.5) / n));
    const theta = Math.PI * (1 + Math.sqrt(5)) * (index + 0.5);
    const texture = await createThumbnail(file);
    if (buildId !== galleryBuildId) {
      texture.dispose();
      return;
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), new THREE.MeshBasicMaterial({ map: texture }));
    mesh.position.set(
      Math.cos(theta) * Math.sin(phi) * radius,
      1.5 + (Math.cos(phi) * radius * 0.55),
      Math.sin(theta) * Math.sin(phi) * radius
    );
    mesh.lookAt(0, 1.5, 0);
    mesh.userData.onClick = () => loadImage(file);
    mesh.userData.isThumb = true;
    scene.add(mesh);
    interactiveObjects.push(mesh);
  });
  if (vrUiVisible) showVrUi();
}

function clearGallery() {
  galleryBuildId += 1;
  interactiveObjects.forEach((obj) => {
    if (obj !== backButton && obj !== menuButton) {
      scene.remove(obj);
      obj.material?.map?.dispose?.();
      obj.material?.dispose?.();
      obj.geometry?.dispose?.();
    }
  });
  interactiveObjects = [backButton, menuButton];
}

async function loadImageElement(file) {
  const image = new Image();
  const source = file.url || URL.createObjectURL(file);
  image.src = source;
  await image.decode();
  return { image, source, shouldRevoke: !file.url };
}

async function createThumbnail(file) {
  const { image, source, shouldRevoke } = await loadImageElement(file);
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const texture = new THREE.Texture(canvas); texture.needsUpdate = true;
  if (shouldRevoke) URL.revokeObjectURL(source);
  return texture;
}

async function loadImage(file) {
  let source;
  let shouldRevoke = false;

  try {
    const loaded = await loadImageElement(file);
    const { image } = loaded;
    source = loaded.source;
    shouldRevoke = loaded.shouldRevoke;

    const rightEyeImage = await extractCardboardRightEye(file);
    const isVrPano = isVrPanoFile(file);
    const hasStereoPair = !!rightEyeImage;
    const texture = new THREE.Texture(image); texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    const ratio = image.width / image.height;
    const isEquirect = ratio > 1.85 && ratio < 2.15;

    if (isVrPano) {
      panoMesh.visible = true;
      sphereMesh.visible = false;

      if (hasStereoPair) {
        const panoStereoTexture = new THREE.Texture(stackStereoSideBySide(image, rightEyeImage));
        panoStereoTexture.needsUpdate = true;
        panoStereoTexture.colorSpace = THREE.SRGBColorSpace;
        panoMaterial.uniforms.map.value = panoStereoTexture;
        panoMaterial.uniforms.stereoMode.value = 1;
      } else {
        panoMaterial.uniforms.map.value = texture;
        panoMaterial.uniforms.stereoMode.value = 0;
      }

      panoMesh.scale.y = 1;
    } else if (hasStereoPair) {
      sphereMesh.visible = true;
      panoMesh.visible = false;
      const imageTexture = new THREE.Texture(stackStereoSideBySide(image, rightEyeImage));
      imageTexture.needsUpdate = true;
      imageTexture.colorSpace = THREE.SRGBColorSpace;
      stereoSphereMaterial.uniforms.map.value = imageTexture;
      stereoSphereMaterial.uniforms.stereoMode.value = 1;
    } else if (isEquirect) {
      sphereMesh.visible = true;
      panoMesh.visible = false;
      stereoSphereMaterial.uniforms.map.value = texture;
      stereoSphereMaterial.uniforms.stereoMode.value = 0;
    } else {
      panoMesh.visible = true;
      sphereMesh.visible = false;
      panoMaterial.uniforms.map.value = texture;
      panoMaterial.uniforms.stereoMode.value = 0;
      panoMesh.scale.y = 1;
    }

    updateVrPreview(texture, hasStereoPair || isVrPano, isEquirect && !hasStereoPair);

    galleryVisible = false;
    hideVrFrontMenu();
    imagePointerVisible = false;
    controllerPointers.forEach((pointer) => { pointer.visible = false; });
    interactiveObjects.forEach((obj) => {
      if (obj.userData.isThumb) obj.visible = false;
    });
  } catch (error) {
    console.error('Failed to load selected image:', error);
    fileCount.textContent = `Failed to open image: ${file?.name || 'unknown file'}`;
    showGallery();
    showVrFrontMenu();
  } finally {
    if (shouldRevoke && source) URL.revokeObjectURL(source);
  }
}

async function extractCardboardRightEye(file) {
  try {
    const arrayBuffer = typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await (await fetch(file.url)).arrayBuffer();
    const text = new TextDecoder('latin1').decode(arrayBuffer);
    const match = text.match(/GImage:Data\s*=\s*["']([A-Za-z0-9+/=_-\s&#10;]+)["']/)
      || text.match(/<GImage:Data>([A-Za-z0-9+/=_-\s&#10;]+)<\/GImage:Data>/);
    if (!match) return null;
    const base64 = match[1].replace(/&#10;/g, '').replace(/\s/g, '');
        const normalizedBase64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    const paddedBase64 = normalizedBase64.padEnd(Math.ceil(normalizedBase64.length / 4) * 4, '=');
    const blob = new Blob([Uint8Array.from(atob(paddedBase64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' });
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = URL.createObjectURL(blob);
    const right = new Image();
    right.src = activeObjectUrl;
    await right.decode();
    return right;
  } catch {
    return null;
  }
}

function stackStereoSideBySide(leftImage, rightImage) {
  const canvas = document.createElement('canvas');
  canvas.width = leftImage.width * 2;
  canvas.height = leftImage.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(leftImage, 0, 0, leftImage.width, leftImage.height);
  ctx.drawImage(rightImage, leftImage.width, 0, leftImage.width, leftImage.height);
  return canvas;
}

function animate() {
  renderer.setAnimationLoop(() => {
    handleXrInput();
    controllers.forEach(handleController);
    renderer.render(scene, camera);
  });
}

function handleXrInput() {
  if (!renderer.xr.isPresenting) return;
  const session = renderer.xr.getSession();
  const inputSources = Array.from(session?.inputSources || []);
  const leftSource = inputSources.find((source) => source?.handedness === 'left');
  const rightSource = inputSources.find((source) => source?.handedness === 'right');

  const leftButtons = leftSource?.gamepad?.buttons || [];
  const rightButtons = rightSource?.gamepad?.buttons || [];
  const menuPressed = Boolean(
    leftButtons[4]?.pressed || leftButtons[5]?.pressed || leftButtons[3]?.pressed
    || rightButtons[4]?.pressed || rightButtons[5]?.pressed || rightButtons[3]?.pressed
  );
  if (menuPressed && !menuButtonLatch) {
    if (galleryVisible) {
      toggleGalleryVisibility();
      controllerPointers.forEach((pointer) => { pointer.visible = true; });
    } else {
      vrUiVisible = !vrUiVisible;
      if (vrUiVisible) {
        showVrUi();
      } else {
        hideVrUi();
      }
    }
  }
  menuButtonLatch = menuPressed;

  const rightStickX = rightSource?.gamepad?.axes?.[2] ?? rightSource?.gamepad?.axes?.[0] ?? 0;
  if (!snapTurnLatch && Math.abs(rightStickX) > SNAP_TURN_THRESHOLD) {
    const delta = rightStickX > 0 ? SNAP_TURN_ANGLE : -SNAP_TURN_ANGLE;
    if (sphereMesh.visible) sphereMesh.rotation.y += delta;
    if (panoMesh.visible) panoMesh.rotation.y += delta;
    snapTurnLatch = true;
  } else if (snapTurnLatch && Math.abs(rightStickX) < 0.25) {
    snapTurnLatch = false;
  }
}

function handleController(controller) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  const hits = raycaster.intersectObjects(interactiveObjects, false);
  interactiveObjects.forEach((obj) => obj.scale.set(1, 1, 1));
  if (!hits.length) return;
  const selected = hits[0].object;
  selected.scale.set(1.07, 1.07, 1.07);
  if (controller.userData.selectPressed) {
    controller.userData.selectPressed = false;
    selected.userData.onClick?.();
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
